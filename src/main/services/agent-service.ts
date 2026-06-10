import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { OrionEvent } from '@shared/ipc'
import type { AgentSessionMeta, Tier } from '@shared/types'
import { TIER_ORDER } from '@shared/model-tiers'
import type { OrionDatabase } from './db'
import { engineModelId } from './engine-client'
import type { ModelService } from './model-service'
import type { OpencodePool } from './opencode-pool'
import { dataDir } from './paths'
import { scopedLogger } from './logger'

export interface AgentServiceDeps {
  db: OrionDatabase
  pool: OpencodePool
  modelService: ModelService
  broadcast: (event: OrionEvent) => void
}

interface AgentSessionRow {
  id: string
  opencode_session_id: string | null
  tab: string
  directory: string
  title: string | null
  created_at: number
  last_used_at: number | null
}

const rowToMeta = (row: AgentSessionRow): AgentSessionMeta => ({
  id: row.id,
  directory: row.directory,
  title: row.title,
  createdAt: row.created_at,
  lastUsedAt: row.last_used_at
})

const MEMORY_FILE_RE = /^[\w.-]+\.md$/

const MEMORY_TEMPLATE = `# Agent memory

This directory is your persistent memory. Every \`*.md\` file here is loaded
into the start of each of your sessions automatically.

When you are asked to remember something — or learn a durable fact, preference,
or convention worth keeping — create or update a markdown file here with a short
descriptive name (e.g. \`project-conventions.md\`). Keep files small and factual,
and remove entries that are no longer true.
`

/** Control-call timeout; prompt_async is admission-only so this never spans a generation. */
const REQUEST_TIMEOUT_MS = 30_000

/**
 * Agent sessions: our rows in agent_sessions own identity (id = UUID); the
 * opencode session behind each row is addressed via opencode_session_id.
 * opencode persists sessions on disk keyed by directory, so they survive
 * server restarts and pool evictions (verified live on 1.16.2).
 */
export class AgentService {
  private readonly log = scopedLogger('agent')
  private readonly memoryDir = join(dataDir(), 'memory')

  constructor(private readonly deps: AgentServiceDeps) {
    deps.pool.onEvent((directory, event) => this.onPoolEvent(directory, event))
  }

  init(): void {
    mkdirSync(this.memoryDir, { recursive: true })
    const agentsMd = join(this.memoryDir, 'AGENTS.md')
    if (!existsSync(agentsMd)) writeFileSync(agentsMd, MEMORY_TEMPLATE)
  }

  // --- sessions ---------------------------------------------------------------

  sessions(): AgentSessionMeta[] {
    const rows = this.deps.db
      .prepare(
        "SELECT * FROM agent_sessions WHERE tab = 'agent' ORDER BY COALESCE(last_used_at, created_at) DESC"
      )
      .all() as unknown as AgentSessionRow[]
    return rows.map(rowToMeta)
  }

