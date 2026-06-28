/**
 * Pure, dependency-free chat web-route heuristics: the obvious-case classifier
 * that runs BEFORE the model micro-call. Kept import-free on purpose so both
 * the router (search-router.ts, which pulls in the engine/electron) and the
 * standalone eval (scripts/chat-eval-router.mjs) share ONE source of truth
 * instead of the mirrored copy the old eval scripts had to maintain.
 */

/**
 * The information-need class the router picks; CODE maps it to a search budget
 * (results/visits/rounds). The MODEL classifies the need, the harness owns the
 * numbers — so depth scales with the question without handing a small model the
 * loop. Order is widening, roughly, but the budget table is the source of truth.
 */
export const SEARCH_SCOPES = [
  'quick_lookup', // a single discrete fact ("who is the CEO of X")
  'fresh_fact', // one current/time-sensitive fact ("today's weather", a price)
  'local_realtime', // here-and-now local info ("open now", "near me")
  'comparison', // weigh ≥2 entities/options against each other
  'deep_research' // multi-faceted; needs several sources to answer well
] as const
export type SearchScope = (typeof SEARCH_SCOPES)[number]

/**
 * Fallback when the router omits scope (older/smaller models that ignore the
 * new field). A sensible middle band — smaller than the old fixed pipeline so
 * the common turn stops over-searching — with the slot-coverage ledger free to
 * climb when a question turns out to need more. Never the widest band: an
 * omission shouldn't silently cost a 12-page crawl.
 */
export const DEFAULT_SCOPE: SearchScope = 'fresh_fact'

/**
 * When the router omits scope, infer breadth from how many queries it WROTE — a
 * model that emitted 4-5 standalone queries clearly intends a broad search, and
 * the pipeline would otherwise clip them to the default band's 2-query budget and
 * synthesize from thin evidence. Only used on omission; an explicit scope wins.
 */
export function inferScopeFromQueries(count: number): SearchScope {
  if (count >= 4) return 'deep_research'
  if (count === 3) return 'comparison'
  return DEFAULT_SCOPE
}

export type ChatRoute =
  | { kind: 'direct' }
  | { kind: 'search'; queries: string[]; scope: SearchScope }
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

/**
 * High-precision current-information cues. A match is a SEARCH FLOOR, not a
 * verdict: it only sets `freshHint` so the micro-call leans toward needs_search
 * (the model still writes the queries). Kept precise on purpose — a false
 * positive merely nudges a search the model would likely run anyway, whereas a
 * NO_SEARCH false positive would wrongly skip one (so those gate on !fresh).
 */
const FRESHNESS_RE =
  /\b(today|tonight|tomorrow|yesterday|latest|current(?:ly)?|recent(?:ly)?|news|headlines?|prices?|stocks?|crypto|weather|forecast|scores?|standings?|schedules?|release\s+date|near\s+me|open\s+now|right\s+now|this\s+(?:week|month|year)|last\s+(?:night|week|weekend|month|year)|202[4-9])\b/i

// --- deterministic no-search classes (conservative: same outcome the model would
// reach, just without the micro-call). Each gates on !fresh at the call site. ---

/** "what is", "calculate", "solve" … left of a bare arithmetic expression. */
const MATH_PREFIX_RE = /^(?:what(?:'?s| is)|whats|calculate|compute|solve|evaluate|eval|simplify)\s+/i
/** A bare arithmetic expression — only digits, operators, and grouping. */
const MATH_BODY_RE = /^[\s\d+\-*/^%().,=x×÷·]+$/

/** Pure arithmetic ("2+2", "what is 3*(4+5)") — never needs the web. */
function isPureMath(t: string): boolean {
  const body = t.replace(MATH_PREFIX_RE, '').replace(/[?.!\s]+$/u, '').trim()
  return body.length > 0 && MATH_BODY_RE.test(body) && /\d/.test(body) && /[+\-*/^%×÷·]/.test(body)
}

const TRANSLATE_RE = /\btranslate\b/i
const LANG_RE =
  /\b(?:into|to|in)\s+(?:english|spanish|french|german|italian|portuguese|dutch|russian|chinese|mandarin|cantonese|japanese|korean|arabic|hindi|bengali|turkish|polish|swedish|norwegian|danish|finnish|greek|hebrew|latin|vietnamese|thai|indonesian|ukrainian|czech|romanian|hungarian)\b/i
/** "convert 5 km to miles" — deterministic unit math, no web. */
const CONVERT_RE = /\bconvert\s+[\d.,]+\s*\w/i

/** Conservative no-search classes. Caller must already know it isn't fresh. */
function isNoSearchClass(t: string): boolean {
  return isPureMath(t) || (TRANSLATE_RE.test(t) && LANG_RE.test(t)) || CONVERT_RE.test(t)
}

export type HeuristicDecision =
  | { kind: 'visit'; urls: string[] }
  | { kind: 'direct'; reason: 'code' | 'pleasantry' | 'image' | 'no_search_class' }
  | { kind: 'model'; forceSearch: boolean; freshHint: boolean }

export function heuristicRoute(text: string, priorAssistantUsedWeb: boolean): HeuristicDecision {
  const trimmed = text.trim()
  const fresh = FRESHNESS_RE.test(trimmed)
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
      return { kind: 'model', forceSearch: true, freshHint: fresh }
    return { kind: 'visit', urls: urls.slice(0, MAX_VISIT_URLS) }
  }
  const words = trimmed.split(/\s+/).filter(Boolean)
  if (words.length <= 3 && PLEASANTRY_RE.test(trimmed)) {
    return { kind: 'direct', reason: 'pleasantry' }
  }
  if (IMAGE_NOUN_RE.test(trimmed) && (IMAGE_REQUEST_RE.test(trimmed) || IMAGE_OF_RE.test(trimmed))) {
    return { kind: 'direct', reason: 'image' }
  }
  // A deterministic no-search class (pure math, translate-to-language, unit
  // conversion) short-circuits the micro-call — but ONLY with no freshness cue,
  // so "summarize the latest news" still searches.
  if (!fresh && isNoSearchClass(trimmed)) return { kind: 'direct', reason: 'no_search_class' }
  // Short follow-up to a turn that searched ("what about Montreal?"): the
  // queries must be model-rewritten, so the micro-call leans toward search.
  // freshHint adds the current-information floor on top of the follow-up nudge.
  return {
    kind: 'model',
    forceSearch: priorAssistantUsedWeb && words.length <= FOLLOW_UP_MAX_WORDS,
    freshHint: fresh
  }
}
