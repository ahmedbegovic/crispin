import { z } from 'zod'
import type { MessagePart } from '@shared/types'
import type { EngineClient } from '../engine-client'
import type { ToolsClient, WebSearchEntry } from '../tools-client'
import { condense, structured } from '../structured'
import { scopedLogger } from '../logger'
import type { SourceTracker } from './tools'
import { fenceUntrustedWeb } from './untrusted-web'
import { DEFAULT_SCOPE, type SearchScope } from './search-router-core'
import { rankPassages, candidateScore, domainBonus, hostOf, queryTerms } from './search-rank'
import type { ProviderQuery } from './search-providers-core'

/**
 * Harness-owned web search for the Chat tab: search → select → visit →
 * condense → assess, every decision either pure code or one constrained
 * micro-call, with the chat model only writing the final answer. 2–4B models
 * collapse when they own this control flow (~88% single-turn → ~17% multi-turn
 * tool use); owning it here is the whole point.
 *
 * Depth is the model's call without handing it the loop: after each read batch
 * a single constrained "do you have a full picture yet?" judgement decides
 * whether to deepen (read more) or broaden (search gap-filling queries), up to
 * a hard ceiling. The model picks when to stop; the harness keeps executing.
 *
 * Progress is emitted as ordinary web_search/web_visit tool_call/tool_result
 * parts through the existing PartStream — the renderer needs zero changes,
 * the persisted parts replay into next-turn history exactly like model-made
 * calls (and stay small: results carry the condensed text, not raw pages).
 *
 * Any failure short of an abort degrades: callers get null and fall back to
 * the model-owned loop, so a pipeline turn can never be worse than today.
 */

const log = scopedLogger('chat-pipeline')

/**
 * Per-scope search budget. The MODEL picks the scope (search-router); the
 * HARNESS owns every number here — depth scales with the question without ever
 * handing a small model the loop it collapses on. `deep_research` ≈ the old
 * fixed pipeline (6 results / 5 first-batch / 12 ceiling), so the widest band is
 * a strict no-regression floor; the smaller bands are the whole point of the
 * revamp ("why always 6?" → a quick lookup now pulls ~3 results and 1–2 reads).
 */
export interface SearchBudget {
  /** Max router queries actually run (the router may write more; we clip). */
  queries: number
  /** Results fetched per query. */
  resultsPerQuery: number
  /** Floor of successful first-batch visits before judging sufficiency. */
  minGoodVisits: number
  /** Pages selected for the first read batch. */
  maxVisits: number
  /** Adaptive "need more?" rounds allowed after the first batch. */
  adaptiveRounds: number
  /** Pages added per adaptive round when the model wants to keep looking. */
  adaptiveBatch: number
  /** Hard ceiling on total pages read across all rounds — latency + context guard. */
  maxTotalVisits: number
}

export const BUDGETS: Record<SearchScope, SearchBudget> = {
  quick_lookup: { queries: 1, resultsPerQuery: 3, minGoodVisits: 1, maxVisits: 2, adaptiveRounds: 0, adaptiveBatch: 0, maxTotalVisits: 2 },
  fresh_fact: { queries: 2, resultsPerQuery: 4, minGoodVisits: 2, maxVisits: 3, adaptiveRounds: 1, adaptiveBatch: 3, maxTotalVisits: 5 },
  local_realtime: { queries: 2, resultsPerQuery: 4, minGoodVisits: 2, maxVisits: 3, adaptiveRounds: 1, adaptiveBatch: 3, maxTotalVisits: 5 },
  comparison: { queries: 4, resultsPerQuery: 5, minGoodVisits: 3, maxVisits: 6, adaptiveRounds: 2, adaptiveBatch: 4, maxTotalVisits: 10 },
  deep_research: { queries: 5, resultsPerQuery: 6, minGoodVisits: 3, maxVisits: 5, adaptiveRounds: 3, adaptiveBatch: 4, maxTotalVisits: 12 }
}

