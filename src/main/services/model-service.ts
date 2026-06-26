import type { CrispinEvent } from '@shared/ipc'
import type {
  DownloadInfo,
  DownloadState,
  EngineModelInfo,
  EngineStatus,
  Feature,
  FeatureDefaults,
  HFSearchResult,
  InstalledModel,
  ModelSampling,
  ModelsOverview,
  Tier,
  TierResolution
} from '@shared/types'
import {
  EMBEDDING_MODEL,
  FEATURE_DEFAULTS,
  TIERS,
  TIER_ORDER,
  canonicalRepoId,
  candidateWarning,
  classifyByParams,
  estimateGB,
  familyOf,
  fitFor,
  isCuratedRepo,
  kvQuantBitsFor,
  tierOfRepo,
  tierSpecFor,
  validateModelRepo
} from '@shared/model-tiers'
import type { CrispinDatabase } from './db'
import * as settings from './settings'
import type { AppSettingsService } from './app-settings'
import { writeEngineConfig, omlxCacheDir, type EngineConfigModel } from './engine-config'
import { evictableLoaded } from './engine-eviction'
import { embedderDiscoverAction } from './embedder-discovery'
import type { EngineClient } from './engine-client'
import type { RamGuard } from './ram-guard'
import type { ProcessManager } from './process-manager'
import type { DownloadJobData, ToolsClient } from './tools-client'
import { scopedLogger } from './logger'
import { readdirSync, rmSync, statSync, type Dirent } from 'node:fs'
import { join } from 'node:path'

const DOWNLOAD_POLL_MS = 500
const ENGINE_POLL_MS = 2500
const ENGINE_START_TIMEOUT_MS = 180_000
/** First-ingest embedder rediscovery waits up to this long for the engine to go
 *  idle before restarting — it must never restart mid-generation (F2). */
const EMBEDDER_DISCOVER_WAIT_MS = 180_000
/**
 * Weights on disk ≈ weights in memory at 4-bit; +10% for runtime overhead.
 * Deliberately NOT higher: the ultra tier (~16.5 GB on disk) must still fit
 * the 18.5 GB budget after full eviction, and KV growth is bounded by the
 * engine's --memory-guard-gb process-memory enforcer, not this estimate.
 */
const MEMORY_OVERHEAD = 1.1

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const round2 = (n: number): number => Math.round(n * 100) / 100

/** Recursive byte total of a directory; 0 when it doesn't exist yet. */
function dirSizeBytes(dir: string): number {
  let entries: Dirent[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return 0
  }
  let total = 0
  for (const entry of entries) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) total += dirSizeBytes(p)
    else {
      try {
        total += statSync(p).size
      } catch {
        /* file vanished mid-walk — ignore */
      }
    }
  }
  return total
}

/**
 * Order-insensitive fingerprint of a registry — drives restart decisions.
 * ttlSeconds is deliberately excluded: the TTL backstop follows the idle-unload
 * knob, and changing that knob must never force an engine restart — the new
 * value simply rides the next natural spawn (command() rewrites the config).
 */
const registryKey = (entries: EngineConfigModel[]): string =>
  JSON.stringify(
    entries
      .map((e): [string, number] => [e.name, e.maxTokens])
      .sort((a, b) => a[0].localeCompare(b[0]))
  )

/**
 * Resolve TurboQuant KV-cache bits for a registry entry. The `engine.kvQuant`
 * settings override wins — 'off' disables everywhere, '4'/'8' forces that width
 * — while 'auto' (the default) defers to the per-tier policy. Null = full-
 * precision KV. Deliberately NOT part of registryKey: like ttlSeconds, a quant
 * change must not force a mid-session restart — it rides the next natural spawn.
 */
const resolveKvQuantBits = (
  override: string,
  repoId: string,
  sizeBytes: number
): number | null => {
  if (override === 'off') return null
  if (override === '4' || override === '8') return Number(override)
  return kvQuantBitsFor(repoId, sizeBytes)
}

interface DownloadRow {
  id: string
  repo_id: string
  status: DownloadState
  bytes_done: number
  bytes_total: number | null
  error: string | null
  started_at: number | null
  finished_at: number | null
}

const rowToDownload = (row: DownloadRow): DownloadInfo => ({
  id: row.id,
  repoId: row.repo_id,
  status: row.status,
  bytesDone: row.bytes_done,
  bytesTotal: row.bytes_total,
  error: row.error,
  startedAt: row.started_at ?? 0,
  finishedAt: row.finished_at
})

export interface ModelServiceDeps {
  db: CrispinDatabase
  tools: ToolsClient
  engine: EngineClient
  ramGuard: RamGuard
  processManager: ProcessManager
  appSettings: AppSettingsService
  /** Current allocated engine port; 0 before the first spawn. */
  getEnginePort: () => number
  /** Unix ms of the last renderer activity ping — feeds the idle sweep. */
  getLastAppActivityAt: () => number
  /** Idle-sweep guards: never unload under active background work. */
  isResearchActive: () => boolean
  isNewsBusy: () => boolean
  /** True while a RAG ingest is embedding — protects the embedder from eviction. */
  isLibraryIngesting: () => boolean
  broadcast: (event: CrispinEvent) => void
}

/** Owns model downloads, the engine registry, and load/unload orchestration. */
export class ModelService {
  private installed: InstalledModel[] = []
  private engineModels: EngineModelInfo[] = []
  private lastEngineKey = ''
  /** Fingerprint of the last installed scan — drives models.installedChanged. */
  private lastInstalledKey = ''
  /** Registry fingerprint the running engine was spawned with. */
  private appliedRegistryKey: string | null = null
  private pendingRegistryRestart = false
  /** downloadId → tools job id, for every download we're actively polling. */
  private readonly activeDownloads = new Map<string, string>()
  /** downloadIds the user paused — kept resumable; the poller maps them to 'paused'. */
  private readonly pausedDownloads = new Set<string>()
  /**
   * repoId → in-flight startDownload. Set synchronously before any await:
   * the dedup SELECT below can't see a sibling call that hasn't INSERTed its
   * row yet, and the upstream existence probe stretches that window to
   * seconds — a double-click must join, not race a duplicate snapshot job.
   */
  private readonly startingDownloads = new Map<string, Promise<string>>()
  private pollTimer: ReturnType<typeof setInterval> | null = null
  private tick = 0
  /** Consecutive /v1/models/status failures — see pollTick's stale-state guard. */
  private modelsPollFailures = 0
  /** Single-flight latch for the engine poller — see pollTick. */
  private polling = false
  private disposed = false
  /** Serializes load() across surfaces — see load(). */
  private loadChain: Promise<unknown> = Promise.resolve()
  private readonly log = scopedLogger('models')
  /** Resolved once init()'s first installed-model scan has finished (see whenReady). */
  private resolveReady!: () => void
  private readonly ready = new Promise<void>((resolve) => {
    this.resolveReady = resolve
  })