  async create(directory: string, tier?: Tier): Promise<AgentSessionMeta> {
    const modelId = this.resolveModel(tier)
    const { baseUrl } = await this.deps.pool.ensureServer(directory)
    this.deps.pool.touch(directory)
    const opencodeId = await this.createOpencodeSession(baseUrl, modelId)
    const row: AgentSessionRow = {
      id: crypto.randomUUID(),
      opencode_session_id: opencodeId,
      tab: 'agent',
      directory,
      title: null,
      created_at: Date.now(),
      last_used_at: null
    }
    this.deps.db
      .prepare(
        `INSERT INTO agent_sessions (id, opencode_session_id, tab, directory, title, created_at, last_used_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(row.id, row.opencode_session_id, row.tab, row.directory, row.title, row.created_at, row.last_used_at)
    return rowToMeta(row)
  }

  async get(sessionId: string): Promise<{ session: AgentSessionMeta; messages: unknown[] }> {
    const row = this.row(sessionId)
    const { baseUrl } = await this.deps.pool.ensureServer(row.directory)
    this.deps.pool.touch(row.directory)
    const res = await this.request(baseUrl, 'GET', `/session/${row.opencode_session_id}/message`)
    if (res.status === 404) {
      // opencode storage for this session is gone; the next prompt's 404 path recreates it.
      return { session: rowToMeta(row), messages: [] }
    }
    if (!res.ok) throw new Error(`opencode message list failed: ${res.status}`)
    return { session: rowToMeta(row), messages: (await res.json()) as unknown[] }
  }

  /**
   * Fire-and-forget: POST /session/{id}/prompt_async returns 204 on admission
   * and all progress arrives over the SSE bridge. Errors surface as an
   * orion.promptFailed agent.event (the renderer's handler owns the toast)
   * instead of failing the IPC call.
   */
  async prompt(sessionId: string, text: string, tier?: Tier): Promise<void> {
    const row = this.row(sessionId)
    const modelId = this.resolveModel(tier)
    const { baseUrl } = await this.deps.pool.ensureServer(row.directory)
    this.deps.pool.touch(row.directory)
    this.deps.db
      .prepare('UPDATE agent_sessions SET last_used_at = ? WHERE id = ?')
      .run(Date.now(), row.id)
    void this.firePrompt(row, baseUrl, modelId, text).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err)
      this.log.warn(`prompt failed for session ${row.id}: ${message}`)
      this.deps.broadcast({
        type: 'agent.event',
        sessionId: row.id,
        event: { type: 'orion.promptFailed', error: message }
      })
    })
  }

  async abort(sessionId: string): Promise<void> {
    const row = this.row(sessionId)
    const server = this.deps.pool.runningServer(row.directory)
    if (!server) return // no live server — nothing in flight to abort
    this.deps.pool.touch(row.directory)
    const res = await this.request(server.baseUrl, 'POST', `/session/${row.opencode_session_id}/abort`)
    if (!res.ok) throw new Error(`opencode abort failed: ${res.status}`)
  }

  async permissionReply(
    sessionId: string,
    permissionId: string,
    reply: 'once' | 'always' | 'reject'
  ): Promise<void> {
    const row = this.row(sessionId)
    const server = this.deps.pool.runningServer(row.directory)
    if (!server) return // no live server — no pending ask left to answer
    this.deps.pool.touch(row.directory)
    const res = await this.request(
      server.baseUrl,
      'POST',
      `/session/${row.opencode_session_id}/permissions/${permissionId}`,
      { response: reply }
    )
    if (res.status === 404) {
      this.log.warn(`permission ${permissionId} no longer pending — dropping stale ask`)
      return
    }
    if (!res.ok) throw new Error(`opencode permission reply failed: ${res.status}`)
  }

  async delete(sessionId: string): Promise<void> {
    const row = this.row(sessionId)
    const server = this.deps.pool.runningServer(row.directory)
    if (server) {
      try {
        this.deps.pool.touch(row.directory)
        await this.request(server.baseUrl, 'DELETE', `/session/${row.opencode_session_id}`)
      } catch (err) {
        this.log.warn(`opencode delete skipped: ${err instanceof Error ? err.message : err}`)
      }
    }
    this.deps.db.prepare('DELETE FROM agent_sessions WHERE id = ?').run(sessionId)
  }

  // --- memory -------------------------------------------------------------------

  memoryList(): Array<{ name: string; updatedAt: number }> {
    let names: string[]
    try {
      names = readdirSync(this.memoryDir).filter((n) => MEMORY_FILE_RE.test(n))
    } catch {
      return []
    }
    return names
      .map((name) => ({ name, updatedAt: Math.round(statSync(join(this.memoryDir, name)).mtimeMs) }))
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  memoryRead(name: string): string {
    return readFileSync(join(this.memoryDir, this.memoryFileName(name)), 'utf8')
  }

  /** Empty content deletes the file (per the IPC contract). */
  memoryWrite(name: string, content: string): void {
    const path = join(this.memoryDir, this.memoryFileName(name))
    if (content === '') {
      try {
        unlinkSync(path)
      } catch {
        // already gone
      }
      return
    }
    mkdirSync(this.memoryDir, { recursive: true })
    writeFileSync(path, content)
  }

  /** Rejects rather than aliases: the regex excludes separators, so this stays escape-free. */
  private memoryFileName(name: string): string {
    if (!MEMORY_FILE_RE.test(name)) throw new Error(`Invalid memory file name: ${name}`)
    return name
  }

  // --- internals -------------------------------------------------------------------

  /** Requested tier first, then nearest installed below, then above (mirrors chat). */
  private resolveModel(tier?: Tier): string {
    const overview = this.deps.modelService.overview()
    const requested = tier ?? overview.defaults.agent
    const active = new Map(overview.tiers.map((t) => [t.tier, t.active]))
    const start = TIER_ORDER.indexOf(requested)
    const order = [
      requested,
      ...TIER_ORDER.slice(0, start).reverse(),
      ...TIER_ORDER.slice(start + 1)
    ]
    for (const candidate of order) {
      const modelId = active.get(candidate)
      // opencode forwards this verbatim as the OpenAI model param — the
      // engine knows models by their flattened id, not the HF repo id.
      if (modelId) return engineModelId(modelId)
    }
    throw new Error('No chat models installed — download one in the Models tab first.')
  }

  private async createOpencodeSession(baseUrl: string, modelId: string): Promise<string> {
    const res = await this.request(baseUrl, 'POST', '/session', {
      model: { providerID: 'orion', id: modelId }
    })
    if (!res.ok) throw new Error(`opencode session create failed: ${res.status}`)
    const session = (await res.json()) as { id: string }
    return session.id
  }

  private async firePrompt(
    row: AgentSessionRow,
    baseUrl: string,
    modelId: string,
    text: string
  ): Promise<void> {
    const body = {
      model: { providerID: 'orion', modelID: modelId },
      parts: [{ type: 'text', text }]
    }
    const path = (): string => `/session/${row.opencode_session_id}/prompt_async`
    let res = await this.request(baseUrl, 'POST', path(), body)
    if (res.status === 404) {
      // Sessions survive server restarts (opencode persists them on disk), so a
      // 404 means the storage is gone — recreate transparently and retry once.
      const opencodeId = await this.createOpencodeSession(baseUrl, modelId)
      row.opencode_session_id = opencodeId
      this.deps.db
        .prepare('UPDATE agent_sessions SET opencode_session_id = ? WHERE id = ?')
        .run(opencodeId, row.id)
      res = await this.request(baseUrl, 'POST', path(), body)
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      throw new Error(`opencode prompt failed: ${res.status}${detail ? ` ${detail.slice(0, 200)}` : ''}`)
    }
  }

  private request(baseUrl: string, method: string, path: string, body?: unknown): Promise<Response> {
    return fetch(baseUrl + path, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    })
  }

  private row(sessionId: string): AgentSessionRow {
    const row = this.deps.db
      .prepare('SELECT * FROM agent_sessions WHERE id = ?')
      .get(sessionId) as unknown as AgentSessionRow | undefined
    if (!row) throw new Error(`No such agent session: ${sessionId}`)
    return row
  }

  // --- SSE bridge -------------------------------------------------------------------

  private onPoolEvent(directory: string, event: unknown): void {
    // Live SSE traffic counts as use, so a mid-turn server never idles out.
    this.deps.pool.touch(directory)
    const opencodeId = extractSessionId(event)
    if (!opencodeId) return
    const row = this.deps.db
      .prepare('SELECT * FROM agent_sessions WHERE opencode_session_id = ?')
      .get(opencodeId) as unknown as AgentSessionRow | undefined
    if (!row) return

    const type = (event as { type?: unknown }).type
    const props = (event as { properties?: Record<string, unknown> }).properties

    if (type === 'session.updated') {
      const info = props?.info as { title?: unknown } | undefined
      const title = typeof info?.title === 'string' ? info.title : null
      if (title && title !== row.title) {
        this.deps.db.prepare('UPDATE agent_sessions SET title = ? WHERE id = ?').run(title, row.id)
      }
    }

    this.deps.broadcast({ type: 'agent.event', sessionId: row.id, event })
    // Live 1.16.2 emits 'permission.asked' with properties = the permission
    // object ({id: 'per_…', sessionID, permission, patterns, metadata, …}).
    // The id guard excludes 'permission.replied' (whose properties carry no
    // id), which would otherwise enqueue a ghost ask after every reply.
    if (typeof type === 'string' && type.includes('permission') && typeof props?.id === 'string') {
      this.deps.broadcast({ type: 'agent.permissionRequest', sessionId: row.id, request: props })
    }
  }
}

/**
 * Every 1.16.2 event observed live carries properties.sessionID directly; the
 * .part / .info fallbacks cover the shapes the SDK types still describe.
 */
function extractSessionId(event: unknown): string | null {
  if (typeof event !== 'object' || event === null) return null
  const props = (event as { properties?: unknown }).properties
  if (typeof props !== 'object' || props === null) return null
  const p = props as Record<string, unknown>
  if (typeof p.sessionID === 'string') return p.sessionID
  const part = p.part as { sessionID?: unknown } | undefined
  if (typeof part?.sessionID === 'string') return part.sessionID
  const info = p.info as { sessionID?: unknown; id?: unknown } | undefined
  if (typeof info?.sessionID === 'string') return info.sessionID
  if (typeof info?.id === 'string' && info.id.startsWith('ses')) return info.id
  return null
}