/** Resolve a scope (or a router omission) to its budget. */
export const budgetFor = (scope: SearchScope | null | undefined): SearchBudget =>
  BUDGETS[scope ?? DEFAULT_SCOPE]

const VISIT_MAX_CHARS = 20_000
/** Pages longer than this get condensed against the question; shorter clip. */
const CONDENSE_THRESHOLD = 5_000
const PER_SOURCE_CHAR_LIMIT = 1_500
/** Passage-ranking keeps at most this many of a page's most relevant chars. */
const RANK_CHAR_BUDGET = 8_000
const EVIDENCE_CHAR_LIMIT = 9_000
/** Snippets-only fallback when every visit failed. */
const SNIPPET_FALLBACK_LIMIT = 12

const clip = (text: string, limit: number): string =>
  text.length > limit ? `${text.slice(0, limit)}\n…[truncated]` : text

export interface PipelineEmitter {
  addPart(part: MessagePart): void
  toolEvent(
    toolCallId: string,
    name: string,
    phase: 'start' | 'result' | 'error',
    detail?: string
  ): void
}

export interface SearchPipelineOptions {
  engine: EngineClient
  tools: ToolsClient
  /** The chat model — select and condense ride on it, already loaded. */
  model: string
  /** The user's latest typed text (un-clipped; prompts clip internally). */
  question: string
  /** Scope-derived search budget (results/visits/rounds). */
  budget: SearchBudget
  conversationId: string
  sources: SourceTracker
  searxngUrl: string | null
  /** Per-turn random fence code for wrapping the untrusted evidence block. */
  fenceId: string
  /** Context window of the answering model; scales the evidence budget. Null = unknown. */
  contextLength: number | null
  signal: AbortSignal
  emit: PipelineEmitter
}

export interface PipelineEvidence {
  /** Numbered evidence block + synthesis instructions, ready to append. */
  text: string
  sourceCount: number
}

interface Candidate {
  entry: WebSearchEntry
  sourceId: number
  queryIndex: number
  /** 0-based position within its query's results — a rerank position prior. */
  rank: number
}

interface VisitNote {
  sourceId: number
  title: string | null
  url: string
  text: string
}

const throwIfAborted = (signal: AbortSignal): void => {
  if (signal.aborted) throw new Error('aborted')
}

// --- search ---------------------------------------------------------------------

/**
 * Run all queries in parallel; one web_search call/result pair each. Call
 * parts are emitted BEFORE the fetches run so the cards appear immediately
 * (a Stop mid-search leaves dangling calls — run()'s abort sweep settles
 * them). Results are emitted in query order once everything lands.
 */
async function searchAll(
  queries: string[],
  opts: SearchPipelineOptions
): Promise<Candidate[]> {
  const jobs = queries.map((query, queryIndex) => ({
    query,
    queryIndex,
    callId: `pipeline-${crypto.randomUUID()}`
  }))
  for (const job of jobs) {
    opts.emit.addPart({
      type: 'tool_call',
      id: job.callId,
      name: 'web_search',
      args: JSON.stringify({ query: job.query, max_results: opts.budget.resultsPerQuery })
    })
    opts.emit.toolEvent(job.callId, 'web_search', 'start', job.query)
  }

  const settled = await Promise.all(
    jobs.map(async (job) => {
      try {
        const res = await opts.tools.search(
          {
            query: job.query,
            maxResults: opts.budget.resultsPerQuery,
            backend: 'auto',
            searxngUrl: opts.searxngUrl ?? undefined
          },
          opts.signal
        )
        return { job, results: res.results, backend: res.backend, error: null as string | null }
      } catch (err) {
        if (opts.signal.aborted) throw err
        return {
          job,
          results: [] as WebSearchEntry[],
          backend: '',
          error: err instanceof Error ? err.message : String(err)
        }
      }
    })
  )
  throwIfAborted(opts.signal)

  const candidates: Candidate[] = []
  const seen = new Set<string>()
  for (const s of settled) {
    if (s.error) {
      const result = `Error: ${s.error}`
      opts.emit.addPart({
        type: 'tool_result',
        toolCallId: s.job.callId,
        name: 'web_search',
        result
      })
      opts.emit.toolEvent(s.job.callId, 'web_search', 'error', clip(result, 200))
      continue
    }
    const lines: string[] = []
    const sourceIds: number[] = []
    s.results.forEach((r, rank) => {
      const source = opts.sources.add(r.url, r.title || null, r.snippet)
      sourceIds.push(source.id)
      lines.push(`[${source.id}] ${r.title}\n${r.url}\n${r.snippet}`)
      if (!seen.has(r.url)) {
        seen.add(r.url)
        candidates.push({ entry: r, sourceId: source.id, queryIndex: s.job.queryIndex, rank })
      }
    })
    const result = lines.length > 0 ? lines.join('\n\n') : `No results (backend: ${s.backend}).`
    opts.emit.addPart({
      type: 'tool_result',
      toolCallId: s.job.callId,
      name: 'web_search',
      result,
      sourceIds: [...new Set(sourceIds)]
    })
    opts.emit.toolEvent(s.job.callId, 'web_search', 'result', clip(result, 200))
  }
  return candidates
}

