import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { z } from 'zod'
import type { CrispinEvent } from '@shared/ipc'
import type {
  ResearchMode,
  ResearchRunMeta,
  ResearchSource,
  ResearchStatus,
  ResearchStep,
  ResearchStepStatus,
  ResearchStepType,
  Tier
} from '@shared/types'
import type { CrispinDatabase } from './db'
import * as settings from './settings'
import { dataDir } from './paths'
import { scopedLogger } from './logger'
import { engineModelId, type ChatCompletionMessage, type EngineClient } from './engine-client'
import type { ToolsClient, WebSearchEntry } from './tools-client'
import type { ModelService } from './model-service'
import { EMBEDDING_MODEL, type LibraryService } from './library-service'
import type { AppSettingsService } from './app-settings'
import { condense, structured } from './structured'
import { renderReportHtml, type ResearchReport } from './report-template'

const MAX_ROUNDS = 4
const MAX_QUERIES_PER_ROUND = 3
const MAX_SELECTIONS_PER_ROUND = 4
const SEARCH_RESULTS_PER_QUERY = 6
/** Pages longer than this go through the low-tier summarizer before note-taking. */
const SUMMARIZE_THRESHOLD = 24_000
const SUMMARY_CHAR_LIMIT = 1200
const ROUND_REPORT_CHAR_LIMIT = 800
const VISIT_MAX_CHARS = 60_000
/** Most recent unvisited results shown to the select step — bounds the prompt. */
const SELECT_CANDIDATE_LIMIT = 36

// Local models default to their training-data era (queries dated "2024" were
// observed live) — every prompt states today's date so searches and judgments
// target the present.
const todayLine = (): string =>
  `Today's date is ${new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}. ` +
  'Prefer recent sources, and include the current year in time-sensitive search queries.'

const SYSTEM_JSON = (): string =>
  'You are a rigorous research agent. Reply with a single JSON object that matches the ' +
  `requested schema exactly — no prose, no markdown fences. ${todayLine()}`

const clip = (text: string, limit: number): string =>
  text.length > limit ? `${text.slice(0, limit)}…` : text

// --- structured step outputs ---------------------------------------------------
// Limits live in the prompts and are clipped in code rather than enforced by
// zod: the engine's json_schema guidance is advisory (live-verified — replies
// can arrive fenced), and an over-long array should not burn the repair retry.

const planOut = z.object({
  subquestions: z.array(z.string()),
  initial_queries: z.array(z.string())
})

const selectOut = z.object({
  selections: z.array(
    z.object({
      url: z.string(),
      reason: z.string().optional(),
      /** 1-based subquestion number, as rendered in the prompt. */
      subquestion_index: z.number().optional()
    })
  )
})

const noteOut = z.object({
  claims: z.array(z.string()),
  quotes: z.array(z.string())
})

const sufficiencyOut = z.object({
  sufficient: z.boolean(),
  missing: z.array(z.string()),
  next_queries: z.array(z.string()),
  /** Heavy mode only: ≤800-char compression of what this round established. */
  round_report: z.string().optional()
})

const synthesisOut = z.object({
  title: z.string(),
  sections: z.array(
    z.object({
      heading: z.string(),
      markdown: z.string(),
      citations: z.array(z.number())
    })
  )
})

interface ResearchPlan {
  subquestions: string[]
  initial_queries: string[]
}

interface NoteRecord {
  claims: string[]
  quotes: string[]
  source_id: string
}

interface SourceRecord {
  id: string
  url: string
  title: string | null
  fetched: boolean
  /** og:image from the visit step; feeds the report hero/thumbnails. */
  imageUrl: string | null
  note: { claims: string[]; quotes: string[] } | null
}

interface RunSettings {
  collectionId: string | null
  tier: Tier | null
}

// --- row shapes ------------------------------------------------------------------

interface RunRow {
  id: string
  question: string
  mode: ResearchMode
  status: ResearchStatus
  plan: string | null
  round: number
  settings: string | null
  report_path: string | null
  created_at: number
  finished_at: number | null
}

interface StepRow {
  id: string
  run_id: string
  round: number
  seq: number
  type: ResearchStepType
  input: string | null
  output: string | null
  status: ResearchStepStatus
  started_at: number | null
  finished_at: number | null
}

interface SourceRow {
  id: string
  run_id: string
  url: string
  title: string | null
  fetched: number
  cited: number
  note: string | null
  image_url: string | null
}

const parseJson = <T>(text: string | null): T | null => {
  if (!text) return null
  try {
    return JSON.parse(text) as T
  } catch {
    return null
  }
}

const settingsOf = (row: RunRow): RunSettings => {
  const parsed = parseJson<Partial<RunSettings>>(row.settings)
  return { collectionId: parsed?.collectionId ?? null, tier: parsed?.tier ?? null }
}

