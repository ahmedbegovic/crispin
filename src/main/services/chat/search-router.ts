import { z } from 'zod'
import type { EngineClient } from '../engine-client'
import { structured } from '../structured'
import { scopedLogger } from '../logger'

/**
 * Decides what the harness does with a web-enabled user turn BEFORE the
 * model-owned loop runs: a cheap pure heuristic catches the obvious cases,
 * and one fused router+rewrite micro-call (the Vane/Perplexica classifier
 * shape) handles the rest — needs_search and standalone queries in a single
 * structured generation on the already-loaded chat model.
 *
 * Every failure path resolves to 'direct', which is exactly today's
 * behavior — the router can only ever add a pipeline, never remove the loop.
 */

export type ChatRoute =
  | { kind: 'direct' }
  | { kind: 'search'; queries: string[] }
  | { kind: 'visit'; urls: string[] }

const log = scopedLogger('chat-router')

const MAX_QUERIES = 3
const MAX_VISIT_URLS = 3
/** Router prompt budgets — references resolve from very little context. */
const QUESTION_CLIP = 2000
const HISTORY_TURN_CLIP = 500

const clip = (text: string, limit: number): string =>
  text.length > limit ? `${text.slice(0, limit)}…` : text

// --- heuristic pre-router (pure, unit-testable) --------------------------------

const URL_RE = /https?:\/\/[^\s<>"']+/gi

/**
 * Extract a fetchable URL from user/model text: tolerates markdown link
 * syntax, angle brackets, and trailing prose punctuation; closing parens are
 * only stripped while unbalanced (Wikipedia-style "(disambiguation)" paths
 * survive). Null when nothing URL-shaped is present.
 */
export function cleanUrl(raw: string): string | null {
  const match = /https?:\/\/[^\s<>"']+/i.exec(raw)
  if (!match) return null
  let url = match[0]
  for (;;) {
    const before = url
    url = url.replace(/[.,;:!?…]+$/u, '')
    while (
      url.endsWith(')') &&
      (url.match(/\(/g)?.length ?? 0) < (url.match(/\)/g)?.length ?? 0)
    ) {
      url = url.slice(0, -1)
    }
    while (url.endsWith(']') || url.endsWith('}')) url = url.slice(0, -1)
    if (url === before) break
  }
  return url.length > 'https://'.length ? url : null
}

/** Short acknowledgements that never benefit from the pipeline. */
const PLEASANTRY_RE =
  /^(hi|hey|hello|yo|sup|thanks|thank you|thx|ty|ok|okay|cool|nice|great|good|lol|haha|bye|goodbye|good ?night|good ?morning|gm|gn|sure|yes|no|yep|nope|np)[.!?\s]*$/i

/**
 * Photo/picture asks stay model-owned: image_search only exists in the
 * loop, and a tools-off synthesis round would directly contradict the
 * system prompt's "never claim you cannot provide images" instruction.
 */
const IMAGE_INTENT_RE = /\b(photos?|pictures?|pics?|images?|wallpapers?|screenshots?)\b/i

/** A follow-up this short is anaphoric — its raw text is a useless query. */
const FOLLOW_UP_MAX_WORDS = 12

export type HeuristicDecision =
  | { kind: 'visit'; urls: string[] }
  | { kind: 'direct'; reason: 'code' | 'pleasantry' | 'image' }
  | { kind: 'model'; forceSearch: boolean }

export function heuristicRoute(text: string, priorAssistantUsedWeb: boolean): HeuristicDecision {
  const trimmed = text.trim()
  // Pasted code first: a code block routinely CONTAINS URLs, and a
  // working session must never be hijacked into a visit-only synthesis.
  if (trimmed.includes('```')) return { kind: 'direct', reason: 'code' }
  // Pasted URLs short-circuit the rest: the user said exactly what to read.
  const urls = [
    ...new Set(
      [...trimmed.matchAll(URL_RE)]
        .map((m) => cleanUrl(m[0]))
        .filter((u): u is string => u !== null)
    )
  ]
  if (urls.length > 0) return { kind: 'visit', urls: urls.slice(0, MAX_VISIT_URLS) }
  const words = trimmed.split(/\s+/).filter(Boolean)
  if (words.length <= 3 && PLEASANTRY_RE.test(trimmed)) {
    return { kind: 'direct', reason: 'pleasantry' }
  }
  if (IMAGE_INTENT_RE.test(trimmed)) return { kind: 'direct', reason: 'image' }
  // Short follow-up to a turn that searched ("what about Montreal?"): the
  // queries must be model-rewritten, so the micro-call leans toward search.
  return {
    kind: 'model',
    forceSearch: priorAssistantUsedWeb && words.length <= FOLLOW_UP_MAX_WORDS
  }
}

// --- fused router + query rewrite (one structured micro-call) -------------------

const routeOut = z.object({
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
      maxTokens: 256,
      meta: { surface: 'chat', step: 'route', conversationId: opts.conversationId },
      signal: opts.signal
    })
    const queries = [...new Set(out.queries.map((q) => q.trim()).filter(Boolean))].slice(
      0,
      MAX_QUERIES
    )
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