// --- select ----------------------------------------------------------------------

const selectOut = z.object({
  /** Source numbers exactly as rendered in the prompt — nothing to hallucinate. */
  picks: z.array(z.number().int())
})

/** Shortlist size handed to the model select when it runs (deeper scopes only). */
const SELECT_SHORTLIST = 10

/** Deterministic pre-rank: lexical overlap + position prior + source-type bonus. */
function prerankCandidates(candidates: Candidate[], question: string): Candidate[] {
  const terms = queryTerms(question)
  return [...candidates]
    .map((c, i) => ({ c, i, s: candidateScore({ url: c.entry.url, title: c.entry.title, snippet: c.entry.snippet, rank: c.rank }, terms) }))
    // stable: ties fall back to the original pool order (i)
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map((x) => x.c)
}

/**
 * Pick which results to read. A deterministic pre-rank (lexical + domain) leads
 * — and on tiny budgets (quick_lookup) IS the decision, skipping the model call
 * entirely. Deeper scopes still let the model choose, but from the pre-ranked
 * TOP-K, not the raw pool. Failure → the pre-rank's top picks (strictly better
 * than the old top-1-per-query fallback).
 */
async function selectCandidates(
  candidates: Candidate[],
  opts: SearchPipelineOptions
): Promise<Candidate[]> {
  const ranked = prerankCandidates(candidates, opts.question)
  if (ranked.length <= opts.budget.maxVisits) return ranked
  // Quick scopes (no adaptive rounds / 1–2 visits): the pre-rank is enough, and
  // a model select on so few reads isn't worth the latency or regression risk.
  if (opts.budget.adaptiveRounds === 0 || opts.budget.maxVisits <= 2) {
    return ranked.slice(0, opts.budget.maxVisits)
  }
  const shortlist = ranked.slice(0, SELECT_SHORTLIST)
  const list = shortlist
    .map(
      (c) =>
        `[${c.sourceId}] ${clip(c.entry.title, 120)} — ${c.entry.url}\n${clip(c.entry.snippet, 240)}`
    )
    .join('\n')
  try {
    const out = await structured({
      engine: opts.engine,
      model: opts.model,
      name: 'select_results',
      schema: selectOut,
      messages: [
        {
          role: 'system',
          content:
            'You pick which web search results a chat assistant should read in full. ' +
            'Reply with a single JSON object matching the requested schema.'
        },
        {
          role: 'user',
          content:
            `Question: ${clip(opts.question, 1000)}\n\n` +
            `Search results:\n${list}\n\n` +
            `Pick the ${opts.budget.maxVisits} result numbers most likely to answer the question. ` +
            'Prefer authoritative and current pages; skip near-duplicates.'
        }
      ],
      maxTokens: 128,
      meta: { surface: 'chat', step: 'select', conversationId: opts.conversationId },
      signal: opts.signal
    })
    const byId = new Map(candidates.map((c) => [c.sourceId, c]))
    const picked = [...new Set(out.picks)]
      .map((n) => byId.get(n))
      .filter((c): c is Candidate => c !== undefined)
      .slice(0, opts.budget.maxVisits)
    if (picked.length > 0) return picked
  } catch (err) {
    if (opts.signal.aborted) throw err
    log.warn(`select failed, taking the pre-rank top: ${err instanceof Error ? err.message : err}`)
  }
  // Fallback: the deterministic pre-rank's best — strictly better than the old
  // top-1-per-query (which ignored relevance and source quality entirely).
  return ranked.slice(0, opts.budget.maxVisits)
}

