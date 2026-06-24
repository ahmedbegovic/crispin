import { z } from 'zod'
import type { MessagePart } from '@shared/types'
import type { EngineClient } from '../engine-client'
import type { ToolsClient, WebSearchEntry } from '../tools-client'
import { condense, structured } from '../structured'
import { scopedLogger } from '../logger'
import type { SourceTracker } from './tools'
import { fenceUntrustedWeb } from './untrusted-web'

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

const RESULTS_PER_QUERY = 6
// Pages read in full. Visits (fetch + condense) run concurrently, so a higher
// cap costs parallel load, not wall-time; broader reads close coverage gaps
// (e.g. a comparison where one entity never got a deep read).
const MAX_VISITS = 5
/** Below this many successful visits the harness tops up — no model decision. */
const MIN_GOOD_VISITS = 3
/** Adaptive deepening: how many "enough yet?" rounds may follow the first read. */
const ADAPTIVE_MAX_ROUNDS = 3
/** Pages added per adaptive round when the model wants to keep looking. */
const ADAPTIVE_BATCH = 4
/** Hard ceiling on total pages read across all rounds — latency + context guard. */
const MAX_TOTAL_VISITS = 12
const VISIT_MAX_CHARS = 20_000
/** Pages longer than this get condensed against the question; shorter clip. */
const CONDENSE_THRESHOLD = 5_000
const PER_SOURCE_CHAR_LIMIT = 1_500
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
      args: JSON.stringify({ query: job.query, max_results: RESULTS_PER_QUERY })
    })
    opts.emit.toolEvent(job.callId, 'web_search', 'start', job.query)
  }

  const settled = await Promise.all(
    jobs.map(async (job) => {
      try {
        const res = await opts.tools.search(
          {
            query: job.query,
            maxResults: RESULTS_PER_QUERY,
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
    for (const r of s.results) {
      const source = opts.sources.add(r.url, r.title || null, r.snippet)
      sourceIds.push(source.id)
      lines.push(`[${source.id}] ${r.title}\n${r.url}\n${r.snippet}`)
      if (!seen.has(r.url)) {
        seen.add(r.url)
        candidates.push({ entry: r, sourceId: source.id, queryIndex: s.job.queryIndex })
      }
    }
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

/** Pick which results to read, by source number. Failure → top-1 per query. */
async function selectCandidates(
  candidates: Candidate[],
  opts: SearchPipelineOptions
): Promise<Candidate[]> {
  if (candidates.length <= MAX_VISITS) return candidates
  const list = candidates
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
            `Pick the ${MAX_VISITS} result numbers most likely to answer the question. ` +
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
      .slice(0, MAX_VISITS)
    if (picked.length > 0) return picked
  } catch (err) {
    if (opts.signal.aborted) throw err
    log.warn(`select failed, taking top-1 per query: ${err instanceof Error ? err.message : err}`)
  }
  const byQuery = new Map<number, Candidate>()
  for (const c of candidates) {
    if (!byQuery.has(c.queryIndex)) byQuery.set(c.queryIndex, c)
  }
  return [...byQuery.values()].slice(0, MAX_VISITS)
}

// --- assess sufficiency -------------------------------------------------------------

const sufficiencyOut = z.object({
  /**
   * Reasoning first — cues the CoT lost to enable_thinking:false. OPTIONAL: the
   * grammar enforces structure but not required-presence, so a small model that
   * skips it would otherwise fail post-validation and burn a repair retry (and a
   * double miss makes assessSufficiency return null → deepening stops early).
   * No consumer reads this field.
   */
  reasoning: z.string().optional(),
  enough: z.boolean(),
  /** Gap-filling searches when more breadth is needed; empty = just read more. */
  more_queries: z.array(z.string()).default([])
})

/**
 * One constrained judgement between read batches: has enough been read to
 * answer fully, or should the harness keep looking? Failure or abort → null,
 * which the caller treats as "stop" (never loop on errors). This is the only
 * place depth is decided, and it's a single yes/no + optional queries — the
 * kind of bounded call small models stay reliable at.
 */
async function assessSufficiency(
  notes: VisitNote[],
  opts: SearchPipelineOptions
): Promise<{ enough: boolean; moreQueries: string[] } | null> {
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
            'You decide whether enough web pages have been read to answer a question ' +
            'completely and accurately, or whether more reading is needed. ' +
            'Reply with a single JSON object matching the requested schema.'
        },
        {
          role: 'user',
          content:
            `Question: ${clip(opts.question, 1000)}\n\n` +
            `Pages read so far:\n${clip(digest, 6000)}\n\n` +
            'Is this enough to answer every part of the question completely and accurately? ' +
            'Set enough=true if it is. If important parts are missing, unverified, or thin, ' +
            'set enough=false and write up to 3 short search queries that would close the ' +
            'gaps (leave more_queries empty to simply read more of what was already found).'
        }
      ],
      maxTokens: 256,
      meta: { surface: 'chat', step: 'sufficiency', conversationId: opts.conversationId },
      signal: opts.signal
    })
    return {
      enough: out.enough,
      moreQueries: [...new Set(out.more_queries.map((q) => q.trim()).filter(Boolean))].slice(0, 3)
    }
  } catch (err) {
    if (opts.signal.aborted) throw err
    log.warn(`sufficiency check failed, treating as enough: ${err instanceof Error ? err.message : err}`)
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
    for (const n of notes) {
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
  let candidates = await searchAll(queries, opts)
  if (candidates.length === 0) return null

  const visited = new Set<string>()
  const notes: VisitNote[] = []

  // First read: the best picks, with a harness top-up if too few survive — a
  // guaranteed floor (no model decision) before anyone judges sufficiency.
  const picked = await selectCandidates(candidates, opts)
  throwIfAborted(opts.signal)
  await visitBatch(picked, notes, visited, opts)
  if (notes.length < MIN_GOOD_VISITS) {
    await visitBatch(
      unvisited(candidates, visited).slice(0, MAX_VISITS - notes.length),
      notes,
      visited,
      opts
    )
  }

  // Adaptive deepening: the model judges round by round whether it has a full
  // picture; the harness keeps executing, bounded by the page ceiling.
  for (let round = 0; round < ADAPTIVE_MAX_ROUNDS && notes.length > 0; round++) {
    if (notes.length >= MAX_TOTAL_VISITS) {
      log.info(`sufficiency: reached ${MAX_TOTAL_VISITS}-page ceiling, stopping`)
      break
    }
    const verdict = await assessSufficiency(notes, opts)
    throwIfAborted(opts.signal)
    if (!verdict || verdict.enough) break

    // Broaden with the model's gap-filling queries, then deepen on the pool.
    let fresh: Candidate[] = []
    if (verdict.moreQueries.length > 0) {
      fresh = await searchAll(verdict.moreQueries, opts)
      throwIfAborted(opts.signal)
      candidates = dedupeByUrl([...candidates, ...fresh])
    }
    const budget = MAX_TOTAL_VISITS - notes.length
    // Read the gap-filling results FIRST when the model broadened: appending them
    // to the end of the pool and reading in pool order let leftover ORIGINAL
    // candidates crowd them out, so the broadening never actually read anything new.
    const order = fresh.length > 0 ? dedupeByUrl([...fresh, ...candidates]) : candidates
    const next = unvisited(order, visited).slice(0, Math.min(ADAPTIVE_BATCH, budget))
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