const rowToMeta = (row: RunRow): ResearchRunMeta => {
  const cfg = settingsOf(row)
  return {
    id: row.id,
    question: row.question,
    mode: row.mode,
    status: row.status,
    round: row.round,
    collectionId: cfg.collectionId,
    tier: cfg.tier,
    reportPath: row.report_path,
    createdAt: row.created_at,
    finishedAt: row.finished_at
  }
}

const rowToStep = (row: StepRow): ResearchStep => ({
  id: row.id,
  runId: row.run_id,
  round: row.round,
  seq: row.seq,
  type: row.type,
  status: row.status,
  input: parseJson(row.input),
  output: parseJson(row.output),
  startedAt: row.started_at,
  finishedAt: row.finished_at
})

const rowToSource = (row: SourceRow): ResearchSource => ({
  id: row.id,
  url: row.url,
  title: row.title,
  fetched: row.fetched === 1,
  cited: row.cited === 1
})

export interface ResearchOrchestratorDeps {
  db: CrispinDatabase
  engine: EngineClient
  tools: ToolsClient
  modelService: ModelService
  library: LibraryService
  appSettings: AppSettingsService
  broadcast: (event: CrispinEvent) => void
}

/**
 * Drives research runs: a persisted, crash-resumable state machine
 * PLANNING → [SEARCH → SELECT → VISIT/NOTE → SUFFICIENCY]×≤4 → SYNTHESIS →
 * RENDER. Every transition lands in research_steps before it is broadcast, so
 * resume() can rebuild the loop's working set purely from the database.
 */
export class ResearchOrchestrator {
  private readonly active = new Map<string, AbortController>()
  private readonly log = scopedLogger('research')

  constructor(private readonly deps: ResearchOrchestratorDeps) {}

  /** App boot: anything that was mid-flight died with the previous process. */
  init(): void {
    this.deps.db
      .prepare(
        "UPDATE research_steps SET status = 'failed', finished_at = ?, output = COALESCE(output, ?) WHERE status IN ('pending', 'running')"
      )
      .run(Date.now(), JSON.stringify({ error: 'interrupted by app restart' }))
    this.deps.db
      .prepare(
        "UPDATE research_runs SET status = 'paused' WHERE status IN ('planning', 'rounds', 'synthesis')"
      )
      .run()
  }

  dispose(): void {
    // Quit aborts without touching statuses — init() pauses the rows next boot.
    for (const controller of this.active.values()) controller.abort()
    this.active.clear()
  }

  // --- entry points ---------------------------------------------------------------

  start(input: {
    question: string
    mode?: ResearchMode
    tier?: Tier
    collectionId?: string
  }): { runId: string } {
    const runId = crypto.randomUUID()
    const cfg: RunSettings = { collectionId: input.collectionId ?? null, tier: input.tier ?? null }
    this.deps.db
      .prepare(
        "INSERT INTO research_runs (id, question, mode, status, round, settings, created_at) VALUES (?, ?, ?, 'planning', 0, ?, ?)"
      )
      .run(runId, input.question, input.mode ?? 'standard', JSON.stringify(cfg), Date.now())
    this.launch(runId, this.claim(runId))
    return { runId }
  }

  /** True while any research loop is in flight — guards the app-idle unload. */
  hasActiveRuns(): boolean {
    return this.active.size > 0
  }

  /** Re-enters the loop from persisted state. Paused or failed runs only. */
  resume(runId: string): boolean {
    if (this.active.has(runId)) return false
    const run = this.getRow(runId)
    if (!run) throw new Error(`No such research run: ${runId}`)
    if (run.status === 'done' || run.status === 'cancelled') {
      throw new Error('This run already finished')
    }
    this.launch(runId, this.claim(runId))
    return true
  }

  cancel(runId: string): boolean {
    const run = this.getRow(runId)
    if (!run) return false
    const controller = this.active.get(runId)
    if (!controller && ['done', 'failed', 'cancelled'].includes(run.status)) return false
    // Terminal status first: the loop's abort handler must find nothing to do.
    this.setStatus(runId, 'cancelled', { finished: true })
    controller?.abort()
    return true
  }

  delete(runId: string): void {
    // The id is renderer-supplied and becomes an rmSync path segment: only act
    // on ids that name an existing row (always a server-generated UUID), and
    // never let a path separator anywhere near the filesystem.
    const run = this.getRow(runId)
    if (!run || basename(runId) !== runId) return
    this.active.get(runId)?.abort()
    this.active.delete(runId)
    this.deps.db.prepare('DELETE FROM research_runs WHERE id = ?').run(runId) // steps/sources cascade
    rmSync(join(dataDir(), 'reports', runId), { recursive: true, force: true })
  }

  // --- queries ----------------------------------------------------------------------

  list(): ResearchRunMeta[] {
    const rows = this.deps.db
      .prepare('SELECT * FROM research_runs ORDER BY created_at DESC')
      .all() as unknown as RunRow[]
    return rows.map(rowToMeta)
  }