  constructor(private readonly deps: ModelServiceDeps) {}

  /**
   * Resolves once the boot-time installed scan (init's backoff loop) has
   * completed — before that, overview() reports an empty installed set even
   * when models exist on disk. Callers racing app boot await this first.
   */
  whenReady(): Promise<void> {
    return this.ready
  }

  async init(): Promise<void> {
    // Downloads from a previous app run died with their sidecar — surface that.
    this.deps.db
      .prepare(
        "UPDATE model_downloads SET status = 'failed', error = 'interrupted by app restart', finished_at = ? WHERE status IN ('queued', 'downloading')"
      )
      .run(Date.now())

    // The tools sidecar may still be booting; retry the first scan with backoff.
    const delays = [1000, 2000, 4000, 8000, 15000]
    try {
      for (let attempt = 0; ; attempt++) {
        try {
          await this.refreshInstalled()
          break
        } catch (err) {
          if (this.disposed) return
          if (attempt >= delays.length) {
            this.log.warn(`local model scan failed: ${err instanceof Error ? err.message : err}`)
            break
          }
          await sleep(delays[attempt])
        }
      }
    } finally {
      // Even a failed or shutdown-interrupted scan unblocks whenReady() —
      // waiters proceed against whatever installed set exists.
      this.resolveReady()
    }
    await this.syncEngineRegistry()
    this.startPoller()
  }

  dispose(): void {
    this.disposed = true
    if (this.pollTimer) clearInterval(this.pollTimer)
    this.pollTimer = null
    this.activeDownloads.clear()
  }

  // --- installed models / registry -----------------------------------------

  async refreshInstalled(): Promise<InstalledModel[]> {
    const { models } = await this.deps.tools.localModels()
    // The embedder is library plumbing, not a chat model: it must never enter
    // the chat registry, the Models tab, or registryKey.
    this.installed = models
      .filter((m) => m.repo_id !== EMBEDDING_MODEL && !this.phantomPartial(m.repo_id))
      .map((m) => ({
        repoId: m.repo_id,
        sizeBytes: m.size_bytes,
        lastModifiedAt: m.last_modified_ms,
        contextLength: m.context_length,
        sampling: m.sampling
          ? { temperature: m.sampling.temperature, topP: m.sampling.top_p, topK: m.sampling.top_k }
          : null
      }))
    // The renderer's one-shot overview fetch can race the first scan — push a
    // change signal so it refetches instead of caching a stale installed set.
    const key = JSON.stringify(this.installed)
    if (key !== this.lastInstalledKey) {
      this.lastInstalledKey = key
      if (!this.disposed) this.deps.broadcast({ type: 'models.installedChanged' })
    }
    return this.installed
  }

  /** Context window of an installed model; null when not installed or unknown. */
  contextLengthFor(repoId: string): number | null {
    return this.installed.find((m) => m.repoId === repoId)?.contextLength ?? null
  }

  /** The model's own recommended sampling; null when not installed or unknown. */
  samplingFor(repoId: string): ModelSampling | null {
    return this.installed.find((m) => m.repoId === repoId)?.sampling ?? null
  }

  /** True when the chat registry would be non-empty (the embedder never counts). */
  hasRegistryModels(): boolean {
    return this.installed.length > 0
  }

  /**
   * A cancelled/failed fresh download leaves a partial snapshot the cache scan
   * cannot tell from a complete repo (hf unlinks its .incomplete temps on a
   * graceful abort) — but the download history can: rows exist for the repo
   * and none ever finished. deleteModel purges the repo's rows, so a stale
   * 'done' from before a delete can't mask a later partial.
   */
  private phantomPartial(repoId: string): boolean {
    const row = this.deps.db
      .prepare(
        "SELECT COUNT(*) AS total, COALESCE(SUM(status = 'done'), 0) AS done FROM model_downloads WHERE repo_id = ?"
      )
      .get(repoId) as { total: number; done: number } | undefined
    return !!row && row.total > 0 && row.done === 0
  }

  /**
   * Engine-side TTL is a pure BACKSTOP behind the main-side app-idle sweep
   * (maybeIdleUnload, driven by `models.idleUnloadSeconds`): strictly larger
   * (max(base, knob×4)) so the two mechanisms never fight over a model.
   * 0 in `engine.autoUnloadIdleSeconds` still disables the engine TTL outright.
   */
  private backstopTtlSeconds(): number | null {
    const base = settings.get(this.deps.db, 'engine.autoUnloadIdleSeconds', 1800)
    if (base <= 0) return null
    return Math.max(base, this.deps.appSettings.idleUnloadSeconds() * 4)
  }

  private registryEntries(): EngineConfigModel[] {
    const ttlSeconds = this.backstopTtlSeconds()
    const kvOverride = settings.get(this.deps.db, 'engine.kvQuant', 'auto')
    return this.installed.map((m) => {
      const spec = tierSpecFor(m.repoId)
      return {
        name: m.repoId,
        // Output budget: ultra is capped, small models run ctx-bounded.
        maxTokens: spec?.maxOutputTokens ?? m.contextLength ?? 32768,
        ttlSeconds,
        kvQuantBits: resolveKvQuantBits(kvOverride, m.repoId, m.sizeBytes)
      }
    })
  }

  private writeConfig(port: number): EngineConfigModel[] {
    const entries = this.registryEntries()
    writeEngineConfig({
      port,
      // The embedder is pool-resident under oMLX like any model — give it the
      // same idle TTL so RAG use doesn't pin its RAM until app quit. Kept out
      // of `entries` so the restart fingerprint and empty-registry semantics
      // stay chat-model-only (maxTokens is inert for an embeddings model).
      models: [
        ...entries,
        // The embedder has no decode KV cache to quantize — always full precision.
        { name: EMBEDDING_MODEL, maxTokens: 1, ttlSeconds: this.backstopTtlSeconds(), kvQuantBits: null }
      ],
      budgetGB: this.deps.ramGuard.report(0).budgetGB,
      // Crispin owns the paged SSD KV-cache: a fixed dir under app-data and a
      // hard cap, instead of oMLX's "auto" (≈10% of free disk on ~/.omlx/cache).
      cacheDir: omlxCacheDir(),
      cacheMaxSizeGB: settings.get(this.deps.db, 'engine.ssdCacheMaxGB', 8)
    })
    return entries
  }

  /** Called from the engine ManagedProcess command() at every spawn. */
  writeConfigForSpawn(port: number): void {
    this.appliedRegistryKey = registryKey(this.writeConfig(port))
  }