// --- assess sufficiency -------------------------------------------------------------

/** What the harness should do next, decided by the coverage ledger. */
type NextAction = 'stop' | 'read_more' | 'search_more' | 'cannot_answer'

const sufficiencyOut = z.object({
  /**
   * Reasoning first — cues the CoT lost to enable_thinking:false. OPTIONAL: the
   * grammar enforces structure but not required-presence, so a small model that
   * skips it would otherwise fail post-validation and burn a repair retry (and a
   * double miss makes assessSufficiency return null → deepening stops early).
   * No consumer reads this field.
   */
  reasoning: z.string().optional(),
  /**
   * The coverage ledger: the slots an answer needs, each marked covered / thin /
   * missing. Bookkeeping, not epistemology — a small model classifies what it
   * has far more reliably than it judges a vague "enough?". Advisory for the
   * harness (next_action drives the loop); kept in the schema because filling it
   * first makes the action that follows better grounded. Defaulted so a model
   * that emits only next_action still validates.
   */
  required_slots: z
    .array(
      z.object({
        name: z.string(),
        status: z.enum(['covered', 'thin', 'missing'])
      })
    )
    .default([]),
  /** stop = answerable now · read_more = deepen on what we have · search_more =
   *  fill a gap with new queries · cannot_answer = the web won't yield it. */
  next_action: z.enum(['stop', 'read_more', 'search_more', 'cannot_answer']),
  /** Gap-filling searches, used only when next_action is search_more. */
  more_queries: z.array(z.string()).default([])
})

/**
 * One constrained judgement between read batches: which evidence slots are
 * covered, and what to do next? Replacing the old yes/no "enough?" with a slot
 * ledger turns the call into classification + a four-way action — bookkeeping a
 * 2–4B model stays reliable at, instead of an abstract sufficiency verdict.
 * Failure or abort → null, which the caller treats as "stop" (never loop on
 * errors). This remains the only place depth is decided.
 */
async function assessSufficiency(
  notes: VisitNote[],
  opts: SearchPipelineOptions
): Promise<{ action: NextAction; moreQueries: string[] } | null> {
  const digest = notes
    .map((n) => `[${n.sourceId}] ${n.title ?? n.url}\n${clip(n.text, 400)}`)
    .join('\n\n')
  try {
    const out = await structured({
      engine: opts.engine,
      model: opts.model,
      name: 'assess_sufficiency',
      schema: sufficiencyOut,
      messages: [
        {
          role: 'system',
          content:
            'You track whether enough web evidence has been gathered to answer a question. ' +
            'List the slots the answer needs and mark each covered, thin, or missing, then ' +
            'choose the next action. Reply with a single JSON object matching the requested schema.'
        },
        {
          role: 'user',
          content:
            `Question: ${clip(opts.question, 1000)}\n\n` +
            `Pages read so far:\n${clip(digest, 6000)}\n\n` +
            'List the key information slots this question needs (facts, entities, or ' +
            'comparison axes) and mark each "covered", "thin", or "missing". Then set ' +
            'next_action:\n' +
            '- "stop" when every important slot is covered.\n' +
            '- "read_more" when the answer is likely in pages already found but not yet read.\n' +
            '- "search_more" when a slot is missing and needs a new search — write up to 3 ' +
            'short gap-filling queries in more_queries.\n' +
            '- "cannot_answer" when the web is unlikely to yield the missing slots.'
        }
      ],
      maxTokens: 320,
      meta: { surface: 'chat', step: 'sufficiency', conversationId: opts.conversationId },
      signal: opts.signal
    })
    return {
      action: out.next_action,
      moreQueries: [...new Set(out.more_queries.map((q) => q.trim()).filter(Boolean))].slice(0, 3)
    }
  } catch (err) {
    if (opts.signal.aborted) throw err
    log.warn(`coverage check failed, treating as stop: ${err instanceof Error ? err.message : err}`)
    return null
  }
}

