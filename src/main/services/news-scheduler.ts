import type { CrispinEvent } from '@shared/ipc'
import type { NewsItem, NewsItemStatus, NewsSource, Tier } from '@shared/types'
import { TIER_ORDER, TIERS } from '@shared/model-tiers'
import type { CrispinDatabase } from './db'
import { scopedLogger } from './logger'
import type { EngineClient } from './engine-client'
import type { ToolsClient } from './tools-client'
import type { ModelService } from './model-service'
import type { AppSettingsService } from './app-settings'
import { familyOf, stripThoughts } from './chat/family'

/** Fetch-on-open: opening the News tab refreshes when the last cycle is older. */
const FRESH_MAX_AGE_MS = 15 * 60_000
const DEFAULT_ITEMS_LIMIT = 200
/** Article body budget: the visit() extraction cap and the summary prompt clip. */
const ARTICLE_MAX_CHARS = 12_000
const SUMMARY_MAX_TOKENS = 500
/** Mirrors research: determinism beats the model's recommended sampling here. */
const SUMMARY_TEMPERATURE = 0.3
const SUMMARY_PROMPT =
  'Summarize this article in exactly two sentences, then exactly three short bullet lines starting with "- ".'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

const clip = (text: string, limit: number): string =>
  text.length > limit ? `${text.slice(0, limit)}…` : text

/**
 * Cross-source dedupe key: fragment dropped, utm_* tracking params stripped,
 * host lowercased (URL parsing already normalizes it), trailing slash trimmed.
 * Null for unparseable urls — those fall back to the (source_id, guid) UNIQUE.
 */
const canonicalUrl = (raw: string | null): string | null => {
  if (!raw) return null
  try {
    const u = new URL(raw)
    u.hash = ''
    for (const key of [...u.searchParams.keys()]) {
      if (key.toLowerCase().startsWith('utm_')) u.searchParams.delete(key)
    }
    u.pathname = u.pathname.replace(/\/+$/, '')
    const text = u.toString()
    return text.endsWith('/') ? text.slice(0, -1) : text
  } catch {
    return null
  }
}

// --- row shapes ------------------------------------------------------------------

interface SourceRow {
  id: string
  kind: string
  url: string
  title: string | null
  enabled: number
  etag: string | null
  last_modified: string | null
  last_fetched_at: number | null
}

interface ItemRow {
  id: string
  source_id: string
  guid: string
  url: string | null
  title: string | null
  published_at: number | null
  extracted_text: string | null
  summary: string | null
  status: NewsItemStatus
  read_at: number | null
  image_url: string | null
  archived_at: number | null
  created_at: number
}

interface ItemListRow extends ItemRow {
  source_title: string | null
}

const rowToSource = (row: SourceRow): NewsSource => ({
  id: row.id,
  url: row.url,
  title: row.title,
  enabled: row.enabled === 1,
  lastFetchedAt: row.last_fetched_at
})

const rowToItem = (row: ItemListRow): NewsItem => ({
  id: row.id,
  sourceId: row.source_id,
  sourceTitle: row.source_title,
  url: row.url,
  title: row.title,
  publishedAt: row.published_at,
  summary: row.summary,
  status: row.status,
  readAt: row.read_at,
  imageUrl: row.image_url,
  archivedAt: row.archived_at,
  createdAt: row.created_at
})

export interface NewsSchedulerDeps {
  db: CrispinDatabase
  tools: ToolsClient
  engine: EngineClient
  modelService: ModelService
  appSettings: AppSettingsService
  broadcast: (event: CrispinEvent) => void
}

/**
 * Owns news_sources/news_items and the two background loops behind the News
 * tab: a 30-minute fetch cycle (conditional GETs through the tools sidecar,
 * canonical-url dedupe across sources) and a single-flight processing queue
 * that walks items new → extracting → pending_summary → summarized, one
 * extraction or generation at a time. Summaries run on the low tier and yield
 * entirely while an ultra-tier (noCoload) model occupies the engine — items
 * just stay pending_summary until it unloads.
 */
export class NewsScheduler {
  private readonly log = scopedLogger('news')
  private disposed = false
  /** Single-flight guards: at most one fetch cycle and one drain at a time. */
  private fetching = false
  private draining = false
  /** A kick mid-run re-runs the loop once it finishes instead of dropping it. */
  private rekick = false
  private refetch = false
  private loopAbort: AbortController | null = null
  /** Model the drain itself loaded for summaries — exempt from paused(). */
  private activeSummarizer: string | null = null
  /** Unix ms of the last fetch cycle START — ensureFresh's staleness clock. */
  private lastCycleAt = 0