  get(runId: string): { run: ResearchRunMeta; steps: ResearchStep[]; sources: ResearchSource[] } {
    const run = this.getRow(runId)
    if (!run) throw new Error(`No such research run: ${runId}`)
    const steps = this.deps.db
      .prepare('SELECT * FROM research_steps WHERE run_id = ? ORDER BY seq')
      .all(runId) as unknown as StepRow[]
    const sources = this.deps.db
      .prepare('SELECT * FROM research_sources WHERE run_id = ? ORDER BY rowid')
      .all(runId) as unknown as SourceRow[]
    return { run: rowToMeta(run), steps: steps.map(rowToStep), sources: sources.map(rowToSource) }
  }

  /** Absolute path of the rendered report.html; null before RENDER completed. */
  reportPath(runId: string): string | null {
    return this.getRow(runId)?.report_path ?? null
  }

  // --- the loop ------------------------------------------------------------------------

  private claim(runId: string): AbortController {
    if (this.active.has(runId)) throw new Error('This research run is already active')
    const controller = new AbortController()
    this.active.set(runId, controller)
    return controller
  }

  private launch(runId: string, controller: AbortController): void {
    void this.run(runId, controller).catch((err) => {
      // run() handles its own errors; this guards the handler itself.
      this.log.error(`run crashed: ${err instanceof Error ? (err.stack ?? err.message) : err}`)
      this.active.delete(runId)
    })
  }

  private async run(runId: string, controller: AbortController): Promise<void> {
    try {
      await this.execute(runId, controller.signal)
    } catch (err) {
      // Aborts own their status already: cancel()/delete() wrote it, and a
      // quit-time abort deliberately leaves the row for init() to pause.
      if (!controller.signal.aborted) {
        const message = err instanceof Error ? err.message : String(err)
        this.log.warn(`run ${runId} failed: ${message}`)
        if (this.getRow(runId)) this.setStatus(runId, 'failed', { finished: true })
      }
    } finally {
      this.active.delete(runId)
    }
  }