// --- visit + condense ---------------------------------------------------------------

/**
 * Visit pages in parallel: all call parts first (cards appear immediately),
 * then results in order once everything lands. Long pages are condensed
 * against the question — those are plain micro-calls on the chat model, safe
 * to run concurrently. A condense failure costs only the compression.
 */
async function visitAll(
  targets: Array<{ url: string; title: string | null }>,
  opts: SearchPipelineOptions
): Promise<VisitNote[]> {
  const jobs = targets.map((t) => ({ ...t, callId: `pipeline-${crypto.randomUUID()}` }))
  for (const job of jobs) {
    opts.emit.addPart({
      type: 'tool_call',
      id: job.callId,
      name: 'web_visit',
      args: JSON.stringify({ url: job.url })
    })
    opts.emit.toolEvent(job.callId, 'web_visit', 'start', job.url)
  }
  const outcomes = await Promise.all(
    jobs.map(async (job) => {
      try {
        const page = await opts.tools.visit(job.url, VISIT_MAX_CHARS, opts.signal)
        let text = page.markdown.trim()
        // Passage-rank first: lead with the sections relevant to the question so
        // a short page's answer near the bottom isn't head-clipped away, and a
        // long page hands condense a pre-filtered subset, not 20k of raw markdown.
        if (text.length > PER_SOURCE_CHAR_LIMIT) {
          text = rankPassages(text, opts.question, RANK_CHAR_BUDGET) || text
        }
        if (text.length > CONDENSE_THRESHOLD) {
          try {
            text = await condense({
              engine: opts.engine,
              model: opts.model,
              text,
              focus: opts.question,
              charLimit: PER_SOURCE_CHAR_LIMIT,
              meta: { surface: 'chat', step: 'condense', conversationId: opts.conversationId },
              signal: opts.signal
            })
          } catch (err) {
            if (opts.signal.aborted) throw err
            text = clip(text, PER_SOURCE_CHAR_LIMIT)
          }
        } else {
          // Relevance-first already, so this clip keeps the answer, not the header.
          text = clip(text, PER_SOURCE_CHAR_LIMIT)
        }
        if (!text.trim()) return { job, note: null, error: 'page had no readable content' }
        const source = opts.sources.add(page.url || job.url, page.title ?? job.title, text)
        const note: VisitNote = {
          sourceId: source.id,
          title: page.title ?? job.title,
          url: page.url || job.url,
          text
        }
        return { job, note, error: null as string | null }
      } catch (err) {
        if (opts.signal.aborted) throw err
        return { job, note: null, error: err instanceof Error ? err.message : String(err) }
      }
    })
  )
  throwIfAborted(opts.signal)

  const notes: VisitNote[] = []
  for (const { job, note, error } of outcomes) {
    if (note) {
      const result = `[${note.sourceId}] ${note.title ?? note.url}\n\n${note.text}`
      opts.emit.addPart({
        type: 'tool_result',
        toolCallId: job.callId,
        name: 'web_visit',
        result,
        sourceIds: [note.sourceId]
      })
      opts.emit.toolEvent(job.callId, 'web_visit', 'result', clip(result, 200))
      notes.push(note)
    } else {
      const result = `Error: ${error}`
      opts.emit.addPart({ type: 'tool_result', toolCallId: job.callId, name: 'web_visit', result })
      opts.emit.toolEvent(job.callId, 'web_visit', 'error', clip(result, 200))
    }
  }
  return notes
}