  constructor(private readonly deps: NewsSchedulerDeps) {}

  /**
   * No boot or interval fetches (fetch-on-open instead, see ensureFresh):
   * init only repairs statuses and drains leftovers from the previous run.
   */
  init(): void {
    // Extractions from a previous app run died with their loop — re-queue them.
    // pending_summary needs no repair: the drain picks it up where it stood.
    this.deps.db.prepare("UPDATE news_items SET status = 'new' WHERE status = 'extracting'").run()
    this.kickProcessing()
  }

  dispose(): void {
    this.disposed = true
    // Aborts the in-flight visit/generation; statuses self-heal via init().
    this.loopAbort?.abort()
    this.loopAbort = null
  }

  /** Opening the News tab fetches — but only when the last cycle has gone stale. */
  ensureFresh(maxAgeMs = FRESH_MAX_AGE_MS): void {
    if (Date.now() - this.lastCycleAt <= maxAgeMs) return
    void this.runCycle()
  }

  /** Process leftover items without fetching — the tools-running boot hook. */
  drainPending(): void {
    this.kickProcessing()
  }

  // --- sources ----------------------------------------------------------------------

  sources(): NewsSource[] {
    const rows = this.deps.db
      .prepare('SELECT * FROM news_sources ORDER BY rowid')
      .all() as unknown as SourceRow[]
    return rows.map(rowToSource)
  }

