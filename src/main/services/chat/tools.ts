import { z } from 'zod'
import type { SkillMeta, SourceRef } from '@shared/types'
import type { ChatToolDef } from '../engine-client'
import type { ToolsClient } from '../tools-client'
import type { McpManager } from '../mcp-manager'
import type { SkillsService } from '../skills'
import { cleanUrl } from './search-router-core'

/**
 * Per-generation [n] source numbering: web/rag tool results register sources
 * here, the orchestrator emits them as the message's sources part, and the
 * system prompt tells the model to cite the same numbers.
 */
export class SourceTracker {
  private readonly byUrl = new Map<string, SourceRef>()

  add(url: string, title: string | null, snippet?: string | null): SourceRef {
    // Cap generously: a visited page's condensed body (~1500 chars) is the text
    // the grounding verifier scores citations against, so it must REPLACE the
    // short 300-char search snippet when it arrives for the same URL. The hover
    // card clamps the display visually, so the longer text only helps grounding.
    const text = snippet ? snippet.trim().slice(0, 1500) : null
    const existing = this.byUrl.get(url)
    if (existing) {
      if (text && text.length > (existing.snippet?.length ?? 0)) existing.snippet = text
      return existing
    }
    const source: SourceRef = { id: this.byUrl.size + 1, title, url, snippet: text }
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
          description:
            'Fetch a web page and return its readable content as Markdown. ' +
            'Only visit URLs taken verbatim from web_search results or the user — never guess or construct URLs.',
          parameters: {
            type: 'object',
            properties: {
              url: { type: 'string', description: 'Absolute URL, copied exactly from a search result' }
            },
            required: ['url']
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'image_search',
          description:
            'Search the web for images. Returns results with a direct image URL and source page. ' +
            'To show an image to the user, embed it in your reply as Markdown: ![title](image_url) — it renders inline.',
          parameters: {
            type: 'object',
            properties: {
              query: { type: 'string', description: 'What to find images of' },
              max_results: { type: 'integer', description: 'Number of results (default 6)' }
            },
            required: ['query']
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
 * The model produced arguments that don't fit the tool — a model fault, not
 * an execution fault. The orchestrator folds these into the same two-strike
 * rule as unparseable tool-call JSON.
 */
export class InvalidToolArgsError extends Error {}

/**
 * Tolerant count arg: coerces "5"→5, rounds, clamps to [1,max]. Anything
 * that isn't a number or a numeric string (null, booleans, "", arrays —
 * Number() maps several of those to 0, which would clamp to 1, not the
 * default) falls back to the default.
 */
const countArg = (def: number, max: number) =>
  z.preprocess(
    (v) => {
      if (typeof v === 'number') return v
      if (typeof v === 'string' && v.trim() !== '') return v
      return undefined
    },
    z.coerce
      .number()
      .catch(def)
      .transform((n) => Math.min(Math.max(Math.round(n), 1), max))
      .default(def)
  )

/** Required text arg; numbers/booleans stringify (the old String() behavior). */
const textArg = z.preprocess(
  (v) => (typeof v === 'number' || typeof v === 'boolean' ? String(v) : v),
  z.string().trim().min(1)
)

/**
 * Small models routinely emit almost-right args ("5" for 5, a stray key, a
 * missing query, a markdown-wrapped URL). Coerce and clamp what's
 * recoverable; reject with a corrective message what isn't. MCP tools
 * validate on their own side.
 */
const builtinArgSchemas = {
  web_search: z.object({
    query: textArg,
    max_results: countArg(5, 20)
  }),
  web_visit: z.object({
    // cleanUrl tolerates markdown links, angle brackets and trailing prose
    // punctuation — only truly URL-less args reach the refine and fail.
    url: z.preprocess(
      (v) => (typeof v === 'string' ? (cleanUrl(v) ?? v.trim()) : v),
      z.string().refine((u) => /^https?:\/\//i.test(u), 'must be an absolute http(s) URL')
    )
  }),
  image_search: z.object({
    query: textArg,
    max_results: countArg(6, 12)
  }),
  rag_search: z.object({
    query: textArg,
    k: countArg(6, 20)
  }),
  use_skill: z.object({
    name: textArg
  })
}

function validateArgs(name: string, args: Record<string, unknown>): Record<string, unknown> {
  const schema = (builtinArgSchemas as Record<string, z.ZodType<Record<string, unknown>> | undefined>)[
    name
  ]
  if (!schema) return args
  const check = schema.safeParse(args)
  if (!check.success) {
    const issues = check.error.issues
      .map((i) => `${i.path.join('.') || '(args)'}: ${i.message}`)
      .join('; ')
    throw new InvalidToolArgsError(
      `invalid arguments for ${name} — ${issues}. Retry the call with corrected arguments.`
    )
  }
  return check.data
}

/**
 * Execute one tool call with parsed args. Built-in failures throw (the
 * orchestrator turns them into error tool_results); MCP failures already
 * come back as error strings from McpManager.
 */
export async function executeTool(
  name: string,
  rawArgs: Record<string, unknown>,
  ctx: ToolExecutionContext
): Promise<ToolExecution> {
  const args = validateArgs(name, rawArgs)
  switch (name) {
    case 'web_search': {
      const { results, backend } = await ctx.tools.search(
        {
          query: args.query as string,
          maxResults: args.max_results as number,
          backend: 'auto',
          searxngUrl: ctx.searxngUrl ?? undefined
        },
        ctx.signal
      )
      if (results.length === 0) return { result: `No results (backend: ${backend}).` }
      const sourceIds: number[] = []
      const lines = results.map((r) => {
        const source = ctx.sources.add(r.url, r.title || null, r.snippet)
        sourceIds.push(source.id)
        return `[${source.id}] ${r.title}\n${r.url}\n${r.snippet}`
      })
      return { result: lines.join('\n\n'), sourceIds }
    }
    case 'web_visit': {
      const url = args.url as string
      const page = await ctx.tools.visit(url, undefined, ctx.signal)
      const source = ctx.sources.add(page.url || url, page.title, page.markdown)
      return {
        result: `[${source.id}] ${page.title ?? page.url}\n\n${page.markdown}`,
        sourceIds: [source.id]
      }
    }
    case 'image_search': {
      const { results } = await ctx.tools.searchImages(
        {
          query: args.query as string,
          maxResults: args.max_results as number
        },
        ctx.signal
      )
      if (results.length === 0) return { result: 'No image results.' }
      const lines = results.map(
        (r, i) =>
          `${i + 1}. ${r.title || 'untitled'}\nimage_url: ${r.image_url}\nsource: ${r.source_url}`
      )
      return {
        result:
          `${lines.join('\n\n')}\n\n` +
          'To show one inline, embed it as Markdown: ![title](image_url).'
      }
    }
    case 'rag_search': {
      if (!ctx.collectionId) throw new Error('no collection attached to this conversation')
      const hits = await ctx.tools.ragQuery(
        {
          collectionId: ctx.collectionId,
          query: args.query as string,
          k: args.k as number,
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
        const source = ctx.sources.add(`library://${hit.doc_id}`, hit.title, hit.text)
        sourceIds.push(source.id)
        return `[${source.id}] ${hit.title ?? 'document'} (chunk ${hit.chunk_index})\n${hit.text}`
      })
      return { result: lines.join('\n\n'), sourceIds: [...new Set(sourceIds)] }
    }
    case 'use_skill': {
      const skillName = args.name as string
      // The def's enum only covers chat-enabled skills, but enums are
      // advisory — enforce the same scope here so a hallucinated name can't
      // read a coding pack chat was never given.
      const meta = ctx.skills.list().find((s) => s.name === skillName)
      if (!meta?.chatEnabled) throw new Error(`unknown skill: ${skillName}`)
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
