import type { SkillMeta, SourceRef } from '@shared/types'
import type { ChatToolDef } from '../engine-client'
import type { ToolsClient } from '../tools-client'
import type { McpManager } from '../mcp-manager'
import type { SkillsService } from '../skills'

/**
 * Per-generation [n] source numbering: web/rag tool results register sources
 * here, the orchestrator emits them as the message's sources part, and the
 * system prompt tells the model to cite the same numbers.
 */
export class SourceTracker {
  private readonly byUrl = new Map<string, SourceRef>()

  add(url: string, title: string | null): SourceRef {
    const existing = this.byUrl.get(url)
    if (existing) return existing
    const source: SourceRef = { id: this.byUrl.size + 1, title, url }
    this.byUrl.set(url, source)
    return source
  }

  all(): SourceRef[] {
    return [...this.byUrl.values()]
  }
}

export interface BuiltinToolOptions {
  webEnabled: boolean
  hasCollection: boolean
  skills: SkillMeta[]
}

export function builtinToolDefs(opts: BuiltinToolOptions): ChatToolDef[] {
  const defs: ChatToolDef[] = []
  if (opts.webEnabled) {
    defs.push(
      {
        type: 'function',
        function: {
          name: 'web_search',
          description: 'Search the web. Returns numbered results with title, URL and snippet.',
          parameters: {
            type: 'object',
            properties: {
              query: { type: 'string', description: 'Search query' },
              max_results: { type: 'integer', description: 'Number of results (default 5)' }
            },
            required: ['query']
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'web_visit',
          description: 'Fetch a web page and return its readable content as Markdown.',
          parameters: {
            type: 'object',
            properties: { url: { type: 'string', description: 'Absolute URL to fetch' } },
            required: ['url']
          }
        }
      }
    )
  }
  if (opts.hasCollection) {
    defs.push({
      type: 'function',
      function: {
        name: 'rag_search',
        description:
          'Search the documents attached to this conversation. Returns numbered excerpts.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'What to look for' },
            k: { type: 'integer', description: 'Number of excerpts (default 6)' }
          },
          required: ['query']
        }
      }
    })
  }
  if (opts.skills.length > 0) {
    defs.push({
      type: 'function',
      function: {
        name: 'use_skill',
        description: 'Read the full instructions of a skill listed in the system prompt.',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', enum: opts.skills.map((s) => s.name) }
          },
          required: ['name']
        }
      }
    })
  }
  return defs
}

export interface ToolExecutionContext {
  tools: ToolsClient
  skills: SkillsService
  mcp: McpManager
  sources: SourceTracker
  collectionId: string | null
  embeddingsUrl: string
  embeddingModel: string
  lancedbDir: string
  searxngUrl: string | null
  /** Generation abort signal — rejects in-flight sidecar fetches on Stop. */
  signal: AbortSignal
}

export interface ToolExecution {
  result: string
  sourceIds?: number[]
}

/**
 * Execute one tool call with parsed args. Built-in failures throw (the
 * orchestrator turns them into error tool_results); MCP failures already
 * come back as error strings from McpManager.
 */
export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolExecutionContext
): Promise<ToolExecution> {
  switch (name) {
    case 'web_search': {
      const { results, backend } = await ctx.tools.search(
        {
          query: String(args.query ?? ''),
          maxResults: typeof args.max_results === 'number' ? args.max_results : 5,
          backend: 'auto',
          searxngUrl: ctx.searxngUrl ?? undefined
        },
        ctx.signal
      )
      if (results.length === 0) return { result: `No results (backend: ${backend}).` }
      const sourceIds: number[] = []
      const lines = results.map((r) => {
        const source = ctx.sources.add(r.url, r.title || null)
        sourceIds.push(source.id)
        return `[${source.id}] ${r.title}\n${r.url}\n${r.snippet}`
      })
      return { result: lines.join('\n\n'), sourceIds }
    }
    case 'web_visit': {
      const url = String(args.url ?? '')
      const page = await ctx.tools.visit(url, undefined, ctx.signal)
      const source = ctx.sources.add(page.url || url, page.title)
      return {
        result: `[${source.id}] ${page.title ?? page.url}\n\n${page.markdown}`,
        sourceIds: [source.id]
      }
    }
    case 'rag_search': {
      if (!ctx.collectionId) throw new Error('no collection attached to this conversation')
      const hits = await ctx.tools.ragQuery(
        {
          collectionId: ctx.collectionId,
          query: String(args.query ?? ''),
          k: typeof args.k === 'number' ? args.k : 6,
          embeddingsUrl: ctx.embeddingsUrl,
          embeddingModel: ctx.embeddingModel,
          lancedbDir: ctx.lancedbDir
        },
        ctx.signal
      )
      if (hits.length === 0) return { result: 'No matching excerpts in the attached documents.' }
      const sourceIds: number[] = []
      const lines = hits.map((hit) => {
        // Library docs have no URL — a stable pseudo-URL keeps SourceRef.url honest.
        const source = ctx.sources.add(`library://${hit.doc_id}`, hit.title)
        sourceIds.push(source.id)
        return `[${source.id}] ${hit.title ?? 'document'} (chunk ${hit.chunk_index})\n${hit.text}`
      })
      return { result: lines.join('\n\n'), sourceIds: [...new Set(sourceIds)] }
    }
    case 'use_skill': {
      const skillName = String(args.name ?? '')
      const body = ctx.skills.useSkill(skillName)
      if (body === null) throw new Error(`unknown skill: ${skillName}`)
      return { result: body }
    }
    default: {
      if (ctx.mcp.isMcpTool(name)) {
        return { result: await ctx.mcp.callTool(name, args) }
      }
      throw new Error(`unknown tool: ${name}`)
    }
  }
}
