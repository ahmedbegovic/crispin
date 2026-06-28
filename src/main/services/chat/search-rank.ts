/**
 * Pure, dependency-free lexical passage ranking for fetched web pages. Splits a
 * page into heading-aware chunks, scores each against the user's question by
 * term overlap, and re-emits the best chunks RELEVANCE-FIRST. Two wins over the
 * old head-clip: (1) a short page whose answer sits near the bottom is no longer
 * truncated away before the model sees it; (2) a long page hands `condense` a
 * pre-filtered, relevant subset instead of 20k of raw markdown.
 *
 * Lexical on purpose — the RAG embedder is not resident on a web-only chat turn
 * (forcing a model load into a 24 GB budget), so chunk scoring stays zero-RAM
 * and deterministic. Mirrors the heading-aware chunking the RAG sidecar already
 * does, reimplemented here in the main process.
 */

const HEADING_RE = /^(#{1,6})\s+(.+?)\s*#*\s*$/
/** Chunks larger than this are split by paragraph so ranking has finer grain. */
const MAX_CHUNK_CHARS = 1_200

/** Common words that carry no retrieval signal. */
const STOPWORDS = new Set([
  'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'any', 'can', 'her', 'was',
  'one', 'our', 'out', 'has', 'had', 'his', 'how', 'its', 'who', 'why', 'what', 'when',
  'where', 'which', 'with', 'this', 'that', 'they', 'them', 'then', 'than', 'from', 'have',
  'does', 'did', 'will', 'would', 'should', 'could', 'about', 'into', 'over', 'your',
  'his', 'she', 'him', 'get', 'got', 'use', 'using', 'between', 'their', 'there', 'these',
  'those', 'some', 'more', 'most', 'much', 'many', 'such', 'been', 'being', 'were', 'also'
])

export interface PageChunk {
  /** Heading breadcrumb from the document root, outermost first. */
  headingPath: string[]
  text: string
}

/**
 * Distinct, lowercased query terms worth matching: words longer than two chars
 * that aren't stopwords, plus short numeric tokens ("15", "2025") that carry
 * real signal (a model name, a year).
 */
export function queryTerms(question: string): string[] {
  const raw = question.toLowerCase().match(/[a-z0-9]+/g) ?? []
  return [
    ...new Set(
      raw.filter((t) => (t.length > 2 || (t.length === 2 && /^\d+$/.test(t))) && !STOPWORDS.has(t))
    )
  ]
}

/** Split a heading section that is too long into paragraph-sized pieces. */
function splitLarge(chunk: PageChunk): PageChunk[] {
  if (chunk.text.length <= MAX_CHUNK_CHARS) return [chunk]
  const paras = chunk.text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean)
  const pieces: PageChunk[] = []
  let buf = ''
  for (const p of paras) {
    if (buf && buf.length + p.length > MAX_CHUNK_CHARS) {
      pieces.push({ headingPath: chunk.headingPath, text: buf })
      buf = ''
    }
    buf = buf ? `${buf}\n\n${p}` : p
  }
  if (buf) pieces.push({ headingPath: chunk.headingPath, text: buf })
  return pieces.length > 0 ? pieces : [chunk]
}

/** Split page markdown into heading-aware chunks. */
export function splitIntoChunks(markdown: string): PageChunk[] {
  const lines = markdown.split('\n')
  const chunks: PageChunk[] = []
  const stack: Array<{ level: number; title: string }> = []
  let buf: string[] = []
  const flush = (): void => {
    const text = buf.join('\n').trim()
    if (text) chunks.push({ headingPath: stack.map((s) => s.title), text })
    buf = []
  }
  for (const line of lines) {
    const m = HEADING_RE.exec(line)
    if (m) {
      flush()
      const level = m[1].length
      while (stack.length > 0 && stack[stack.length - 1].level >= level) stack.pop()
      stack.push({ level, title: m[2].trim() })
    } else {
      buf.push(line)
    }
  }
  flush()
  return chunks.flatMap(splitLarge)
}

const countOccurrences = (haystack: string, term: string): number => {
  let count = 0
  let from = 0
  for (;;) {
    const i = haystack.indexOf(term, from)
    if (i === -1) break
    count++
    from = i + term.length
  }
  return count
}

/**
 * Lexical relevance of a chunk to the query terms: distinct-term COVERAGE leads
 * (length-insensitive, the robust signal), a damped term-frequency bonus and a
 * heading-match bonus refine it, and a gentle length penalty stops a huge chunk
 * winning on raw counts. Zero when no query term appears.
 */
export function scoreChunk(chunk: PageChunk, terms: string[]): number {
  if (terms.length === 0) return 0
  const headingHay = chunk.headingPath.join(' ').toLowerCase()
  const bodyHay = chunk.text.toLowerCase()
  const hay = `${headingHay} ${bodyHay}`
  let covered = 0
  let tf = 0
  let headingHits = 0
  for (const t of terms) {
    const occ = countOccurrences(hay, t)
    if (occ > 0) {
      covered++
      tf += Math.min(occ, 4) // saturate — repeats matter less and less
      if (headingHay.includes(t)) headingHits++
    }
  }
  if (covered === 0) return 0
  const raw = covered * 2 + tf * 0.5 + headingHits
  return raw / (1 + chunk.text.length / 4000)
}