  private async execute(runId: string, signal: AbortSignal): Promise<void> {
    const { db } = this.deps
    const run = this.getRow(runId)
    if (!run) throw new Error(`No such research run: ${runId}`)
    const cfg = settingsOf(run)
    const heavy = run.mode === 'heavy'
    const searxngUrl = settings.get(db, 'search.searxngUrl', 'http://127.0.0.1:8080')

    let modelId: string
    try {
      const abortRejection = new Promise<never>((_, reject) => {
        const onAbort = (): void => reject(new Error('aborted'))
        if (signal.aborted) onAbort()
        else signal.addEventListener('abort', onAbort, { once: true })
      })

      // Boot race: the installed-model scan can still be in flight for the
      // first seconds after launch, and overview() would spuriously report no
      // models. Wait for the scan — Cancel still wins the race.
      await Promise.race([this.deps.modelService.whenReady(), abortRejection])
      modelId = this.resolveModel(
        cfg.tier ?? this.deps.modelService.overview().defaults.research
      )

      // A cold load can take minutes and is not itself cancellable — but Cancel
      // must release THIS run immediately (mirrors chat's ensureModelLoaded race).
      const loading = this.ensureModelLoaded(modelId)
      loading.catch(() => {}) // abandoned on abort — never an unhandled rejection
      await Promise.race([loading, abortRejection])
      if (signal.aborted) throw new Error('aborted')
    } catch (err) {
      // Pre-loop failures (no models installed, load refusal) happen before any
      // step row exists to carry the reason — synthesize a failed 'plan' step
      // so the renderer's failed-step banner shows it. Resume is unaffected:
      // plan reload keys off run.plan, and execute() only reads 'done' steps.
      if (!signal.aborted) {
        await this.step(runId, run.round, 'plan', { question: run.question }, () =>
          Promise.reject(err)
        ).catch(() => {})
      }
      throw err
    }

    // Reload persisted progress — a fresh run is just the empty case.
    const doneSteps = db
      .prepare("SELECT * FROM research_steps WHERE run_id = ? AND status = 'done' ORDER BY seq")
      .all(runId) as unknown as StepRow[]
    const outputs = <T>(type: ResearchStepType): T[] =>
      doneSteps.filter((s) => s.type === type).map((s) => JSON.parse(s.output ?? 'null') as T)

    let plan = parseJson<ResearchPlan>(run.plan)
    if (!plan) {
      this.setStatus(runId, 'planning', { round: 0 })
      plan = await this.step(runId, 0, 'plan', { question: run.question }, async () => {
        const out = await structured({
          engine: this.deps.engine,
          model: modelId,
          name: 'research_plan',
          schema: planOut,
          messages: this.planMessages(run.question),
          maxTokens: 1024,
          meta: { surface: 'research', step: 'plan', conversationId: runId },
          signal
        })
        return {
          subquestions: out.subquestions.slice(0, 6),
          initial_queries: out.initial_queries.slice(0, MAX_QUERIES_PER_ROUND + 1)
        }
      })
      db.prepare('UPDATE research_runs SET plan = ? WHERE id = ?').run(JSON.stringify(plan), runId)
    }

    const sources = this.loadSources(runId)
    const candidates = new Map<string, WebSearchEntry>()
    for (const out of outputs<{ results: WebSearchEntry[] }>('search')) {
      for (const r of out.results ?? []) {
        if (!sources.some((s) => s.url === r.url)) candidates.set(r.url, r)
      }
    }
    const pastQueries = doneSteps
      .filter((s) => s.type === 'search')
      .flatMap((s) => parseJson<{ queries: string[] }>(s.input)?.queries ?? [])
    const roundReports = outputs<z.infer<typeof sufficiencyOut>>('sufficiency')
      .map((o) => o.round_report)
      .filter((r): r is string => typeof r === 'string' && r.length > 0)

    // Where to re-enter: a finished sufficiency step pins the round; otherwise
    // restart the round the run died in (dedupe makes the replay cheap).
    const lastSuffStep = doneSteps.filter((s) => s.type === 'sufficiency').at(-1)
    const lastSynthStep = doneSteps.filter((s) => s.type === 'synthesis').at(-1)
    const lastSuff = lastSuffStep
      ? parseJson<z.infer<typeof sufficiencyOut>>(lastSuffStep.output)
      : null
    let report = outputs<ResearchReport>('synthesis').at(-1) ?? null
    let round: number
    let queries: string[]
    if (report || (lastSuffStep && (lastSuff?.sufficient || lastSuffStep.round >= MAX_ROUNDS))) {
      round = MAX_ROUNDS + 1 // straight to synthesis
      queries = []
    } else if (lastSuffStep) {
      round = lastSuffStep.round + 1
      queries = (lastSuff?.next_queries ?? []).slice(0, MAX_QUERIES_PER_ROUND)
    } else {
      round = Math.max(1, run.round)
      queries = plan.initial_queries.slice(0, MAX_QUERIES_PER_ROUND)
    }
    // Straight-to-synthesis resumes must stamp synthesis/render (and run.round)
    // with the round the run actually ended in, not MAX_ROUNDS — otherwise the
    // timeline's Synthesis group splits and run.round jumps.
    let finalRound =
      round > MAX_ROUNDS
        ? Math.max(1, lastSynthStep?.round ?? lastSuffStep?.round ?? run.round)
        : Math.max(1, Math.min(round, MAX_ROUNDS))

    // A mid-round crash leaves that round's done note steps behind; the replay
    // dedupes their sources away, so seed the first iteration's roundNotes with
    // them — otherwise heavy mode drops the pre-crash notes from the round's
    // sufficiency context (and thus its round_report) forever. No-op for fresh
    // runs and resumes that re-enter at a new round or at synthesis.
    let carriedNotes: NoteRecord[] = doneSteps
      .filter((s) => s.type === 'note' && s.round === round)
      .map((s) => parseJson<NoteRecord>(s.output))
      .filter((n): n is NoteRecord => n != null)

    for (; round <= MAX_ROUNDS && queries.length > 0; round++) {
      finalRound = round
      this.setStatus(runId, 'rounds', { round })

      // SEARCH — every query failure short of an abort just narrows the pool.
      const found = await this.step(runId, round, 'search', { queries }, async () => {
        const seen = new Set([...sources.map((s) => s.url), ...candidates.keys()])
        const results: WebSearchEntry[] = []
        for (const query of queries) {
          if (signal.aborted) throw new Error('aborted')
          try {
            const res = await this.deps.tools.search(
              { query, maxResults: SEARCH_RESULTS_PER_QUERY, backend: 'auto', searxngUrl },
              signal
            )
            for (const r of res.results) {
              if (seen.has(r.url)) continue
              seen.add(r.url)
              results.push(r)
            }
          } catch (err) {
            if (signal.aborted) throw err
            this.log.warn(`search "${query}" failed: ${err instanceof Error ? err.message : err}`)
          }
        }
        return { results }
      })
      pastQueries.push(...queries)
      for (const r of found.results) candidates.set(r.url, r)

      // SELECT — model picks ≤4 of the accumulated unvisited results.
      let selections: Array<{ url: string; reason: string; subquestion_index: number }> = []
      if (candidates.size > 0) {
        const pool = [...candidates.values()].slice(-SELECT_CANDIDATE_LIMIT)
        const picked = await this.step(
          runId,
          round,
          'select',
          { candidates: pool.length },
          async () => {
            const out = await structured({
              engine: this.deps.engine,
              model: modelId,
              name: 'select_sources',
              schema: selectOut,
              messages: this.selectMessages(run.question, plan, sources, roundReports, heavy, pool),
              maxTokens: 1024,
              meta: { surface: 'research', step: 'select', conversationId: runId },
              signal
            })
            const chosen: typeof selections = []
            for (const sel of out.selections) {
              if (!candidates.has(sel.url) || chosen.some((c) => c.url === sel.url)) continue
              const n = Math.trunc(sel.subquestion_index ?? 1)
              chosen.push({
                url: sel.url,
                reason: sel.reason ?? '',
                subquestion_index: Math.min(Math.max(n, 1), plan.subquestions.length)
              })
              if (chosen.length >= MAX_SELECTIONS_PER_ROUND) break
            }
            return { selections: chosen }
          }
        )
        selections = picked.selections
      }

      for (const sel of selections) {
        const sourceId = crypto.randomUUID()
        const title = candidates.get(sel.url)?.title ?? null
        db.prepare(
          'INSERT INTO research_sources (id, run_id, url, title, fetched, cited) VALUES (?, ?, ?, ?, 0, 0)'
        ).run(sourceId, runId, sel.url, title)
        sources.push({ id: sourceId, url: sel.url, title, fetched: false, imageUrl: null, note: null })
        candidates.delete(sel.url)
      }

      // VISIT + NOTE per source — a failed fetch skips the source, not the round.
      const roundNotes: NoteRecord[] = carriedNotes
      carriedNotes = []
      for (const sel of selections) {
        if (signal.aborted) throw new Error('aborted')
        const source = sources.find((s) => s.url === sel.url)!
        try {
          let markdown = ''
          let imageUrl: string | null = null
          const visited = await this.step(runId, round, 'visit', { url: sel.url }, async () => {
            const res = await this.deps.tools.visit(sel.url, VISIT_MAX_CHARS, signal)
            markdown = res.markdown
            imageUrl = res.image_url
            return { url: res.url, title: res.title, chars: res.markdown.length }
          })
          db.prepare(
            'UPDATE research_sources SET fetched = 1, title = COALESCE(?, title), image_url = COALESCE(?, image_url) WHERE id = ?'
          ).run(visited.title, imageUrl, source.id)
          source.fetched = true
          source.title = visited.title ?? source.title
          source.imageUrl = imageUrl ?? source.imageUrl

          const subquestion = plan.subquestions[sel.subquestion_index - 1] ?? run.question
          const note = await this.step(
            runId,
            round,
            'note',
            { url: sel.url, sourceId: source.id, subquestion },
            async () => {
              const content =
                markdown.length > SUMMARIZE_THRESHOLD
                  ? await condense({
                      engine: this.deps.engine,
                      model: this.resolveModel('low'),
                      text: markdown,
                      focus: subquestion,
                      charLimit: SUMMARY_CHAR_LIMIT,
                      meta: { surface: 'research', step: 'condense', conversationId: runId },
                      signal
                    })
                  : markdown
              const out = await structured({
                engine: this.deps.engine,
                model: modelId,
                name: 'source_notes',
                schema: noteOut,
                messages: this.noteMessages(run.question, subquestion, sel.url, content),
                maxTokens: 1200,
                meta: { surface: 'research', step: 'note', conversationId: runId },
                signal
              })
              const record: NoteRecord = {
                claims: out.claims.slice(0, 8).map((c) => clip(c, 400)),
                quotes: out.quotes.slice(0, 4).map((q) => clip(q, 400)),
                source_id: source.id
              }
              return record
            }
          )
          source.note = { claims: note.claims, quotes: note.quotes }
          db.prepare('UPDATE research_sources SET note = ? WHERE id = ?').run(
            JSON.stringify(source.note),
            source.id
          )
          roundNotes.push(note)

          if (cfg.collectionId) {
            // Fire-and-forget lancedb ingest of the visited page (docId = the
            // source row id) — failures only cost the collection a document.
            this.deps.tools
              .ragIngest({
                collectionId: cfg.collectionId,
                docId: source.id,
                markdown,
                title: source.title,
                embeddingsUrl: this.deps.library.embeddingsUrl(),
                embeddingModel: engineModelId(EMBEDDING_MODEL),
                lancedbDir: this.deps.library.lancedbDir()
              })
              .catch((err) => {
                this.log.warn(
                  `collection ingest failed for ${sel.url}: ${err instanceof Error ? err.message : err}`
                )
              })
          }
        } catch (err) {
          if (signal.aborted) throw err
          this.log.warn(`source ${sel.url} skipped: ${err instanceof Error ? err.message : err}`)
        }
      }

      // SUFFICIENCY — also compresses the round in heavy mode (round_report).
      const verdict = await this.step(runId, round, 'sufficiency', { round }, async () => {
        const out = await structured({
          engine: this.deps.engine,
          model: modelId,
          name: 'sufficiency',
          schema: sufficiencyOut,
          messages: this.sufficiencyMessages(
            run.question,
            plan,
            sources,
            roundReports,
            heavy,
            roundNotes,
            pastQueries
          ),
          maxTokens: 1500,
          meta: { surface: 'research', step: 'sufficiency', conversationId: runId },
          signal
        })
        const tried = new Set(pastQueries.map((q) => q.toLowerCase().trim()))
        return {
          sufficient: out.sufficient,
          missing: out.missing.slice(0, 6).map((m) => clip(m, 300)),
          next_queries: out.next_queries
            .filter((q) => !tried.has(q.toLowerCase().trim()))
            .slice(0, MAX_QUERIES_PER_ROUND),
          round_report: heavy ? clip(out.round_report ?? '', ROUND_REPORT_CHAR_LIMIT) : undefined
        }
      })
      if (heavy && verdict.round_report) roundReports.push(verdict.round_report)
      if (verdict.sufficient) break
      queries = verdict.next_queries
    }

    this.setStatus(runId, 'synthesis', { round: finalRound })
    const numbered = sources.filter((s) => s.fetched)
    if (!report) {
      if (numbered.length === 0) {
        throw new Error('no sources could be fetched — nothing to synthesize')
      }
      report = await this.step(runId, finalRound, 'synthesis', { sources: numbered.length }, () =>
        this.synthesize(runId, modelId, run.question, plan, sources, roundReports, heavy, signal)
      )
    }

    // Citations index report.sources (1-based) — flag the rows they resolve to.
    const cited = new Set(report.sections.flatMap((s) => s.citations))
    for (const n of cited) {
      const source = numbered[n - 1]
      if (source) {
        db.prepare('UPDATE research_sources SET cited = 1 WHERE id = ?').run(source.id)
      }
    }

    const finalReport = report
    const rendered = await this.step(
      runId,
      finalRound,
      'render',
      { title: finalReport.title },
      async () => {
        const dir = join(dataDir(), 'reports', runId)
        mkdirSync(dir, { recursive: true })
        const html = renderReportHtml(finalReport, {
          question: run.question,
          generatedAt: Date.now()
        })
        writeFileSync(join(dir, 'report.json'), JSON.stringify(finalReport, null, 2))
        writeFileSync(join(dir, 'report.html'), html)
        return { path: join(dir, 'report.html') }
      }
    )
    db.prepare(
      'UPDATE research_runs SET report_path = ?, finished_at = ? WHERE id = ?'
    ).run(rendered.path, Date.now(), runId)
    this.setStatus(runId, 'done')
  }