// --- evidence ---------------------------------------------------------------------

const EVIDENCE_INSTRUCTIONS =
  "Answer the user's message above using this evidence. Cite a source's [n] marker inline " +
  'for every claim you take from it. If the evidence does not cover part of the question, ' +
  'say so plainly instead of guessing. Never invent URLs or source numbers, and do not ' +
  'mention this note.'

/**
 * Evidence char budget scaled to the model's window: ~22% of the context (≈4
 * chars/token), bounded so tiny windows still get some and huge ones don't dump
 * the whole web into one prompt. Falls back to the fixed cap when unknown.
 */
export function scaledEvidenceLimit(contextLength: number | null): number {
  if (!contextLength) return EVIDENCE_CHAR_LIMIT
  return Math.min(Math.max(Math.floor(contextLength * 4 * 0.22), 4000), 60_000)
}

/**
 * Order evidence for the final prompt: group by host, sort groups by their best
 * source-type bonus (reliable-leaning) then first-seen order, and round-robin
 * across groups so no single domain monopolizes the front of a budget-truncated
 * block. For a comparison this keeps ≥1 source per side — A can't eat the whole
 * budget when A and B live on different domains.
 */
function orderEvidence(notes: VisitNote[]): VisitNote[] {
  if (notes.length <= 1) return notes
  const groups = new Map<string, VisitNote[]>()
  const firstIndex = new Map<string, number>()
  notes.forEach((n, i) => {
    const host = hostOf(n.url) || n.url
    const g = groups.get(host)
    if (g) g.push(n)
    else {
      groups.set(host, [n])
      firstIndex.set(host, i)
    }
  })
  const ordered = [...groups.entries()].sort((a, b) => {
    const bonus = domainBonus(`https://${b[0]}`) - domainBonus(`https://${a[0]}`)
    return bonus !== 0 ? bonus : (firstIndex.get(a[0]) ?? 0) - (firstIndex.get(b[0]) ?? 0)
  })
  const out: VisitNote[] = []
  for (let round = 0, added = true; added; round++) {
    added = false
    for (const [, g] of ordered) {
      if (round < g.length) {
        out.push(g[round])
        added = true
      }
    }
  }
  return out
}

function buildEvidence(
  notes: VisitNote[],
  snippets: Candidate[],
  fenceId: string,
  contextLength: number | null
): PipelineEvidence | null {
  const evidenceLimit = scaledEvidenceLimit(contextLength)
  if (notes.length > 0) {
    const blocks: string[] = []
    let total = 0
    for (const n of orderEvidence(notes)) {
      // Clip the title (an unbounded page <title> could otherwise blow a whole
      // block past the limit); always keep at least the first block so a single
      // oversized source still yields evidence rather than an empty block.
      const block = `[${n.sourceId}] ${(n.title ?? n.url).slice(0, 200)}\n${n.text}`
      if (blocks.length > 0 && total + block.length > evidenceLimit) break
      total += block.length
      blocks.push(block)
    }
    return {
      text: `[Web evidence gathered for this message — numbered sources:]\n\n${fenceUntrustedWeb(blocks.join('\n\n'), fenceId)}\n\n${EVIDENCE_INSTRUCTIONS}`,
      sourceCount: blocks.length
    }
  }
  if (snippets.length > 0) {
    // Mirror the notes path: clip the (unbounded) page title and cap the running
    // total against the same budget so a few long titles can't blow the window.
    const lines: string[] = []
    let total = 0
    for (const c of snippets.slice(0, SNIPPET_FALLBACK_LIMIT)) {
      const line = `[${c.sourceId}] ${(c.entry.title ?? '').slice(0, 200)} — ${clip(c.entry.snippet, 240)}`
      if (lines.length > 0 && total + line.length > evidenceLimit) break
      total += line.length
      lines.push(line)
    }
    return {
      text: `[Web search snippets gathered for this message — numbered sources (no page could be fetched in full):]\n\n${fenceUntrustedWeb(lines.join('\n'), fenceId)}\n\n${EVIDENCE_INSTRUCTIONS}`,
      sourceCount: lines.length
    }
  }
  return null
}