  /**
   * Reconcile the engine with what's installed. Restarts are cheap in lazy
   * registry mode (nothing reloads until requested) — but never mid-generation.
   */
  async syncEngineRegistry(): Promise<void> {
    // Never (re)start the engine during shutdown — before-quit already tore
    // the process group down; a late start() here would orphan a new one.
    if (this.disposed) return
    const entries = this.registryEntries()
    // Port here is a placeholder; command() rewrites with the real one at spawn.
    this.writeConfig(this.deps.getEnginePort())

    const engine = this.deps.processManager.get('engine')
    if (!engine) return
    const state = engine.snapshot().state

    // 'failed' is also a start point: a registry change (new download) is the
    // cue to retry an engine that crash-looped earlier.
    // Engine start/stop/restart go through exclusive() so they serialize with
    // loads + cacheClear and hold the generation barrier. Finding C: this was the
    // off-chain mutator that raced cacheClear's rmSync (download-complete restart).
    if (state === 'stopped' || state === 'failed') {
      // The engine never starts with an empty registry — nothing to serve.
      if (entries.length === 0) return
      await this.exclusive(0, () => engine.start().then(() => ({ ok: true as const })))
      return
    }

    // An empty registry can't be respawned (run_engine.py exits 2 on it, and
    // backoff would crash-loop into 'failed') — stop is the terminal state.
    if (entries.length === 0) {
      // Stop FIRST; commit the state clears only if the drain actually let us stop.
      // On refusal (a generation still in flight on the just-deleted model) defer
      // like the restart branch below, so pollTick retries the stop once idle —
      // otherwise the engine is left running with a wrongly-null registry and no retry.
      const stopped = await this.exclusive(0, () => engine.stop().then(() => ({ ok: true as const })))
      if (!stopped.ok) {
        this.pendingRegistryRestart = true
        return
      }
      this.pendingRegistryRestart = false
      this.appliedRegistryKey = null
      this.engineModels = []
      return
    }

    if (registryKey(entries) === this.appliedRegistryKey) return

    const restarted = await this.exclusive(0, () =>
      engine.restart('model registry changed').then(() => ({ ok: true as const }))
    )
    if (!restarted.ok) {
      // Toast only on the transition into 'deferred' — pollTick re-attempts this
      // every idle tick, so re-broadcasting each time spams identical warns.
      if (!this.pendingRegistryRestart) {
        this.deps.broadcast({
          type: 'system.toast',
          level: 'warn',
          message: 'Model registry changed — engine restart deferred until it is idle.'
        })
      }
      this.pendingRegistryRestart = true
    }
  }

  /** True when no request is in flight and no model is mid-load. */
  private async engineIdle(): Promise<boolean> {
    try {
      const status = await this.deps.engine.status()
      if ((status.numRunning ?? 0) > 0) return false
      return !this.engineModels.some((m) => m.state === 'loading')
    } catch {
      return false // unreachable counts as busy — never yank blindly
    }
  }

  // --- downloads ------------------------------------------------------------

  async startDownload(repoId: string, force = false): Promise<string> {
    const inFlight = this.startingDownloads.get(repoId)
    if (inFlight) return inFlight
    const task = this.doStartDownload(repoId, force)
    this.startingDownloads.set(repoId, task)
    try {
      return await task
    } finally {
      this.startingDownloads.delete(repoId)
    }
  }

  private async doStartDownload(repoId: string, force: boolean): Promise<string> {
    if (!force) {
      const verdict = validateModelRepo(repoId)
      if (!verdict.ok) throw new Error(verdict.warning)
    }
    // One active download per repo — a second click joins the existing one
    // instead of racing a duplicate snapshot_download job on the same cache.
    const existing = this.deps.db
      .prepare(
        "SELECT id FROM model_downloads WHERE repo_id = ? AND status IN ('queued', 'downloading') ORDER BY started_at DESC LIMIT 1"
      )
      .get(repoId) as { id: string } | undefined
    if (existing && this.activeDownloads.has(existing.id)) return existing.id
    // After the local dedup: the join path must never pay a network probe.
    await this.assertRepoExists(repoId)
    // A fresh attempt supersedes any paused/cancelled/failed history for this
    // repo — purge it so the card and panel don't show a stale resumable partial
    // next to the new download (a resume reuses the on-disk partial regardless).
    this.deps.db
      .prepare(
        "DELETE FROM model_downloads WHERE repo_id = ? AND status IN ('paused', 'cancelled', 'failed')"
      )
      .run(repoId)
    const { job_id } = await this.deps.tools.downloadModel(repoId)
    const download: DownloadInfo = {
      id: crypto.randomUUID(),
      repoId,
      status: 'queued',
      bytesDone: 0,
      bytesTotal: null,
      error: null,
      startedAt: Date.now(),
      finishedAt: null
    }
    this.deps.db
      .prepare(
        'INSERT INTO model_downloads (id, repo_id, job_id, status, started_at) VALUES (?, ?, ?, ?, ?)'
      )
      .run(download.id, repoId, job_id, download.status, download.startedAt)
    this.activeDownloads.set(download.id, job_id)
    this.deps.broadcast({ type: 'models.downloadProgress', download })
    void this.pollDownload(download, job_id)
    return download.id
  }

  /**
   * Fail fast on a repo id that doesn't exist upstream — the 0.20.0 Qwen 4B
   * typo shipped because nothing checked until the sidecar job failed seconds
   * later with an opaque error. Anonymous HF requests answer 401 for BOTH
   * missing and private repos (anti-enumeration; live-verified — there is no
   * anonymous 404), and neither is downloadable without a token, so 401 is
   * the fail-fast signal; gated-but-public repos answer 200. Anything else
   * (offline, 5xx, 429) defers to the download job as the authority.
   */
  private async assertRepoExists(repoId: string): Promise<void> {
    let status: number
    try {
      const res = await fetch(`https://huggingface.co/api/models/${repoId}`, {
        method: 'HEAD',
        signal: AbortSignal.timeout(4000)
      })
      status = res.status
    } catch {
      return
    }
    if (status === 401 || status === 404) {
      throw new Error(`${repoId} was not found on Hugging Face (or is private) — check the repo id.`)
    }
  }

