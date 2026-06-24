import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import {
  StdioClientTransport,
  getDefaultEnvironment
} from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { McpScope, McpServer } from '@shared/types'
import type { ChatToolDef } from './engine-client'
import type { CrispinDatabase } from './db'
import { scopedLogger } from './logger'

const CALL_TIMEOUT_MS = 30_000

interface McpServerRow {
  id: string
  name: string
  transport: 'stdio' | 'http'
  command: string | null
  args: string | null
  url: string | null
  env: string | null
  enabled: number
  scope: McpScope
}

const rowToServer = (row: McpServerRow): McpServer => ({
  id: row.id,
  name: row.name,
  transport: row.transport,
  command: row.command,
  args: safeJson<string[]>(row.args, []),
  url: row.url,
  env: safeJson<Record<string, string>>(row.env, {}),
  enabled: row.enabled === 1,
  scope: row.scope
})

function safeJson<T>(json: string | null, fallback: T): T {
  if (!json) return fallback
  try {
    return JSON.parse(json) as T
  } catch {
    return fallback
  }
}

/** OpenAI function names allow [A-Za-z0-9_-]; MCP server/tool names may not. */
const sanitize = (name: string): string => name.replace(/[^A-Za-z0-9_-]/g, '_')

interface ToolRoute {
  serverId: string
  toolName: string
}

/**
 * Owns the mcp_servers table and one SDK Client per enabled server. Clients
 * connect lazily on first chat use; tool failures become tool_result error
 * text, never exceptions into the tool loop.
 */
export class McpManager {
  private readonly clients = new Map<string, Promise<Client>>()
  /** namespaced OpenAI name → which server/tool it came from. */
  private readonly routes = new Map<string, ToolRoute>()
  private readonly log = scopedLogger('mcp')

  constructor(private readonly db: CrispinDatabase) {}

  // --- table CRUD (mcp_servers is the source of truth) -------------------------

  list(): McpServer[] {
    const rows = this.db
      .prepare('SELECT * FROM mcp_servers ORDER BY name')
      .all() as unknown as McpServerRow[]
    return rows.map(rowToServer)
  }

  upsert(server: McpServer): McpServer {
    if (server.transport === 'stdio' && !server.command?.trim()) {
      throw new Error('stdio servers need a command')
    }
    if (server.transport === 'http' && !server.url?.trim()) {
      throw new Error('http servers need a url')
    }
    this.db
      .prepare(
        `INSERT INTO mcp_servers (id, name, transport, command, args, url, env, enabled, scope)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, transport = excluded.transport,
           command = excluded.command, args = excluded.args, url = excluded.url,
           env = excluded.env, enabled = excluded.enabled, scope = excluded.scope`
      )
      .run(
        server.id,
        server.name,
        server.transport,
        server.command,
        JSON.stringify(server.args),
        server.url,
        JSON.stringify(server.env),
        server.enabled ? 1 : 0,
        server.scope
      )
    void this.disconnect(server.id) // config changed — next use reconnects fresh
    return server
  }

  remove(id: string): void {
    this.db.prepare('DELETE FROM mcp_servers WHERE id = ?').run(id)
    void this.disconnect(id)
  }

  // --- connections ---------------------------------------------------------------

  private async connect(server: McpServer): Promise<Client> {
    const client = new Client({ name: 'crispin', version: '0.1.0' })
    const transport =
      server.transport === 'stdio'
        ? new StdioClientTransport({
            command: server.command!,
            args: server.args,
            env: { ...getDefaultEnvironment(), ...server.env }
          })
        : new StreamableHTTPClientTransport(new URL(server.url!))
    await client.connect(transport)
    return client
  }

  /** Lazy, deduped: concurrent callers share the same in-flight connect. */
  private clientFor(server: McpServer): Promise<Client> {
    let pending = this.clients.get(server.id)
    if (!pending) {
      pending = this.connect(server)
      pending.catch(() => this.clients.delete(server.id)) // failed connects retry next use
      this.clients.set(server.id, pending)
    }
    return pending
  }

  private async disconnect(id: string): Promise<void> {
    const pending = this.clients.get(id)
    this.clients.delete(id)
    if (!pending) return
    try {
      await (await pending).close()
    } catch {
      // never connected or already gone
    }
  }

  // --- chat integration -------------------------------------------------------------

  /**
   * OpenAI function defs for every enabled server in scope. A server that
   * fails to connect or list contributes nothing — the chat must still work.
   */
  async toolDefsFor(scope: 'chat' | 'agent'): Promise<ChatToolDef[]> {
    const servers = this.list().filter(
      (s) => s.enabled && (s.scope === scope || s.scope === 'both')
    )
    const defs: ChatToolDef[] = []
    for (const server of servers) {
      try {
        const client = await this.clientFor(server)
        const { tools } = await client.listTools()
        for (const tool of tools) {
          const name = `mcp__${sanitize(server.name)}__${sanitize(tool.name)}`
          this.routes.set(name, { serverId: server.id, toolName: tool.name })
          defs.push({
            type: 'function',
            function: {
              name,
              description: tool.description,
              // MCP inputSchema is already JSON schema — pass through untouched.
              parameters: tool.inputSchema as Record<string, unknown>
            }
          })
        }
      } catch (err) {
        this.log.warn(
          `server ${server.name} unavailable: ${err instanceof Error ? err.message : err}`
        )
      }
    }
    return defs
  }

  isMcpTool(name: string): boolean {
    return name.startsWith('mcp__')
  }

  /** Errors come back as the result string — the tool loop must not throw. */
  async callTool(
    namespacedName: string,
    args: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<string> {
    const route = this.routes.get(namespacedName)
    if (!route) return `Error: unknown MCP tool ${namespacedName}`
    const server = this.list().find((s) => s.id === route.serverId)
    if (!server || !server.enabled) return `Error: MCP server for ${namespacedName} is disabled`
    try {
      const client = await this.clientFor(server)
      // Thread the generation's abort signal so Stop interrupts an in-flight MCP
      // call instead of blocking on the await until the 30s internal timeout.
      const result = await client.callTool(
        { name: route.toolName, arguments: args },
        undefined,
        { timeout: CALL_TIMEOUT_MS, signal }
      )
      if (result.isError) return `Error: ${stringifyContent(result.content)}`
      return stringifyContent(result.content)
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`
    }
  }

  /** mcp.test: fresh connect + listTools + close, independent of the cache. */
  async test(id: string): Promise<{ ok: boolean; tools?: string[]; error?: string }> {
    const server = this.list().find((s) => s.id === id)
    if (!server) return { ok: false, error: `No such server: ${id}` }
    let client: Client | null = null
    try {
      client = await this.connect(server)
      const { tools } = await client.listTools()
      return { ok: true, tools: tools.map((t) => t.name) }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    } finally {
      await client?.close().catch(() => {})
    }
  }

  async dispose(): Promise<void> {
    await Promise.all([...this.clients.keys()].map((id) => this.disconnect(id)))
  }
}

function stringifyContent(content: unknown): string {
  if (!Array.isArray(content)) return JSON.stringify(content)
  const items = content as Array<{ type?: string; text?: string }>
  if (items.every((c) => c.type === 'text')) {
    return items.map((c) => c.text ?? '').join('\n')
  }
  return JSON.stringify(content)
}
