/**
 * Pure, dependency-free chat web-route heuristics: the obvious-case classifier
 * that runs BEFORE the model micro-call. Kept import-free on purpose so both
 * the router (search-router.ts, which pulls in the engine/electron) and the
 * standalone eval (scripts/chat-eval-router.mjs) share ONE source of truth
 * instead of the mirrored copy the old eval scripts had to maintain.
 */

export type ChatRoute =
  | { kind: 'direct' }
  | { kind: 'search'; queries: string[] }
  | { kind: 'visit'; urls: string[] }

const URL_RE = /https?:\/\/[^\s<>"']+/gi
const MAX_VISIT_URLS = 3

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
    while (url.endsWith(')') && (url.match(/\(/g)?.length ?? 0) < (url.match(/\)/g)?.length ?? 0)) {
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
 * Photo/picture asks stay model-owned: image_search only exists in the loop,
 * and a tools-off synthesis round would contradict the system prompt's "never
 * claim you cannot provide images" instruction. Gate on a genuine REQUEST (a
 * request verb, or "<image noun> of/for …") so an incidental mention — "the big
 * picture", "summarize this screenshot-heavy article" — still routes normally.
 */
const IMAGE_NOUN_RE = /\b(photos?|pictures?|pics?|images?|wallpapers?|screenshots?)\b/i
const IMAGE_REQUEST_RE =
  /\b(show|find|get|search|fetch|display|give|grab|send|want|need|generate|pull\s?up|looking\s?for)\b/i
const IMAGE_OF_RE = /\b(photos?|pictures?|pics?|images?|wallpapers?|screenshots?)\s+(of|for)\b/i

/** A follow-up this short is anaphoric — its raw text is a useless query. */
const FOLLOW_UP_MAX_WORDS = 12

export type HeuristicDecision =
  | { kind: 'visit'; urls: string[] }
  | { kind: 'direct'; reason: 'code' | 'pleasantry' | 'image' }
  | { kind: 'model'; forceSearch: boolean }

export function heuristicRoute(text: string, priorAssistantUsedWeb: boolean): HeuristicDecision {
  const trimmed = text.trim()
  // Pasted code first: a code block routinely CONTAINS URLs, and a working
  // session must never be hijacked into a visit-only synthesis.
  if (trimmed.includes('```')) return { kind: 'direct', reason: 'code' }
  // Pasted URLs short-circuit the rest: the user said exactly what to read.
  const urls = [
    ...new Set(
      [...trimmed.matchAll(URL_RE)].map((m) => cleanUrl(m[0])).filter((u): u is string => u !== null)
    )
  ]
  if (urls.length > 0) {
    // A SINGLE url wrapped in a comparison ("compare <url> against the current
    // price of X") needs the other half from search — let the model loop visit
    // AND search rather than a visit-only synthesis that drops it. Multiple urls
    // already supply both sides of the comparison, so just visit them.
    const rest = trimmed.replace(URL_RE, ' ')
    if (
      urls.length === 1 &&
      /\b(compare|comparison|versus|vs\.?|cheaper|pricier|against|better than|worse than)\b/i.test(rest)
    )
      return { kind: 'model', forceSearch: true }
    return { kind: 'visit', urls: urls.slice(0, MAX_VISIT_URLS) }
  }
  const words = trimmed.split(/\s+/).filter(Boolean)
  if (words.length <= 3 && PLEASANTRY_RE.test(trimmed)) {
    return { kind: 'direct', reason: 'pleasantry' }
  }
  if (IMAGE_NOUN_RE.test(trimmed) && (IMAGE_REQUEST_RE.test(trimmed) || IMAGE_OF_RE.test(trimmed))) {
    return { kind: 'direct', reason: 'image' }
  }
  // Short follow-up to a turn that searched ("what about Montreal?"): the
  // queries must be model-rewritten, so the micro-call leans toward search.
  return {
    kind: 'model',
    forceSearch: priorAssistantUsedWeb && words.length <= FOLLOW_UP_MAX_WORDS
  }
}