  private async pollDownload(download: DownloadInfo, jobId: string): Promise<void> {
    let consecutiveErrors = 0
    while (this.activeDownloads.has(download.id)) {
      await sleep(DOWNLOAD_POLL_MS)
      // dispose() can't interrupt an iteration already in flight — bail before
      // touching the DB or spawning anything during shutdown.
      if (this.disposed) return
      let next: DownloadInfo
      try {
        const job = await this.deps.tools.job<DownloadJobData>(jobId)
        consecutiveErrors = 0
        next = {
          ...download,
          status: job.status === 'running' ? 'downloading' : job.status,
          bytesDone: job.data?.bytes_done ?? download.bytesDone,
          bytesTotal: job.data?.bytes_total ?? download.bytesTotal,
          error: job.error ?? null,
          finishedAt: job.status === 'running' ? null : Date.now()
        }
      } catch {
        // Tolerate blips; the job dies with the sidecar, so give up eventually.
        if (++consecutiveErrors < 20) continue
        next = { ...download, status: 'failed', error: 'lost contact with the tools sidecar', finishedAt: Date.now() }
      }

      // A user-initiated pause stops the same way a cancel does (the subprocess
      // is terminated), but keeps the resumable partial — surface it as 'paused'.
      if (next.status === 'cancelled' && this.pausedDownloads.has(download.id)) {
        next = { ...next, status: 'paused', finishedAt: null }
      }

      const changed = JSON.stringify(next) !== JSON.stringify(download)
      if (changed) {
        download = next
        // DB row first: phantomPartial() judges a repo by its download rows,
        // so the 'done' row must exist before refreshInstalled() scans.
        this.deps.db
          .prepare(
            'UPDATE model_downloads SET status = ?, bytes_done = ?, bytes_total = ?, error = ?, finished_at = ? WHERE id = ?'
          )
          .run(next.status, next.bytesDone, next.bytesTotal, next.error, next.finishedAt, next.id)
      }

      // The renderer refetches the whole overview the moment it sees a 'done'
      // broadcast — installed/registry must already be fresh by then, or it
      // caches an overview without the finished model and nothing re-pushes it.
      if (next.status === 'done' && !this.disposed) {
        try {
          await this.refreshInstalled()
          await this.syncEngineRegistry()
        } catch (err) {
          // A sidecar blip must not suppress the terminal broadcast.
          this.log.warn(
            `refresh after download failed: ${err instanceof Error ? err.message : err}`
          )
        }
      }

      if (changed) this.deps.broadcast({ type: 'models.downloadProgress', download: next })

      if (next.status !== 'queued' && next.status !== 'downloading') {
        this.activeDownloads.delete(download.id)
        this.pausedDownloads.delete(download.id)
        return
      }
    }
  }

  /**
   * Pause (deletePartial=false): stop the download but keep the resumable
   * partial; the poll loop marks the row 'paused'. Cancel (deletePartial=true,
   * the UI's "X"): stop, wait for the subprocess to actually die, then delete
   * the partial from the cache and purge its history so it shows as a fresh
   * download, not a resumable one.
   */
  async cancelDownload(downloadId: string, deletePartial = false): Promise<boolean> {
    const jobId = this.activeDownloads.get(downloadId)
    if (jobId) {
      if (!deletePartial) {
        this.pausedDownloads.add(downloadId)
        const { ok } = await this.deps.tools.cancelJob(jobId)
        return ok
      }
      // Removing it from activeDownloads stops the poller from finalizing it.
      this.activeDownloads.delete(downloadId)
      this.pausedDownloads.delete(downloadId)
      const repoId = this.downloadRepoId(downloadId)
      await this.deps.tools.cancelJob(jobId)
      await this.waitJobTerminal(jobId)
      await this.deleteDownloadArtifacts(repoId)
      return true
    }
    // Not actively polled (a paused or stale row).
    const row = this.deps.db
      .prepare('SELECT * FROM model_downloads WHERE id = ?')
      .get(downloadId) as DownloadRow | undefined
    if (!row || row.status === 'done') return false
    if (deletePartial) {
      await this.deleteDownloadArtifacts(row.repo_id)
      return true
    }
    this.deps.db
      .prepare("UPDATE model_downloads SET status = 'paused', finished_at = NULL WHERE id = ?")
      .run(downloadId)
    this.deps.broadcast({
      type: 'models.downloadProgress',
      download: rowToDownload({ ...row, status: 'paused', finished_at: null })
    })
    return true
  }

  private downloadRepoId(downloadId: string): string | null {
    const row = this.deps.db
      .prepare('SELECT repo_id FROM model_downloads WHERE id = ?')
      .get(downloadId) as { repo_id: string } | undefined
    return row?.repo_id ?? null
  }

  /** Wait (bounded) for a tools job to leave 'running' — i.e. its subprocess to die. */
  private async waitJobTerminal(jobId: string): Promise<void> {
    const deadline = Date.now() + 20_000
    while (Date.now() < deadline) {
      if (this.disposed) return
      try {
        const job = await this.deps.tools.job(jobId)
        if (job.status !== 'running') return
      } catch {
        return // job gone / sidecar blip — treat as terminal
      }
      await sleep(300)
    }
  }

  /**
   * Delete a repo's (partial or complete) weights from the cache and purge its
   * download history, so it surfaces as a fresh "Download" rather than a
   * resumable partial. Best-effort: a 404 means nothing reached the cache.
   */
  private async deleteDownloadArtifacts(repoId: string | null): Promise<void> {
    if (!repoId) return
    await this.deps.tools.deleteModel(repoId).catch(() => {})
    this.deps.db.prepare('DELETE FROM model_downloads WHERE repo_id = ?').run(repoId)
    await this.refreshInstalled().catch(() => {})
    if (!this.disposed) this.deps.broadcast({ type: 'models.installedChanged' })
  }

  // --- load / unload ----------------------------------------------------------

  /**
   * Serialize loads across every surface (chat/agent/research/news + the
   * explicit Models-tab load). doLoad()'s judge → evict → re-judge → warm
   * sequence is a read-modify-write over engineModels + system memory; two
   * concurrent loads could each decide "fits after eviction" and warm past the
   * RAM budget. Queue them through one chain instead.
   */
  async load(repoId: string, force = false): Promise<{ ok: boolean; reason?: string }> {
    return this.enqueue(() => this.doLoad(repoId, force))
  }