  // --- engine helpers ------------------------------------------------------------------
  // Structured generation lives in structured.ts now (structured()/condense());
  // research passes meta {surface:'research', step, conversationId: runId} so
  // every step lands in the llm-trace JSONL.

  /** Requested tier first, then nearest installed below, then above (shared walk). */
  private resolveModel(tier: Tier): string {
    return this.deps.modelService.resolveActiveRepo(tier)
  }

  private ensureModelLoaded(modelId: string): Promise<void> {
    return this.deps.modelService.ensureLoaded(modelId)
  }

  // --- synthesis -------------------------------------------------------------------------

  private async synthesize(
    runId: string,
    modelId: string,
    question: string,
    plan: ResearchPlan,
    sources: SourceRecord[],
    roundReports: string[],
    heavy: boolean,
    signal: AbortSignal
  ): Promise<ResearchReport> {
    const numbered = sources.filter((s) => s.fetched)
    const out = await structured({
      engine: this.deps.engine,
      model: modelId,
      name: 'research_report',
      schema: synthesisOut,
      messages: this.synthesisMessages(question, plan, numbered, roundReports, heavy),
      maxTokens: 8192,
      meta: { surface: 'research', step: 'synthesis', conversationId: runId },
      signal
    })
    // The sources array is assembled here, not by the model — the numbering is
    // ours and the urls must be exact. Citations are filtered to valid numbers.
    const reportSources = numbered.map((s, i) => ({
      id: i + 1,
      url: s.url,
      title: s.title,
      imageUrl: s.imageUrl
    }))
    return {
      title: clip(out.title, 200) || `Research: ${clip(question, 160)}`,
      sections: out.sections.slice(0, 8).map((section) => ({
        heading: clip(section.heading, 200),
        markdown: section.markdown,
        citations: [...new Set(section.citations)]
          .filter((n) => Number.isInteger(n) && n >= 1 && n <= reportSources.length)
          .sort((a, b) => a - b)
      })),
      sources: reportSources
    }
  }