// --- entry points --------------------------------------------------------------------

/** Pool entries not yet sent to visitAll, in pool order (best-first). */
function unvisited(pool: Candidate[], visited: ReadonlySet<string>): Candidate[] {
  return pool.filter((c) => !visited.has(c.entry.url))
}

/** Merge candidate pools, keeping the first occurrence per URL (stable [n] order). */
function dedupeByUrl(pool: Candidate[]): Candidate[] {
  const seen = new Set<string>()
  const out: Candidate[] = []
  for (const c of pool) {
    if (seen.has(c.entry.url)) continue
    seen.add(c.entry.url)
    out.push(c)
  }
  return out
}

/** Visit a batch (skipping already-visited), marking + collecting notes in place. */
async function visitBatch(
  picks: Candidate[],
  notes: VisitNote[],
  visited: Set<string>,
  opts: SearchPipelineOptions
): Promise<void> {
  const targets = picks.filter((c) => !visited.has(c.entry.url))
  if (targets.length === 0) return
  for (const c of targets) visited.add(c.entry.url)
  const got = await visitAll(
    targets.map((c) => ({ url: c.entry.url, title: c.entry.title || null })),
    opts
  )
  notes.push(...got)
}

/** The full pipeline for router-written queries. Null = fall back to the loop. */
export async function runSearchPipeline(
  queries: string[],
  opts: SearchPipelineOptions
): Promise<PipelineEvidence | null> {
  const { budget } = opts
  // The router may write more queries than the scope's budget allows; the
  // harness runs only the first `budget.queries` (a quick_lookup uses one).
  let candidates = await searchAll(queries.slice(0, Math.max(1, budget.queries)), opts)
  if (candidates.length === 0) return null

  const visited = new Set<string>()
  const notes: VisitNote[] = []

  // First read: the best picks, with a harness top-up if too few survive — a
  // guaranteed floor (no model decision) before anyone judges sufficiency.
  const picked = await selectCandidates(candidates, opts)
  throwIfAborted(opts.signal)
  await visitBatch(picked, notes, visited, opts)
  if (notes.length < budget.minGoodVisits) {
    await visitBatch(
      unvisited(candidates, visited).slice(0, budget.maxVisits - notes.length),
      notes,
      visited,
      opts
    )
  }

  // Adaptive deepening: the model judges round by round whether it has a full
  // picture; the harness keeps executing, bounded by the page ceiling.
  for (let round = 0; round < budget.adaptiveRounds && notes.length > 0; round++) {
    if (notes.length >= budget.maxTotalVisits) {
      log.info(`sufficiency: reached ${budget.maxTotalVisits}-page ceiling, stopping`)
      break
    }
    const verdict = await assessSufficiency(notes, opts)
    throwIfAborted(opts.signal)
    // stop (answerable) and cannot_answer (web won't help) both end the loop;
    // a null verdict (engine error) is treated as stop. read_more / search_more
    // continue — search_more also broadens with the gap-filling queries.
    if (!verdict || verdict.action === 'stop' || verdict.action === 'cannot_answer') break

    // Broaden with the model's gap-filling queries, then deepen on the pool.
    let fresh: Candidate[] = []
    if (verdict.action === 'search_more' && verdict.moreQueries.length > 0) {
      fresh = await searchAll(verdict.moreQueries, opts)
      throwIfAborted(opts.signal)
      candidates = dedupeByUrl([...candidates, ...fresh])
    }
    const remaining = budget.maxTotalVisits - notes.length
    // Read the gap-filling results FIRST when the model broadened: appending them
    // to the end of the pool and reading in pool order let leftover ORIGINAL
    // candidates crowd them out, so the broadening never actually read anything new.
    const order = fresh.length > 0 ? dedupeByUrl([...fresh, ...candidates]) : candidates
    const next = unvisited(order, visited).slice(0, Math.min(budget.adaptiveBatch, remaining))
    if (next.length === 0) break // nothing new to read — stop rather than spin
    await visitBatch(next, notes, visited, opts)
  }

  return buildEvidence(notes, candidates, opts.fenceId, opts.contextLength)
}