  /**
   * Run an engine-mutating op on the shared load chain. Anything that stops,
   * starts, or restarts the engine (loads, the cache clear) must serialize here
   * so it can't interleave with doLoad's judge→evict→warm or another op's
   * stop→start (see load()'s NB and cacheClear).
   */
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.loadChain.then(task, task)
    this.loadChain = run.catch(() => {})
    return run
  }

  /**
   * Run an engine-DESTRUCTIVE op (restart / stop / per-model unload) under a
   * generation barrier: raise the drain gate so engine-client parks any NEW
   * streamChat/chat, then wait up to drainMs for in-flight generations to finish.
   * Returns the op's result, or {ok:false,reason} if a generation won't drain.
   * The gate — not a sampled engineIdle() probe — is what makes "no generation
   * runs during the mutation" airtight: nothing new can start once it is up.
   * Use from a caller ALREADY on the load chain (inside doLoad); top-level callers
   * use exclusive() to also serialize against other lifecycle ops.
   */
  private async withDrain<T>(
    drainMs: number,
    fn: () => Promise<T>
  ): Promise<T | { ok: false; reason: string }> {
    this.deps.engine.setDraining(true)
    try {
      if (!(await this.drained(drainMs))) {
        return { ok: false, reason: 'The engine is busy — wait for the generation to finish.' }
      }
      return await fn()
    } finally {
      this.deps.engine.setDraining(false)
    }
  }

  /** enqueue + withDrain: the top-level form for callers not already on the chain. */
  private async exclusive<T>(
    drainMs: number,
    fn: () => Promise<T>
  ): Promise<T | { ok: false; reason: string }> {
    return this.enqueue(() => this.withDrain(drainMs, fn))
  }

  /**
   * Wait (bounded) for every in-flight generation to finish. With the drain gate
   * up no new one can start, so this converges. Reads the engine's own /api/status
   * (active + waiting, incl. opencode traffic that bypasses this client) so a
   * server-side generation the TS inflight counter can't see still blocks the op.
   */
  private async drained(deadlineMs: number): Promise<boolean> {
    const deadline = Date.now() + deadlineMs
    for (;;) {
      let running: number
      try {
        running = (await this.deps.engine.status()).numRunning ?? 0
      } catch {
        // status() unreachable: if the process is UP this is transient (a cold load
        // can block /api/status) and a server-side/opencode generation may be live —
        // treat as BUSY, never drain blindly. Only a stopped engine (no generation
        // possible) counts as drained.
        running = this.engineProcessRunning() ? this.deps.engine.inflight || 1 : 0
      }
      if (running === 0) return true
      if (Date.now() >= deadline || this.disposed) return false
      await sleep(150)
    }
  }

  private async doLoad(
    repoId: string,
    force = false
  ): Promise<{ ok: boolean; reason?: string }> {
    let model = this.installed.find((m) => m.repoId === repoId)
    if (!model) model = (await this.refreshInstalled()).find((m) => m.repoId === repoId)
    if (!model) return { ok: false, reason: `${repoId} is not downloaded` }

    // NB: the QAT/PLE gate is NOT here — it lives at the explicit-load boundary
    // (the models.load handler, behind `allowBroken`). Auto-load (ensureLoaded
    // for chat/agent/research/news) must not hard-fail on the name heuristic,
    // which has false positives (a PLE-safe re-quant named without "qat").
    const estimatedGB = (model.sizeBytes / 1e9) * MEMORY_OVERHEAD
    const verdict = this.deps.ramGuard.canLoad(estimatedGB, {
      loadedModels: this.engineModels,
      spec: tierSpecFor(repoId)
    })
    if (!verdict.ok && !force) {
      // Auto-swap: a tier/model switch must never require a manual unload.
      // Every consumer (chat/agent/news/research) funnels through here, so
      // evicting the idle co-residents covers them all — incl. noCoload ultra.
      const swapped = await this.swapForLoad(repoId, estimatedGB, verdict.reason)
      if (!swapped.ok) return swapped
    }

    await this.ensureEngineRunning()
    // If a registry change was deferred (engine was busy), the running engine
    // may have been spawned without this model and warm() would 404. An
    // explicit Load applies the registry now — but only when the restart is
    // actually needed for THIS repo and the engine is idle: every surface's
    // prompt funnels through here, and an unguarded restart would kill
    // another surface's in-flight generation (adversarial-review finding).
    if (registryKey(this.registryEntries()) !== this.appliedRegistryKey) {
      const engineKnowsRepo = this.engineModels.some((m) => m.id === repoId)
      if (!engineKnowsRepo) {
        const applied = await this.withDrain(0, async () => {
          this.pendingRegistryRestart = false
          await this.deps.processManager.get('engine')?.restart('apply registry for explicit load')
          await this.ensureEngineRunning()
          return { ok: true as const }
        })
        if (!applied.ok) {
          this.pendingRegistryRestart = true
          return {
            ok: false,
            reason: 'A generation is running — the engine picks up the new model when it finishes.'
          }
        }
      }
      // The engine already serves this repo: the drift concerns other
      // models/settings — leave it to the idle-deferral instead of restarting.
    }
    await this.deps.engine.warm(repoId)
    return { ok: true }
  }

  /** Pre-warm with swap semantics; no-op when already resident. The single
   *  shared implementation behind chat/agent/research prompts. */
  async ensureLoaded(repoId: string): Promise<void> {
    const resident =
      this.engineProcessRunning() &&
      this.engineModels.some((m) => m.id === repoId && m.state === 'loaded')
    if (resident) return
    const res = await this.load(repoId)
    if (!res.ok) throw new Error(res.reason ?? `could not load ${repoId}`)
  }

  /**
   * The RAM guard refused the fit — unload every OTHER loaded model (engine
   * idle only) and re-judge. The vm_stat sampler lags real frees by a few
   * seconds, so the re-check polls briefly instead of failing on stale data.
   */
  private async swapForLoad(
    repoId: string,
    estimatedGB: number,
    refusal: string | undefined
  ): Promise<{ ok: boolean; reason?: string }> {
    // A budget-bound refusal is constant in loaded models and system memory —
    // evicting (and stalling on re-checks) can never flip it.
    if (estimatedGB > this.deps.ramGuard.report(0).budgetGB) {
      return { ok: false, reason: refusal }
    }
    const others = evictableLoaded(this.engineModels, {
      exceptRepoId: repoId,
      protectEmbedder: this.deps.isLibraryIngesting()
    })
    if (others.length === 0) return { ok: false, reason: refusal }
    // Evict under the generation barrier (already on the load chain via doLoad, so
    // withDrain not exclusive). The gate blocks a generation from STARTING on a
    // model we're about to unload — what the old engineIdle() probe could miss.
    const evicted = await this.withDrain(0, async () => {
      this.log.info(`auto-swap: unloading ${others.map((m) => m.id).join(', ')} to fit ${repoId}`)
      for (const m of others) {
        await this.deps.engine.unloadModel(m.id)
      }
      const unloaded = new Set(others.map((m) => m.id))
      this.engineModels = this.engineModels.map((m) =>
        unloaded.has(m.id) ? { ...m, state: 'unloaded', memoryGB: null } : m
      )
      return { ok: true as const }
    })
    if (!evicted.ok) {
      return { ok: false, reason: 'A generation is running — try again when it finishes.' }
    }
    // Re-judge against THIS post-eviction snapshot, not this.engineModels (OUTSIDE
    // the gate — the sleep waits on system memory, not generations): the
    // 2.5s poller can overwrite that field mid-swap with the engine's lagging
    // /v1/models/status and re-credit the eviction we just awaited, making the
    // budget decision nondeterministic. The unloads above are awaited, so the
    // snapshot is the truth canLoad needs; only system memory (re-read by
    // ramGuard each pass) is what the sleep waits on.
    const afterEvict = this.engineModels
    let verdict = this.deps.ramGuard.canLoad(estimatedGB, {
      loadedModels: afterEvict,
      spec: tierSpecFor(repoId)
    })
    for (let attempt = 0; !verdict.ok && attempt < 3; attempt++) {
      await sleep(1500) // one vm_stat sampling period
      if (this.disposed) return { ok: false, reason: 'app is shutting down' }
      verdict = this.deps.ramGuard.canLoad(estimatedGB, {
        loadedModels: afterEvict,
        spec: tierSpecFor(repoId)
      })
    }
    return verdict.ok ? { ok: true } : { ok: false, reason: verdict.reason }
  }

  /**
   * Unload every loaded chat model — real per-model endpoints, no restart. The
   * embedder is deliberately left to the engine's lease-aware TTL/LRU (see
   * evictableLoaded): force-unloading it here can tear down an in-flight RAG
   * embed that engineIdle() cannot see.
   */
  async unloadAll(): Promise<{ ok: boolean; reason?: string }> {
    if (!this.engineProcessRunning()) return { ok: true }
    if (
      evictableLoaded(this.engineModels, { protectEmbedder: this.deps.isLibraryIngesting() }).length === 0
    ) {
      return { ok: true }
    }
    // Under the generation barrier: the engine's per-model /unload would tear a
    // model down mid-stream. exclusive() blocks new generations and waits for any
    // in flight to finish (refuses if they won't), then unloads.
    return this.exclusive(0, async () => {
      const targets = evictableLoaded(this.engineModels, {
        protectEmbedder: this.deps.isLibraryIngesting()
      })
      for (const m of targets) {
        await this.deps.engine.unloadModel(m.id)
      }
      const unloaded = new Set(targets.map((m) => m.id))
      this.engineModels = this.engineModels.map((m) =>
        unloaded.has(m.id) ? { ...m, state: 'unloaded', memoryGB: null } : m
      )
      return { ok: true as const }
    })
  }

  /** Unload one model via the engine's per-model endpoint — others stay loaded. */
  async unload(repoId: string): Promise<{ ok: boolean; reason?: string }> {
    if (!this.engineProcessRunning()) return { ok: true }
    const target = this.engineModels.find((m) => m.id === repoId)
    if (!target || target.state !== 'loaded') return { ok: true }
    return this.exclusive(0, async () => {
      await this.deps.engine.unloadModel(repoId)
      this.engineModels = this.engineModels.map((m) =>
        m.id === repoId ? { ...m, state: 'unloaded', memoryGB: null } : m
      )
      return { ok: true as const }
    })
  }

  // --- engine KV cache (R1) -----------------------------------------------------

  /** Size + cap of Crispin's relocated oMLX paged-SSD KV-cache. */
  cacheSize(): { bytes: number; path: string; maxBytes: number | null } {
    const path = omlxCacheDir()
    return {
      bytes: dirSizeBytes(path),
      path,
      maxBytes: settings.get(this.deps.db, 'engine.ssdCacheMaxGB', 8) * 1e9
    }
  }

  /**
   * Free the paged SSD KV-cache. The engine mmaps the .safetensors blocks, so we
   * stop it, delete the dir, then restart — refused while a generation is live.
   */
  async cacheClear(): Promise<{ ok: boolean; freedBytes: number; reason?: string }> {
    // Fast-reject a busy engine immediately (a sync inflight read, no probe, no
    // chain wait) so the button answers now instead of hanging behind a queued
    // cold load. The barrier below re-confirms authoritatively.
    if (this.deps.engine.inflight > 0) {
      return { ok: false, freedBytes: 0, reason: 'The engine is busy — wait for the generation to finish.' }
    }
    // exclusive(): serialize against every other lifecycle op — incl. the
    // syncEngineRegistry restart fired by download-complete, which is now also on
    // the chain (finding C) — so nothing starts the engine into the dir we rmSync.
    const res = await this.exclusive(0, async () => {
      const dir = omlxCacheDir()
      const freedBytes = dirSizeBytes(dir)
      const engine = this.deps.processManager.get('engine')
      const wasRunning = this.engineProcessRunning()
      if (engine && wasRunning) await engine.stop()
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch (err) {
        this.log.warn(`cache clear: ${err instanceof Error ? err.message : err}`)
      }
      if (engine && wasRunning && this.installed.length > 0) await engine.start()
      return { ok: true as const, freedBytes }
    })
    return res.ok ? res : { ok: false, freedBytes: 0, reason: res.reason }
  }

  private async ensureEngineRunning(): Promise<void> {
    if (this.disposed) throw new Error('app is shutting down')
    const engine = this.deps.processManager.get('engine')
    if (!engine) throw new Error('engine process is not registered')
    let state = engine.snapshot().state
    if (state === 'running') return
    if (state === 'stopped' || state === 'failed') {
      if (this.installed.length === 0) throw new Error('no models installed')
      await engine.start() // resolves once healthy (or crashing into backoff)
    }
    const deadline = Date.now() + ENGINE_START_TIMEOUT_MS
    while (Date.now() < deadline) {
      state = engine.snapshot().state
      if (state === 'running') return
      if (state === 'failed') throw new Error('engine failed to start — check logs')
      await sleep(500)
    }
    throw new Error('engine did not become ready in time')
  }

  /**
   * The embedder was just downloaded into the shared HF cache. oMLX discovers
   * cache models at spawn only, so a running engine cannot serve it until it
   * restarts — but never mid-generation (that kills another surface's in-flight
   * stream, the same hazard load()'s restart is idle-gated against). Wait,
   * bounded, for the engine to go idle, then restart; the library ingest awaits
   * this before its first /v1/embeddings call. Owned here because ModelService,
   * not LibraryService, orchestrates the engine.
   */
  async discoverEmbedder(): Promise<{ ok: boolean; reason?: string }> {
    const deadline = Date.now() + EMBEDDER_DISCOVER_WAIT_MS
    for (;;) {
      const engine = this.deps.processManager.get('engine')
      const running = engine?.snapshot().state === 'running'
      const alreadyDiscovered = this.engineModels.some((m) => m.id === EMBEDDING_MODEL)
      // engineIdle() is an HTTP probe — only worth it when a restart is on the table.
      const mustCheckIdle = !this.disposed && running && !alreadyDiscovered
      const action = embedderDiscoverAction({
        disposed: this.disposed,
        running,
        alreadyDiscovered,
        idle: mustCheckIdle ? await this.engineIdle() : false,
        timedOut: Date.now() >= deadline
      })
      if (action === 'done') return { ok: true }
      if (action === 'restart' && engine) {
        // Restart under the generation barrier (exclusive = chain + drain): blocks
        // new generations and waits for any in flight, so the respawn can't SIGTERM
        // a chat/agent stream. If a generation won't drain, loop back to the wait;
        // the deadline check at the top of this loop bounds the total time.
        const restarted = await this.exclusive(0, () =>
          engine
            .restart('embedding model downloaded — rediscover the HF cache')
            .then(() => ({ ok: true as const }))
        )
        if (!restarted.ok) {
          await sleep(ENGINE_POLL_MS)
          continue
        }
        // Confirm the respawn actually surfaced the embedder rather than blindly
        // reporting success — a discovery miss should fail the ingest with an
        // actionable reason, not a downstream /v1/embeddings 404.
        await this.refreshEngineModels()
        return this.engineModels.some((m) => m.id === EMBEDDING_MODEL)
          ? { ok: true }
          : {
              ok: false,
              reason: 'the embedding model did not load after the engine restart — check the engine logs'
            }
      }
      if (action === 'giveUp') {
        return {
          ok: false,
          reason: this.disposed
            ? 'app is shutting down'
            : 'the engine is busy — try the ingest again in a moment'
        }
      }
      await sleep(ENGINE_POLL_MS) // 'wait'
    }
  }

  // --- misc orchestration -----------------------------------------------------

  async deleteModel(repoId: string): Promise<void> {
    await this.deps.tools.deleteModel(repoId)
    // Reset the repo's download history so phantomPartial() reflects only
    // attempts made after this delete (see refreshInstalled).
    this.deps.db.prepare('DELETE FROM model_downloads WHERE repo_id = ?').run(repoId)
    await this.refreshInstalled()
    await this.syncEngineRegistry()
  }

  async search(query: string): Promise<HFSearchResult[]> {
    const { results } = await this.deps.tools.searchModels(query)
    return results.map((r) => ({
      repoId: r.repo_id,
      downloads: r.downloads,
      likes: r.likes,
      updatedAt: r.last_modified_ms,
      warning: candidateWarning(r.repo_id)
    }))
  }

  overview(): ModelsOverview {
    return {
      engine: this.engineStatus(),
      installed: this.installed,
      downloads: this.recentDownloads(20),
      tiers: TIER_ORDER.map((tier) => this.resolveTier(tier)),
      defaults: this.featureDefaults(),
      tierSelections: this.deps.appSettings.tierSelections(),
      ram: this.deps.ramGuard.report(this.loadedGB())
    }
  }

  /**
   * Persist a per-tier model pick. Resolution-only: no registry churn, no
   * engine restart — resolveTier() simply prefers the pick from now on.
   */
  setTierSelection(tier: Tier, repoId: string | null): void {
    const current = this.deps.appSettings.get()
    const next = { ...current.tierSelections }
    if (repoId === null) {
      delete next[tier]
    } else {
      // Alias-aware like resolveTier: a renamed id and its canonical form are
      // the same logical model for both halves of this validation.
      const model = this.installed.find(
        (m) => canonicalRepoId(m.repoId) === canonicalRepoId(repoId)
      )
      if (!model) throw new Error(`${repoId} is not downloaded`)
      if (tierOfRepo(repoId) !== tier && classifyByParams(repoId, model.sizeBytes) !== tier) {
        throw new Error(`${repoId} does not belong to the ${tier} tier`)
      }
      next[tier] = repoId
    }
    this.deps.appSettings.update({ ...current, tierSelections: next })
  }

  setDefault(feature: Feature, tier: Tier): void {
    // Persist only explicit overrides — untouched features must keep tracking
    // FEATURE_DEFAULTS as the code constants evolve.
    const overrides = settings.get<Partial<FeatureDefaults>>(this.deps.db, 'featureDefaults', {})
    settings.set(this.deps.db, 'featureDefaults', { ...overrides, [feature]: tier })
  }

  private featureDefaults(): FeatureDefaults {
    const overrides = settings.get<Partial<FeatureDefaults>>(this.deps.db, 'featureDefaults', {})
    return { ...FEATURE_DEFAULTS, ...overrides }
  }

  /**
   * Requested tier's active model first, then nearest installed below, then
   * above. The single shared walk behind chat/agent/research model picks.
   */
  resolveActiveRepo(tier: Tier): string {
    const active = new Map(TIER_ORDER.map((t) => [t, this.resolveTier(t).active]))
    const start = TIER_ORDER.indexOf(tier)
    const order = [tier, ...TIER_ORDER.slice(0, start).reverse(), ...TIER_ORDER.slice(start + 1)]
    for (const candidate of order) {
      const repoId = active.get(candidate)
      if (repoId) return repoId
    }
    throw new Error('No chat models installed — download one in the Models tab first.')
  }

  private resolveTier(tier: Tier): TierResolution {
    const ram = this.deps.ramGuard.report(0)
    const curated = TIERS[tier].candidates
    // HF-downloaded repos outside every curated list join their classified
    // tier — this is what makes arbitrary downloads loadable and selectable.
    // isCuratedRepo is rename-aware, so a snapshot under a renamed old id
    // counts as curated (it fills its slot below) instead of going
    // experimental and appearing twice.
    const experimental = this.installed
      .filter((m) => !isCuratedRepo(m.repoId))
      .filter((m) => classifyByParams(m.repoId, m.sizeBytes) === tier)
      .map((m) => m.repoId)
    const candidates = [...curated, ...experimental].map((repoId) => {
      // Exact id first, then alias match: weights downloaded under a renamed
      // old id satisfy the curated slot. Surface the INSTALLED id — the engine
      // discovered the snapshot under that id, so load/unload/requests must
      // use it.
      const model =
        this.installed.find((m) => m.repoId === repoId) ??
        this.installed.find((m) => canonicalRepoId(m.repoId) === canonicalRepoId(repoId))
      const effectiveId = model?.repoId ?? repoId
      const estGB = estimateGB(effectiveId, model?.sizeBytes) ?? TIERS[tier].approxGB
      return {
        repoId: effectiveId,
        installed: model !== undefined,
        engineState: this.engineModels.find((m) => m.id === effectiveId)?.state ?? null,
        family: familyOf(effectiveId),
        estGB: round2(estGB),
        fit: fitFor(estGB, ram),
        // Enforce the QAT/PLE rule at the discovery seam too: a non-QAT Gemma 4
        // E-series can land in the shared HF cache out-of-band and would
        // otherwise be offered as a normal candidate with no warning.
        warning: candidateWarning(effectiveId)
      }
    })
    // Explicit pick first (when still installed); else first installed curated.
    // Both comparisons go through canonicalRepoId so a persisted pick of a
    // renamed id keeps resolving to the same logical model.
    const selection = this.deps.appSettings.tierSelections()[tier]
    const picked = selection
      ? (candidates.find(
          (c) => canonicalRepoId(c.repoId) === canonicalRepoId(selection) && c.installed
        )?.repoId ?? null)
      : null
    const active =
      picked ??
      candidates.find((c) => c.installed && curated.includes(canonicalRepoId(c.repoId)))?.repoId ??
      null
    return { tier, candidates, active }
  }

  private recentDownloads(limit: number): DownloadInfo[] {
    const rows = this.deps.db
      .prepare('SELECT * FROM model_downloads ORDER BY started_at DESC LIMIT ?')
      .all(limit) as unknown as DownloadRow[]
    return rows.map(rowToDownload)
  }

  // --- engine status polling ----------------------------------------------------

  private engineProcessRunning(): boolean {
    return this.deps.processManager.get('engine')?.snapshot().state === 'running'
  }

  private engineStatus(): EngineStatus {
    const running = this.engineProcessRunning()
    return {
      running,
      budgetGB: this.deps.ramGuard.report(0).budgetGB,
      // Renderer-facing list sticks to Crispin-known chat models: oMLX discovers
      // everything in the shared HF cache (embedder, foreign repos), and those
      // must not flip LocalModels' "Unload all" / load badges. loadedGB() keeps
      // using the unfiltered list so the RAM donut stays honest.
      models: running
        ? this.engineModels.filter((m) => this.installed.some((i) => i.repoId === m.id))
        : []
    }
  }

  private loadedGB(): number {
    if (!this.engineProcessRunning()) return 0
    return round2(
      this.engineModels
        .filter((m) => m.state === 'loaded')
        .reduce((sum, m) => sum + (m.memoryGB ?? 0), 0)
    )
  }

  startPoller(): void {
    if (this.pollTimer || this.disposed) return
    this.pollTimer = setInterval(() => void this.pollTick(), ENGINE_POLL_MS)
  }

  /**
   * One immediate reconcile against /v1/models/status, outside the 2.5s
   * cadence. Generation error paths call this so an engine-side unload
   * (memory-pressure eviction, TTL) is reflected in the UI right away.
   */
  async refreshEngineModels(): Promise<void> {
    if (this.disposed || !this.engineProcessRunning()) return
    try {
      this.engineModels = await this.deps.engine.models()
      this.modelsPollFailures = 0
    } catch {
      return // the poller keeps owning the failure path
    }
    if (this.disposed) return
    this.broadcastEngineStatusIfChanged()
  }

  /** Shared change-detection + broadcast for pollTick and refreshEngineModels. */
  private broadcastEngineStatusIfChanged(): void {
    const status = this.engineStatus()
    const key = JSON.stringify(status)
    if (key !== this.lastEngineKey) {
      this.lastEngineKey = key
      this.deps.broadcast({ type: 'models.statusChanged', engine: status })
    }
  }

  private async pollTick(): Promise<void> {
    // Single-flight: a tick whose awaits (models + idle + maybeIdleUnload's
    // unloads + a possible sync/restart) can outrun the 2.5s interval; a second
    // overlapping tick would double-consume pendingRegistryRestart and double-fire
    // unloadAll/syncEngineRegistry. Skip while one is still in flight.
    if (this.polling) return
    this.polling = true
    try {
      await this.pollOnce()
    } finally {
      this.polling = false
    }
  }

  private async pollOnce(): Promise<void> {
    this.tick += 1
    const running = this.engineProcessRunning()

    if (running) {
      try {
        this.engineModels = await this.deps.engine.models()
        this.modelsPollFailures = 0
      } catch {
        // Transient — the process manager's health loop owns liveness. But
        // after ~3 straight failures stop claiming anything is loaded: a
        // wedged status endpoint (e.g. right after a prefill OOM) must not
        // leave a stale "Loaded" badge in the Models tab. The next good poll
        // restores the truth either way.
        if (++this.modelsPollFailures >= 3) {
          this.engineModels = this.engineModels.map((m) =>
            m.state === 'loaded' ? { ...m, state: 'unloaded', memoryGB: null } : m
          )
        }
      }
    } else if (this.engineModels.length > 0) {
      this.engineModels = []
    }

    // A tick parked on the await above outlives dispose() — no broadcasts or
    // deferred-restart handling once shutdown has begun.
    if (this.disposed) return

    this.broadcastEngineStatusIfChanged()

    // Every 2nd tick (5s) — the only cadence while the engine is down.
    if (this.tick % 2 === 0) {
      this.deps.broadcast({
        type: 'system.ramReport',
        ram: this.deps.ramGuard.report(this.loadedGB())
      })
    }

    if (this.pendingRegistryRestart && running && (await this.engineIdle())) {
      this.pendingRegistryRestart = false
      await this.syncEngineRegistry() // re-defers (re-sets the flag) if the drain refuses
    }

    await this.maybeIdleUnload()
  }

  /**
   * App-idle unload: everything unloads after `models.idleUnloadSeconds`
   * without renderer activity (system-wide idle would never fire while Ahmed
   * games in another app — exactly when the RAM should come back). The engine
   * ttl_seconds backstop is strictly larger (see backstopTtlSeconds) so the
   * mechanisms never fight. No latch needed: a successful sweep leaves nothing
   * loaded, and background loads are guarded until their work finishes.
   */
  private async maybeIdleUnload(): Promise<void> {
    const knobSeconds = this.deps.appSettings.idleUnloadSeconds()
    if (knobSeconds <= 0) return // disabled in Settings
    if (Date.now() - this.deps.getLastAppActivityAt() <= knobSeconds * 1000) return
    if (!this.engineProcessRunning()) return
    // The sweep is gated on chat models being loaded; unloadAll() then reclaims
    // the embedder too (safe — the isLibraryIngesting guard below means no embed
    // is in flight). A lone resident embedder is left to its own engine TTL.
    const loaded = evictableLoaded(this.engineModels, { protectEmbedder: true })
    if (loaded.length === 0) return
    if (this.activeDownloads.size > 0) return
    if (this.deps.isResearchActive() || this.deps.isNewsBusy() || this.deps.isLibraryIngesting())
      return
    if (!(await this.engineIdle())) return
    if (this.disposed) return
    this.log.info(
      `app idle ${Math.round((Date.now() - this.deps.getLastAppActivityAt()) / 60_000)} min — unloading ${loaded.length} model(s)`
    )
    const res = await this.unloadAll()
    if (!res.ok) return // engine went busy between the idle check and here — skip the toast
    const minutes = Math.max(1, Math.round(knobSeconds / 60))
    this.deps.broadcast({
      type: 'system.toast',
      level: 'info',
      message:
        loaded.length === 1
          ? `Unloaded the model after ${minutes} min of inactivity.`
          : `Unloaded ${loaded.length} models after ${minutes} min of inactivity.`
    })
  }
}