  // --- prompts ------------------------------------------------------------------------------

  /** Shared JSON system prompt + the user's Settings → Instructions research line. */
  private systemJson(): string {
    const extra = [
      this.deps.appSettings.globalInstruction(),
      this.deps.appSettings.moduleInstruction('research')
    ]
      .filter(Boolean)
      .join('\n')
    return extra ? `${SYSTEM_JSON()}\n${extra}` : SYSTEM_JSON()
  }

  private planMessages(question: string): ChatCompletionMessage[] {
    return [
      { role: 'system', content: this.systemJson() },
      {
        role: 'user',
        content:
          `Research question: ${question}\n\n` +
          'Decompose the question into at most 6 focused subquestions that together cover it, ' +
          'and propose at most 4 diverse initial web search queries (short keyword phrases, no near-duplicates).'
      }
    ]
  }

  /**
   * The shared context block. Heavy mode (IterResearch) reconstructs a compact
   * workspace — question + plan + per-round compressed reports — instead of
   * replaying every raw note; standard mode carries all notes, numbered.
   */
  private workspaceText(
    question: string,
    plan: ResearchPlan,
    sources: SourceRecord[],
    roundReports: string[],
    heavy: boolean
  ): string {
    const lines = [`Research question: ${question}`, '', 'Subquestions:']
    plan.subquestions.forEach((sq, i) => lines.push(`${i + 1}. ${sq}`))
    if (heavy) {
      if (roundReports.length > 0) {
        lines.push('', 'Findings so far (compressed per completed round):')
        roundReports.forEach((r, i) => lines.push(`Round ${i + 1}: ${r}`))
      }
    } else {
      const numbered = sources.filter((s) => s.fetched)
      if (numbered.length > 0) {
        lines.push('', 'Notes so far (numbered sources):')
        numbered.forEach((s, i) => {
          lines.push(`[${i + 1}] ${s.title ?? s.url} — ${s.url}`)
          for (const claim of s.note?.claims ?? []) lines.push(`  - ${claim}`)
          for (const quote of s.note?.quotes ?? []) lines.push(`  > "${quote}"`)
        })
      }
    }
    return lines.join('\n')
  }