/** Visit-only pipeline for pasted URLs — no search, no select. */
export async function runVisitPipeline(
  urls: string[],
  opts: SearchPipelineOptions
): Promise<PipelineEvidence | null> {
  const notes = await visitAll(
    urls.map((url) => ({ url, title: null })),
    opts
  )
  return buildEvidence(notes, [], opts.fenceId, opts.contextLength)
}

// --- structured providers (fast paths) ----------------------------------------

/** The subset of pipeline plumbing a provider lookup needs (no search budget). */
export interface ProviderPipelineOptions {
  tools: ToolsClient
  sources: SourceTracker
  /** Per-turn random fence code for the untrusted evidence block. */
  fenceId: string
  signal: AbortSignal
  emit: PipelineEmitter
}

const providerLabel = (q: ProviderQuery): string => {
  if (q.kind === 'github_release') return `${q.owner}/${q.repo} release`
  if (q.kind === 'arxiv') return `arXiv ${q.name}`
  return `${q.name} on ${q.kind === 'pypi' ? 'PyPI' : 'npm'}`
}

/**
 * Structured fast path: a single key-free registry/API lookup (PyPI/npm/GitHub/
 * arXiv) surfaced as one web_lookup tool_call/result. Returns fenced evidence on
 * a hit, or null on a miss/error so the caller falls back to generic search.
 */
export async function runProviderPipeline(
  query: ProviderQuery,
  opts: ProviderPipelineOptions
): Promise<PipelineEvidence | null> {
  const callId = `pipeline-${crypto.randomUUID()}`
  const label = providerLabel(query)
  opts.emit.addPart({ type: 'tool_call', id: callId, name: 'web_lookup', args: JSON.stringify(query) })
  opts.emit.toolEvent(callId, 'web_lookup', 'start', label)

  let res
  try {
    res = await opts.tools.providerLookup(query, opts.signal)
  } catch (err) {
    if (opts.signal.aborted) throw err
    const result = `Error: ${err instanceof Error ? err.message : String(err)}`
    opts.emit.addPart({ type: 'tool_result', toolCallId: callId, name: 'web_lookup', result })
    opts.emit.toolEvent(callId, 'web_lookup', 'error', clip(result, 200))
    return null
  }

  if (!res.ok || !res.url || !res.summary.trim()) {
    const result = `No structured result (${res.error ?? 'miss'})`
    opts.emit.addPart({ type: 'tool_result', toolCallId: callId, name: 'web_lookup', result })
    opts.emit.toolEvent(callId, 'web_lookup', 'result', result)
    return null
  }

  const source = opts.sources.add(res.url, res.title ?? res.source, res.summary)
  const heading = (res.title ?? res.source).slice(0, 200)
  const block = `[${source.id}] ${heading}\n${clip(res.summary, PER_SOURCE_CHAR_LIMIT * 2)}`
  const result = `[${source.id}] ${heading}\n\n${res.summary}`
  opts.emit.addPart({
    type: 'tool_result',
    toolCallId: callId,
    name: 'web_lookup',
    result,
    sourceIds: [source.id]
  })
  opts.emit.toolEvent(callId, 'web_lookup', 'result', clip(result, 200))

  return {
    text: `[Structured ${res.source} result for this message — numbered source:]\n\n${fenceUntrustedWeb(block, opts.fenceId)}\n\n${EVIDENCE_INSTRUCTIONS}`,
    sourceCount: 1
  }
}