const renderChunk = (c: PageChunk): string =>
  c.headingPath.length > 0 ? `${c.headingPath.join(' › ')}\n${c.text}` : c.text

// --- candidate (search-result) scoring -------------------------------------------

/** The registrable-ish host, lowercased, www-stripped. '' when unparseable. */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '')
  } catch {
    return ''
  }
}

const PRIMARY_HOSTS = new Set([
  'wikipedia.org', 'en.wikipedia.org', 'arxiv.org', 'pubmed.ncbi.nlm.nih.gov',
  'developer.mozilla.org', 'docs.python.org', 'nytimes.com', 'reuters.com',
  'apnews.com', 'bbc.com', 'bbc.co.uk', 'nature.com', 'who.int', 'nasa.gov'
])
const DEV_HOSTS = ['stackoverflow.com', 'stackexchange.com', 'github.com', 'gitlab.com']
const FORUM_HOSTS = ['reddit.com', 'quora.com', 'pinterest.com', 'medium.com', 'tumblr.com']
const FARM_HOSTS = ['ehow.com', 'answers.com', 'wikihow.com', 'buzzfeed.com', 'examiner.com']

const matchesHost = (host: string, base: string): boolean =>
  host === base || host.endsWith(`.${base}`)

/**
 * Source-type reliability bonus from the URL alone — official/primary sources
 * lead, dev Q&A is mildly favored (good for debugging), forums and content
 * farms are penalized for factual lookups. Heuristic and deliberately small;
 * it nudges ordering, it doesn't gate.
 */
export function domainBonus(url: string): number {
  const host = hostOf(url)
  if (!host) return 0
  let score = 0
  if (/\.(gov|mil|edu)(\.[a-z]{2,3})?$/.test(host)) score += 1.5
  if (/^(docs|developer|dev|support|help|learn)\./.test(host)) score += 1.2
  if (PRIMARY_HOSTS.has(host)) score += 1.0
  if (DEV_HOSTS.some((h) => matchesHost(host, h))) score += 0.6
  if (FORUM_HOSTS.some((h) => matchesHost(host, h))) score -= 0.5
  if (FARM_HOSTS.some((h) => matchesHost(host, h))) score -= 1.0
  return score
}

export interface CandidateSignals {
  url: string
  title?: string | null
  snippet?: string | null
  /** 0-based position within its search query's results (lower = better-ranked). */
  rank?: number
}

/**
 * Deterministic relevance of a search result, BEFORE any model sees it: query-
 * term overlap in title+snippet (the lead signal), a search-rank position prior,
 * and the source-type bonus. Lets the harness pre-rank the pool — and skip the
 * LLM "which to read?" call entirely on tiny budgets — with zero model latency.
 */
export function candidateScore(c: CandidateSignals, terms: string[]): number {
  const hay = `${c.title ?? ''} ${c.snippet ?? ''}`.toLowerCase()
  let covered = 0
  let tf = 0
  for (const t of terms) {
    const occ = countOccurrences(hay, t)
    if (occ > 0) {
      covered++
      tf += Math.min(occ, 3)
    }
  }
  const overlap = covered * 1.5 + tf * 0.25
  const position = 1 / (1 + (c.rank ?? 0))
  return overlap + position + domainBonus(c.url)
}

/**
 * Select the most relevant chunks of a page, RELEVANCE-FIRST, up to a character
 * budget. Highest-scoring chunk leads so a later clip to a per-source limit
 * keeps the answer instead of the page header. Falls back to the document head
 * when there's no lexical signal (empty query terms, no headings, or nothing
 * matched) — never worse than the old behavior.
 */
export function rankPassages(markdown: string, question: string, charBudget: number): string {
  const text = markdown.trim()
  if (text.length <= charBudget) {
    // The page already fits — KEEP every chunk, just reorder relevance-first so a
    // downstream clip keeps the answer, not the header. (Filtering here would drop
    // an answer-bearing chunk that happens to lack a query term — synonyms, a
    // value in a table — making this worse than the old head-clip.)
    const terms = queryTerms(question)
    const chunks = splitIntoChunks(text)
    if (terms.length === 0 || chunks.length <= 1) return text
    const scored = chunks.map((c, i) => ({ c, i, s: scoreChunk(c, terms) }))
    if (scored.every((x) => x.s === 0)) return text
    const ordered = [...scored].sort((a, b) => b.s - a.s || a.i - b.i)
    return ordered.map((x) => renderChunk(x.c)).join('\n\n')
  }

  const terms = queryTerms(question)
  if (terms.length === 0) return text.slice(0, charBudget)
  const chunks = splitIntoChunks(text)
  if (chunks.length <= 1) return text.slice(0, charBudget)

  const matched = chunks
    .map((c) => ({ c, s: scoreChunk(c, terms) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
  if (matched.length === 0) return text.slice(0, charBudget)

  const picked: string[] = []
  let total = 0
  for (const x of matched) {
    const piece = renderChunk(x.c)
    if (picked.length > 0 && total + piece.length > charBudget) break
    picked.push(piece)
    total += piece.length + 2
    if (total >= charBudget) break
  }
  return picked.join('\n\n')
}