  private selectMessages(
    question: string,
    plan: ResearchPlan,
    sources: SourceRecord[],
    roundReports: string[],
    heavy: boolean,
    pool: WebSearchEntry[]
  ): ChatCompletionMessage[] {
    const list = pool
      .map((r) => `- url: ${r.url}\n  ${clip(r.title, 160)} — ${clip(r.snippet, 280)}`)
      .join('\n')
    return [
      { role: 'system', content: this.systemJson() },
      {
        role: 'user',
        content:
          `${this.workspaceText(question, plan, sources, roundReports, heavy)}\n\n` +
          `Unvisited search results:\n${list}\n\n` +
          `Pick the at most ${MAX_SELECTIONS_PER_ROUND} URLs most likely to fill the remaining gaps. ` +
          'Use urls EXACTLY as listed. For each give url, a short reason, and subquestion_index ' +
          '(the number of the subquestion it serves, from the list above).'
      }
    ]
  }

  private noteMessages(
    question: string,
    subquestion: string,
    url: string,
    content: string
  ): ChatCompletionMessage[] {
    return [
      { role: 'system', content: this.systemJson() },
      {
        role: 'user',
        content:
          `Research question: ${question}\n` +
          `Subquestion in focus: ${subquestion}\n\n` +
          `Content of ${url}:\n"""\n${content}\n"""\n\n` +
          'Extract up to 8 factual claims from this page that bear on the subquestion or the ' +
          'research question (each a self-contained sentence), and up to 4 short verbatim ' +
          'quotes worth citing. Empty arrays are fine when the page is irrelevant.'
      }
    ]
  }

  private sufficiencyMessages(
    question: string,
    plan: ResearchPlan,
    sources: SourceRecord[],
    roundReports: string[],
    heavy: boolean,
    roundNotes: NoteRecord[],
    pastQueries: string[]
  ): ChatCompletionMessage[] {
    const parts = [this.workspaceText(question, plan, sources, roundReports, heavy)]
    if (heavy && roundNotes.length > 0) {
      // The compact workspace omits raw notes — this round's haven't been
      // compressed yet, so they ride along for the verdict + round_report.
      const noteText = roundNotes
        .map((n) => [...n.claims.map((c) => `- ${c}`), ...n.quotes.map((q) => `> "${q}"`)].join('\n'))
        .join('\n')
      parts.push(`Notes gathered THIS round:\n${noteText}`)
    }
    if (pastQueries.length > 0) {
      parts.push(`Queries already tried:\n${pastQueries.map((q) => `- ${q}`).join('\n')}`)
    }
    parts.push(
      'Decide whether the collected findings sufficiently answer the research question.\n' +
        '- sufficient: true only when every subquestion is covered well enough to write a report.\n' +
        '- missing: what is still unknown (empty when sufficient).\n' +
        `- next_queries: at most ${MAX_QUERIES_PER_ROUND} NEW web search queries targeting the gaps, ` +
        'different from the queries already tried (empty when sufficient).' +
        (heavy
          ? `\n- round_report: at most ${ROUND_REPORT_CHAR_LIMIT} characters compressing what THIS round established (always required).`
          : '')
    )
    return [
      { role: 'system', content: this.systemJson() },
      { role: 'user', content: parts.join('\n\n') }
    ]
  }