  addSource(url: string): NewsSource {
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      throw new Error('Not a valid URL')
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('Only http(s) feed URLs are supported')
    }
    // The UNIQUE(url) constraint would catch this too — but with a worse message.
    if (this.deps.db.prepare('SELECT id FROM news_sources WHERE url = ?').get(url)) {
      throw new Error('This feed is already added')
    }
    const id = crypto.randomUUID()
    this.deps.db
      .prepare("INSERT INTO news_sources (id, kind, url, enabled) VALUES (?, 'rss', ?, 1)")
      .run(id, url)
    // Populate items and backfill the title now instead of in ≤30 minutes.
    void this.runCycle()
    return { id, url, title: null, enabled: true, lastFetchedAt: null }
  }

  updateSource(id: string, enabled: boolean): void {
    const { changes } = this.deps.db
      .prepare('UPDATE news_sources SET enabled = ? WHERE id = ?')
      .run(enabled ? 1 : 0, id)
    if (Number(changes) === 0) throw new Error(`No such news source: ${id}`)
  }

  removeSource(id: string): void {
    this.deps.db.prepare('DELETE FROM news_sources WHERE id = ?').run(id) // items cascade
    this.broadcastUpdated()
  }

  // --- items ---------------------------------------------------------------------------

  items(opts: { limit?: number; query?: string; archived?: boolean } = {}): NewsItem[] {
    const where: string[] = [
      opts.archived ? 'i.archived_at IS NOT NULL' : 'i.archived_at IS NULL'
    ]
    const params: Array<string | number> = []
    const query = opts.query?.trim()
    if (query) {
      // Literal substring match — escape LIKE's wildcards in the user's text.
      const escaped = `%${query.replace(/[\\%_]/g, (c) => `\\${c}`)}%`
      where.push(
        "(i.title LIKE ? ESCAPE '\\' OR i.summary LIKE ? ESCAPE '\\' OR i.extracted_text LIKE ? ESCAPE '\\')"
      )
      params.push(escaped, escaped, escaped)
    }
    const rows = this.deps.db
      .prepare(
        `SELECT i.*, s.title AS source_title FROM news_items i
         JOIN news_sources s ON s.id = i.source_id
         WHERE ${where.join(' AND ')}
         ORDER BY (i.read_at IS NULL) DESC, COALESCE(i.published_at, i.created_at) DESC
         LIMIT ?`
      )
      .all(...params, opts.limit ?? DEFAULT_ITEMS_LIMIT) as unknown as ItemListRow[]
    return rows.map(rowToItem)
  }

  archive(id: string): void {
    const { changes } = this.deps.db
      .prepare('UPDATE news_items SET archived_at = ? WHERE id = ? AND archived_at IS NULL')
      .run(Date.now(), id)
    if (Number(changes) > 0) this.broadcastUpdated()
  }

  archiveAll(): void {
    const { changes } = this.deps.db
      .prepare('UPDATE news_items SET archived_at = ? WHERE archived_at IS NULL')
      .run(Date.now())
    if (Number(changes) > 0) this.broadcastUpdated()
  }

  /** Full extracted article body for the reader view; stamps read_at once. */
  read(itemId: string): string | null {
    const row = this.deps.db
      .prepare('SELECT extracted_text, read_at FROM news_items WHERE id = ?')
      .get(itemId) as { extracted_text: string | null; read_at: number | null } | undefined
    if (!row) throw new Error(`No such news item: ${itemId}`)
    if (row.read_at === null) {
      this.deps.db.prepare('UPDATE news_items SET read_at = ? WHERE id = ?').run(Date.now(), itemId)
      this.broadcastUpdated()
    }
    return row.extracted_text
  }

  markAllRead(): void {
    const { changes } = this.deps.db
      .prepare('UPDATE news_items SET read_at = ? WHERE read_at IS NULL')
      .run(Date.now())
    if (Number(changes) > 0) this.broadcastUpdated()
  }

  /**
   * True while an ultra-tier (noCoload) model occupies the engine — summaries
   * wait. The drain's own summarizer is exempt: only-ultra installs fall back
   * to the ultra model, which must not pause the very loop that loaded it.
   */
  paused(): boolean {
    const ultra = new Set(TIERS.ultra.candidates)
    return this.deps.modelService
      .overview()
      .engine.models.some(
        (m) => ultra.has(m.id) && m.id !== this.activeSummarizer && m.state !== 'unloaded'
      )
  }

  // --- fetch cycle ------------------------------------------------------------------------

  /** True mid-fetch or mid-drain — guards the app-idle model unload. */
  isBusy(): boolean {
    return this.fetching || this.draining
  }

  /** Manual refresh: resolves when the fetch cycle completes (the IPC awaits it). */
  refresh(): Promise<void> {
    return this.runCycle()
  }

  private async runCycle(): Promise<void> {
    if (this.disposed) return
    // A disabled News module must not burn cycles (or model time) in the background.
    if (!this.deps.appSettings.moduleEnabled('news')) return
    if (this.fetching) {
      // A source added (or refresh hit) mid-cycle missed this run's source
      // snapshot — go again right after rather than waiting for the next open.
      this.refetch = true
      return
    }
    this.fetching = true
    try {
      // Never stamp the staleness clock before the sidecar is reachable — a
      // boot-race cycle that connection-refuses every source would otherwise
      // park fetch-on-open for 15 minutes with nothing to retry it.
      if (!(await this.waitForTools(new AbortController().signal))) return
      this.lastCycleAt = Date.now()
      const sources = this.deps.db
        .prepare('SELECT * FROM news_sources WHERE enabled = 1 ORDER BY rowid')
        .all() as unknown as SourceRow[]
      let changed = false
      if (sources.length > 0) {
        // Canonical urls of every known item — the cross-source dedupe set.
        const known = new Set<string>()
        const rows = this.deps.db
          .prepare('SELECT url FROM news_items WHERE url IS NOT NULL')
          .all() as unknown as Array<{ url: string }>
        for (const row of rows) {
          const canon = canonicalUrl(row.url)
          if (canon) known.add(canon)
        }
        for (const source of sources) {
          if (this.disposed) return
          try {
            if (await this.fetchSource(source, known)) changed = true
          } catch (err) {
            this.log.warn(
              `fetch failed for ${source.url}: ${err instanceof Error ? err.message : err}`
            )
          }
        }
      }
      if (changed) this.broadcastUpdated()
    } catch (err) {
      this.log.warn(`fetch cycle crashed: ${err instanceof Error ? err.message : err}`)
    } finally {
      this.fetching = false
    }
    this.kickProcessing()
    if (this.refetch && !this.disposed) {
      this.refetch = false
      void this.runCycle()
    }
  }

  /** One conditional fetch; true when the renderer would see something new. */
  private async fetchSource(source: SourceRow, knownUrls: Set<string>): Promise<boolean> {
    const res = await this.deps.tools.newsFetch({
      url: source.url,
      etag: source.etag,
      lastModified: source.last_modified
    })
    const now = Date.now()
    if (res.not_modified) {
      this.deps.db
        .prepare('UPDATE news_sources SET last_fetched_at = ? WHERE id = ?')
        .run(now, source.id)
      return false
    }

    // Title backfills once, from the first successful fetch — then sticks.
    this.deps.db
      .prepare(
        'UPDATE news_sources SET etag = ?, last_modified = ?, title = COALESCE(title, ?), last_fetched_at = ? WHERE id = ?'
      )
      .run(res.etag, res.last_modified, res.feed_title, now, source.id)
    const titleBackfilled = source.title === null && res.feed_title !== null

    // Topic filter: cheap keyword match over title+RSS summary, no model call.
    // Every word of a multi-word topic must appear; empty topics keep everything.
    const topics = this.deps.appSettings
      .newsTopics()
      .map((t) => t.trim().toLowerCase())
      .filter(Boolean)
    const matchesTopics = (entry: { title: string | null; summary: string | null }): boolean => {
      if (topics.length === 0) return true
      const hay = `${entry.title ?? ''} ${entry.summary ?? ''}`.toLowerCase()
      return topics.some((topic) => topic.split(/\s+/).every((word) => hay.includes(word)))
    }

    const insert = this.deps.db.prepare(
      `INSERT OR IGNORE INTO news_items (id, source_id, guid, url, title, published_at, image_url, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'new', ?)`
    )
    let inserted = 0
    for (const entry of res.entries) {
      if (!matchesTopics(entry)) continue
      const canon = canonicalUrl(entry.link)
      // The same story syndicated by another source (or re-guid'd by this one)
      // is already tracked — skip it. Re-seen guids no-op via INSERT OR IGNORE.
      if (canon && knownUrls.has(canon)) continue
      const { changes } = insert.run(
        crypto.randomUUID(),
        source.id,
        entry.guid,
        entry.link,
        entry.title,
        entry.published_ms,
        entry.image_url,
        now
      )
      if (Number(changes) > 0) {
        inserted += 1
        if (canon) knownUrls.add(canon)
      }
    }
    return inserted > 0 || titleBackfilled
  }

  // --- processing queue ----------------------------------------------------------------------

  private kickProcessing(): void {
    if (this.disposed) return
    if (this.draining) {
      this.rekick = true
      return
    }
    this.draining = true
    const controller = new AbortController()
    this.loopAbort = controller
    void this.drain(controller.signal)
      .catch((err) => {
        if (!controller.signal.aborted) {
          this.log.warn(`processing loop crashed: ${err instanceof Error ? err.message : err}`)
        }
      })
      .finally(() => {
        this.draining = false
        if (this.loopAbort === controller) this.loopAbort = null
        if (this.rekick && !this.disposed) {
          this.rekick = false
          this.kickProcessing()
        }
      })
  }

  /**
   * Extract every 'new' item, then summarize every 'pending_summary' one —
   * strictly one tools/engine call at a time. Newest first in both phases so
   * fresh stories surface before the backlog.
   */
  private async drain(signal: AbortSignal): Promise<void> {
    // The init kick races the tools sidecar spawn — wait briefly instead of
    // mass-failing extractions against a server that isn't listening yet.
    if (!(await this.waitForTools(signal))) return

    for (;;) {
      if (this.disposed || signal.aborted) return
      const item = this.nextItem('new')
      if (!item) break
      if (!item.url) {
        this.setStatus(item.id, 'failed')
        this.broadcastUpdated()
        continue
      }
      this.setStatus(item.id, 'extracting')
      try {
        const res = await this.deps.tools.visit(item.url, ARTICLE_MAX_CHARS, signal)
        this.deps.db
          .prepare(
            // og:image beats the RSS thumbnail when present (COALESCE keeps the thumb otherwise).
            "UPDATE news_items SET extracted_text = ?, title = COALESCE(title, ?), image_url = COALESCE(?, image_url), status = 'pending_summary' WHERE id = ?"
          )
          .run(res.markdown, res.title, res.image_url, item.id)
      } catch (err) {
        if (signal.aborted) return // stays 'extracting'; init() re-queues next boot
        this.log.warn(`extract failed for ${item.url}: ${err instanceof Error ? err.message : err}`)
        this.setStatus(item.id, 'failed')
      }
      this.broadcastUpdated()
    }

    // Boot race: overview() reports no models until the first installed scan lands.
    await this.deps.modelService.whenReady()
    let modelReady = false
    try {
      for (;;) {
        if (this.disposed || signal.aborted) return
        // The ultra model (noCoload) owns the whole RAM budget — never load the
        // summarizer beside it. Items stay pending; paused() tells the renderer.
        if (this.paused()) break
        const item = this.nextItem('pending_summary')
        if (!item) break
        if (!item.extracted_text) {
          this.setStatus(item.id, 'failed')
          this.broadcastUpdated()
          continue
        }
        let modelId: string
        try {
          modelId = this.resolveModel('low')
        } catch (err) {
          // No models installed: not the items' fault — they stay pending.
          this.log.warn(`summaries deferred: ${err instanceof Error ? err.message : err}`)
          break
        }
        this.activeSummarizer = modelId
        if (!modelReady) {
          if (!(await this.ensureLoaded(modelId))) break // stays pending; retried next cycle
          modelReady = true
        }
        try {
          const summary = await this.summarize(modelId, item, signal)
          if (!summary) throw new Error('the model returned an empty summary')
          this.deps.db
            .prepare("UPDATE news_items SET summary = ?, status = 'summarized' WHERE id = ?")
            .run(summary, item.id)
        } catch (err) {
          if (signal.aborted) return // stays 'pending_summary'; resumes next run
          this.log.warn(
            `summary failed for ${item.url ?? item.id}: ${err instanceof Error ? err.message : err}`
          )
          this.setStatus(item.id, 'failed') // extracted_text kept — the reader still works
        }
        this.broadcastUpdated()
      }
    } finally {
      this.activeSummarizer = null
    }
  }

  private async summarize(modelId: string, item: ItemRow, signal: AbortSignal): Promise<string> {
    const heading = item.title ? `${item.title}\n\n` : ''
    let raw = ''
    for await (const event of this.deps.engine.streamChat({
      model: modelId,
      messages: [
        {
          role: 'system',
          content: [
            'You summarize news articles faithfully and concisely.',
            this.deps.appSettings.moduleInstruction('news')
          ]
            .filter(Boolean)
            .join('\n')
        },
        {
          role: 'user',
          content: `${SUMMARY_PROMPT}\n\n${heading}${clip(item.extracted_text ?? '', ARTICLE_MAX_CHARS)}`
        }
      ],
      maxTokens: SUMMARY_MAX_TOKENS,
      temperature: SUMMARY_TEMPERATURE,
      // Thinking tokens count against max_tokens and the reasoning channel is
      // discarded here — without this the summary budget burns on thinking.
      chatTemplateKwargs: { enable_thinking: false },
      signal
    })) {
      if (event.type === 'content') raw += event.text
    }
    return stripThoughts(raw, familyOf(modelId)).trim()
  }

  /** Requested tier first, then nearest installed below, then above (mirrors chat/research). */
  private resolveModel(tier: Tier): string {
    const overview = this.deps.modelService.overview()
    const active = new Map(overview.tiers.map((t) => [t.tier, t.active]))
    const start = TIER_ORDER.indexOf(tier)
    const order = [tier, ...TIER_ORDER.slice(0, start).reverse(), ...TIER_ORDER.slice(start + 1)]
    for (const candidate of order) {
      const modelId = active.get(candidate)
      if (modelId) return modelId
    }
    throw new Error('No chat models installed — download one in the Models tab first.')
  }

  /** Load through ModelService (engine start + RAM guard); false = stay pending. */
  private async ensureLoaded(modelId: string): Promise<boolean> {
    const overview = this.deps.modelService.overview()
    const alreadyLoaded =
      overview.engine.running &&
      overview.engine.models.some((m) => m.id === modelId && m.state === 'loaded')
    if (alreadyLoaded) return true
    const res = await this.deps.modelService.load(modelId)
    if (!res.ok) {
      this.log.warn(`could not load ${modelId} (${res.reason ?? 'unknown'}) — summaries deferred`)
    }
    return res.ok
  }

  private async waitForTools(signal: AbortSignal): Promise<boolean> {
    const delays = [1000, 2000, 4000, 8000, 15000]
    for (let attempt = 0; ; attempt++) {
      if (this.disposed || signal.aborted) return false
      try {
        await this.deps.tools.healthz()
        return true
      } catch {
        if (attempt >= delays.length) return false
        await sleep(delays[attempt])
      }
    }
  }

  // --- persistence helpers ---------------------------------------------------------------------

  private nextItem(status: NewsItemStatus): ItemRow | null {
    const row = this.deps.db
      .prepare(
        `SELECT * FROM news_items WHERE status = ?
         ORDER BY COALESCE(published_at, created_at) DESC LIMIT 1`
      )
      .get(status) as ItemRow | undefined
    return row ?? null
  }

  private setStatus(itemId: string, status: NewsItemStatus): void {
    this.deps.db.prepare('UPDATE news_items SET status = ? WHERE id = ?').run(status, itemId)
  }

  private broadcastUpdated(): void {
    if (!this.disposed) this.deps.broadcast({ type: 'news.updated' })
  }
}
