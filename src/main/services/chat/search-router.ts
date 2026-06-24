import { z } from 'zod'
import type { EngineClient } from '../engine-client'
import { structured } from '../structured'
import { scopedLogger } from '../logger'
import { heuristicRoute, type ChatRoute } from './search-router-core'

/**
 * Decides what the harness does with a web-enabled user turn BEFORE the
 * model-owned loop runs: the pure heuristic pre-router (search-router-core)
 * catches the obvious cases, and one fused router+rewrite micro-call handles
 * the rest — needs_search and standalone queries in a single structured
 * generation on the already-loaded chat model.
 *
 * Every failure path resolves to 'direct', which is exactly today's behavior —
 * the router can only ever add a pipeline, never remove the loop.
 */

// Re-export the pure router pieces so existing importers keep a single source.
export { heuristicRoute, type ChatRoute }
export type { HeuristicDecision } from './search-router-core'

const log = scopedLogger('chat-router')

const MAX_QUERIES = 5
/** Router prompt budgets — references resolve from very little context. */
const QUESTION_CLIP = 2000
const HISTORY_TURN_CLIP = 500

const clip = (text: string, limit: number): string =>
  text.length > limit ? `${text.slice(0, limit)}…` : text

// --- fused router + query rewrite (one structured micro-call) -------------------

const routeOut = z.object({
  // Reasoning FIRST so the constrained decode "thinks" before committing — the
  // documented ~+4pp on schema-constrained accuracy (enable_thinking is off here).
  reasoning: z.string(),
  needs_search: z.boolean(),
  queries: z.array(z.string())
})

// Local models default to their training-data era — without the date they
// write queries for the wrong year.
const todayLine = (): string =>
  `Today's date is ${new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}.`

export interface RouteOptions {
  engine: EngineClient
  /** The chat model — already loaded, so this micro-call costs no swap. */
  model: string
  /** The user's latest typed text. */
  question: string
  /** Recent turns as plain text, oldest first, for reference resolution. */
  history: Array<{ role: 'user' | 'assistant'; text: string }>
  /** Heuristic verdict: this is a follow-up to a searched turn. */
  forceSearch: boolean
  conversationId: string
  signal: AbortSignal
}

export async function routeWithModel(opts: RouteOptions): Promise<ChatRoute> {
  const historyBlock =
    opts.history.length > 0
      ? `Recent conversation:\n${opts.history
          .map((h) => `${h.role === 'user' ? 'User' : 'Assistant'}: ${clip(h.text, HISTORY_TURN_CLIP)}`)
          .join('\n')}\n\n`
      : ''
  try {
    const out = await structured({
      engine: opts.engine,
      model: opts.model,
      name: 'search_route',
      schema: routeOut,
      messages: [
        {
          role: 'system',
          content:
            'You route messages for a chat assistant that can search the web. ' +
            'Decide whether answering the latest user message would benefit from a web search, ' +
            `and if so write the queries. Reply with a single JSON object matching the requested schema. ${todayLine()}`
        },
        {
          role: 'user',
          content:
            historyBlock +
            `Latest user message: """${clip(opts.question, QUESTION_CLIP)}"""\n\n` +
            'Search when the answer depends on current, factual, niche, or local information — ' +
            'news, weather, prices, schedules, product or software versions, sports, people, ' +
            'places, anything that may have changed recently. Do not search for greetings, ' +
            'creative writing, rewriting or summarizing text the user already provided, code ' +
            'questions about pasted code, pure math, or things the conversation above already ' +
            'answers. If the user asks for photos, pictures, or images, set needs_search to ' +
            'false — a separate image tool handles those. When unsure, search.\n\n' +
            `Write 1-${MAX_QUERIES} standalone web search queries (short keyword phrases). ` +
            'Each query must make sense on its own — resolve references like "it", "there", ' +
            '"what about X" from the conversation. Include the current year in time-sensitive ' +
            'queries. Leave queries empty only when no search is needed.' +
            (opts.forceSearch
              ? '\n\nThis message reads like a follow-up to the previous searched answer — ' +
                'strongly prefer needs_search true, and write standalone queries that resolve ' +
                'its references.'
              : '')
        }
      ],
      // +128 over the old 256 to fit the leading reasoning field.
      maxTokens: 384,
      meta: { surface: 'chat', step: 'route', conversationId: opts.conversationId },
      signal: opts.signal
    })
    const queries = [...new Set(out.queries.map((q) => q.trim()).filter(Boolean))].slice(0, MAX_QUERIES)
    if ((out.needs_search || opts.forceSearch) && queries.length > 0) {
      return { kind: 'search', queries }
    }
    return { kind: 'direct' }
  } catch (err) {
    if (opts.signal.aborted) throw err
    // Both structured attempts failed — today's behavior is the safe answer.
    log.warn(`route micro-call failed, going direct: ${err instanceof Error ? err.message : err}`)
    return { kind: 'direct' }
  }
}