  private synthesisMessages(
    question: string,
    plan: ResearchPlan,
    numbered: SourceRecord[],
    roundReports: string[],
    heavy: boolean
  ): ChatCompletionMessage[] {
    const sourceList = numbered
      .map((s, i) => `[${i + 1}] ${s.title ?? s.url} — ${s.url}`)
      .join('\n')
    const findings = heavy
      ? `Findings (compressed per round):\n${roundReports.map((r, i) => `Round ${i + 1}: ${r}`).join('\n')}\n\nNumbered sources:\n${sourceList}`
      : this.workspaceText(question, plan, numbered, roundReports, false)
    return [
      { role: 'system', content: this.systemJson() },
      {
        role: 'user',
        content:
          `Research question: ${question}\n\n${findings}\n\n` +
          'Write the final research report as JSON.\n' +
          '- title: a concise report title.\n' +
          '- sections: 3 to 6 sections; each has heading, markdown (paragraphs, "- " bullet lists, ' +
          '**bold**, *italic*, `code`, [text](url) links), and citations (the source numbers the section draws on).\n' +
          '- Cite sources inline in the markdown as [n] using the numbers above; cite only listed numbers.\n' +
          '- Be specific and factual; prefer claims backed by the notes.'
      }
    ]
  }

  // --- persistence helpers ---------------------------------------------------------------------

  /**
   * One persisted step: row inserted as 'running' and broadcast, then updated
   * to done/failed with output and broadcast again. seq is per-run monotonic.
   */
  private async step<T>(
    runId: string,
    round: number,
    type: ResearchStepType,
    input: unknown,
    fn: () => Promise<T>
  ): Promise<T> {
    const id = crypto.randomUUID()
    const seq = (
      this.deps.db
        .prepare('SELECT COALESCE(MAX(seq), -1) + 1 AS seq FROM research_steps WHERE run_id = ?')
        .get(runId) as { seq: number }
    ).seq
    this.deps.db
      .prepare(
        "INSERT INTO research_steps (id, run_id, round, seq, type, input, status, started_at) VALUES (?, ?, ?, ?, ?, ?, 'running', ?)"
      )
      .run(id, runId, round, seq, type, JSON.stringify(input ?? null), Date.now())
    this.broadcastStep(id)
    try {
      const output = await fn()
      this.deps.db
        .prepare("UPDATE research_steps SET output = ?, status = 'done', finished_at = ? WHERE id = ?")
        .run(JSON.stringify(output ?? null), Date.now(), id)
      this.broadcastStep(id)
      return output
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.deps.db
        .prepare("UPDATE research_steps SET output = ?, status = 'failed', finished_at = ? WHERE id = ?")
        .run(JSON.stringify({ error: message }), Date.now(), id)
      this.broadcastStep(id)
      throw err
    }
  }

  private broadcastStep(stepId: string): void {
    const row = this.deps.db
      .prepare('SELECT * FROM research_steps WHERE id = ?')
      .get(stepId) as StepRow | undefined
    if (!row) return
    this.deps.broadcast({ type: 'research.step', runId: row.run_id, step: rowToStep(row) })
  }

  private setStatus(
    runId: string,
    status: ResearchStatus,
    opts: { round?: number; finished?: boolean } = {}
  ): void {
    const sets = ['status = ?']
    const values: Array<string | number> = [status]
    if (opts.round !== undefined) {
      sets.push('round = ?')
      values.push(opts.round)
    }
    if (opts.finished) {
      sets.push('finished_at = ?')
      values.push(Date.now())
    }
    this.deps.db
      .prepare(`UPDATE research_runs SET ${sets.join(', ')} WHERE id = ?`)
      .run(...values, runId)
    const row = this.getRow(runId)
    if (row) {
      this.deps.broadcast({ type: 'research.status', runId, status, round: row.round })
    }
  }

  private getRow(runId: string): RunRow | null {
    const row = this.deps.db.prepare('SELECT * FROM research_runs WHERE id = ?').get(runId) as
      | RunRow
      | undefined
    return row ?? null
  }

  private loadSources(runId: string): SourceRecord[] {
    const rows = this.deps.db
      .prepare('SELECT * FROM research_sources WHERE run_id = ? ORDER BY rowid')
      .all(runId) as unknown as SourceRow[]
    return rows.map((r) => ({
      id: r.id,
      url: r.url,
      title: r.title,
      fetched: r.fetched === 1,
      imageUrl: r.image_url,
      note: parseJson<{ claims: string[]; quotes: string[] }>(r.note)
    }))
  }
}
