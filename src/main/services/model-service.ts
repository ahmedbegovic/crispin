import type { OrionEvent } from '@shared/ipc'
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
  validateModelRepo,
  type TierSpec
} from '@shared/model-tiers'
import type { OrionDatabase } from './db'
import * as settings from './settings'
import { writeEngineConfig, type EngineConfigModel } from './engine-config'
import type { EngineClient } from './engine-client'
import type { RamGuard } from './ram-guard'
import type { ProcessManager } from './process-manager'
import type { DownloadJobData, ToolsClient } from './tools-client'
import { scopedLogger } from './logger'

const DOWNLOAD_POLL_MS = 500
const ENGINE_POLL_MS = 2500
const ENGINE_START_TIMEOUT_MS = 180_000
/**
 * Weights on disk ≈ weights in memory at 4-bit; +10% for runtime overhead.
 * Deliberately NOT higher: the ultra tier (~16.5 GB on disk) must still fit
 * the 18.5 GB budget after full eviction, and KV growth is bounded by the
 * engine's --memory-guard-gb process-memory enforcer, not this estimate.
 */
const MEMORY_OVERHEAD = 1.1

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const round2 = (n: number): number => Math.round(n * 100) / 100

/** Order-insensitive fingerprint of a registry — drives restart decisions. */
const registryKey = (entries: EngineConfigModel[]): string =>
  JSON.stringify([...entries].sort((a, b) => a.name.localeCompare(b.name)))

const tierSpecFor = (repoId: string): TierSpec | undefined => {
  const tier = TIER_ORDER.find((t) => TIERS[t].candidates.includes(repoId))
  return tier ? TIERS[tier] : undefined
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
  db: OrionDatabase
  tools: ToolsClient
  engine: EngineClient
  ramGuard: RamGuard
  processManager: ProcessManager
  /** Current allocated engine port; 0 before the first spawn. */
  getEnginePort: () => number
  broadcast: (event: OrionEvent) => void
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
  private pollTimer: ReturnType<typeof setInterval> | null = null
  private tick = 0
  private disposed = false
  private readonly log = scopedLogger('models')

  constructor(private readonly deps: ModelServiceDeps) {}

  async init(): Promise<void> {
    // Downloads from a previous app run died with their sidecar — surface that.
    this.deps.db
      .prepare(
        "UPDATE model_downloads SET status = 'failed', error = 'interrupted by app restart', finished_at = ? WHERE status IN ('queued', 'downloading')"
      )
      .run(Date.now())

    // The tools sidecar may still be booting; retry the first scan with backoff.
    const delays = [1000, 2000, 4000, 8000, 15000]
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

  private registryEntries(): EngineConfigModel[] {
    // 0 disables the engine-side per-model idle TTL.
    const idleSeconds = settings.get(this.deps.db, 'engine.autoUnloadIdleSeconds', 1800)
    return this.installed.map((m) => {
      const spec = tierSpecFor(m.repoId)
      return {
        name: m.repoId,
        // Output budget: ultra is capped, small models run ctx-bounded.
        maxTokens: spec?.maxOutputTokens ?? m.contextLength ?? 32768,
        ttlSeconds: idleSeconds > 0 ? idleSeconds : null
      }
    })
  }

  private writeConfig(port: number): EngineConfigModel[] {
    const entries = this.registryEntries()
    const idleSeconds = settings.get(this.deps.db, 'engine.autoUnloadIdleSeconds', 1800)
    writeEngineConfig({
      port,
      // The embedder is pool-resident under oMLX like any model — give it the
      // same idle TTL so RAG use doesn't pin its RAM until app quit. Kept out
      // of `entries` so the restart fingerprint and empty-registry semantics
      // stay chat-model-only (maxTokens is inert for an embeddings model).
      models: [
        ...entries,
        { name: EMBEDDING_MODEL, maxTokens: 1, ttlSeconds: idleSeconds > 0 ? idleSeconds : null }
      ],
      budgetGB: this.deps.ramGuard.report(0).budgetGB
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
    if (state === 'stopped' || state === 'failed') {
      // The engine never starts with an empty registry — nothing to serve.
      if (entries.length === 0) return
      await engine.start()
      return
    }

    // An empty registry can't be respawned (run_engine.py exits 2 on it, and
    // backoff would crash-loop into 'failed') — stop is the terminal state.
    if (entries.length === 0) {
      this.pendingRegistryRestart = false
      this.appliedRegistryKey = null
      this.engineModels = []
      await engine.stop()
      return
    }

    if (registryKey(entries) === this.appliedRegistryKey) return

    if (state === 'running' && (await this.engineIdle())) {
      await engine.restart('model registry changed')
    } else {
      this.pendingRegistryRestart = true
      this.deps.broadcast({
        type: 'system.toast',
        level: 'warn',
        message: 'Model registry changed — engine restart deferred until it is idle.'
      })
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
        return
      }
    }
  }

  async cancelDownload(downloadId: string): Promise<boolean> {
    const jobId = this.activeDownloads.get(downloadId)
    if (jobId) {
      // The poll loop observes the cancellation and finalizes DB + broadcast.
      const { ok } = await this.deps.tools.cancelJob(jobId)
      return ok
    }
    // Stale row from a previous run — just mark it cancelled.
    const row = this.deps.db
      .prepare('SELECT * FROM model_downloads WHERE id = ?')
      .get(downloadId) as DownloadRow | undefined
    if (!row || row.status === 'done') return false
    this.deps.db
      .prepare("UPDATE model_downloads SET status = 'cancelled', finished_at = ? WHERE id = ?")
      .run(Date.now(), downloadId)
    this.deps.broadcast({
      type: 'models.downloadProgress',
      download: rowToDownload({ ...row, status: 'cancelled', finished_at: Date.now() })
    })
    return true
  }

  // --- load / unload ----------------------------------------------------------

  async load(repoId: string, force = false): Promise<{ ok: boolean; reason?: string }> {
    let model = this.installed.find((m) => m.repoId === repoId)
    if (!model) model = (await this.refreshInstalled()).find((m) => m.repoId === repoId)
    if (!model) return { ok: false, reason: `${repoId} is not downloaded` }

    const estimatedGB = (model.sizeBytes / 1e9) * MEMORY_OVERHEAD
    const verdict = this.deps.ramGuard.canLoad(estimatedGB, {
      loadedModels: this.engineModels,
      spec: tierSpecFor(repoId)
    })
    if (!verdict.ok && !force) return { ok: false, reason: verdict.reason }

    await this.ensureEngineRunning()
    // If a registry change was deferred (engine was busy), the running engine
    // was spawned without this model and warm() would 404. An explicit Load
    // overrides the idle-deferral: apply the registry now.
    if (registryKey(this.registryEntries()) !== this.appliedRegistryKey) {
      this.pendingRegistryRestart = false
      await this.deps.processManager.get('engine')?.restart('apply registry for explicit load')
      await this.ensureEngineRunning()
    }
    await this.deps.engine.warm(repoId)
    return { ok: true }
  }

  /** Unload every loaded model — real endpoints now, no restart involved. */
  async unloadAll(): Promise<void> {
    if (!this.engineProcessRunning()) return
    for (const m of this.engineModels.filter((m) => m.state === 'loaded')) {
      await this.deps.engine.unloadModel(m.id)
    }
    this.engineModels = this.engineModels.map((m) =>
      m.state === 'loaded' ? { ...m, state: 'unloaded', memoryGB: null } : m
    )
  }

  /** Unload one model via the engine's per-model endpoint — others stay loaded. */
  async unload(repoId: string): Promise<{ ok: boolean; reason?: string }> {
    if (!this.engineProcessRunning()) return { ok: true }
    const target = this.engineModels.find((m) => m.id === repoId)
    if (!target || target.state !== 'loaded') return { ok: true }
    if (!(await this.engineIdle())) {
      return { ok: false, reason: 'The engine is busy — wait for the generation to finish.' }
    }
    await this.deps.engine.unloadModel(repoId)
    this.engineModels = this.engineModels.map((m) =>
      m.id === repoId ? { ...m, state: 'unloaded', memoryGB: null } : m
    )
    return { ok: true }
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
    return results.map((r) => {
      const verdict = validateModelRepo(r.repo_id)
      return {
        repoId: r.repo_id,
        downloads: r.downloads,
        likes: r.likes,
        updatedAt: r.last_modified_ms,
        warning: verdict.ok ? null : (verdict.warning ?? null)
      }
    })
  }

  overview(): ModelsOverview {
    return {
      engine: this.engineStatus(),
      installed: this.installed,
      downloads: this.recentDownloads(20),
      tiers: TIER_ORDER.map((tier) => this.resolveTier(tier)),
      defaults: this.featureDefaults(),
      ram: this.deps.ramGuard.report(this.loadedGB())
    }
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

  private resolveTier(tier: Tier): TierResolution {
    const candidates = TIERS[tier].candidates.map((repoId) => ({
      repoId,
      installed: this.installed.some((m) => m.repoId === repoId),
      engineState: this.engineModels.find((m) => m.id === repoId)?.state ?? null
    }))
    return { tier, candidates, active: candidates.find((c) => c.installed)?.repoId ?? null }
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
      // Renderer-facing list sticks to Orion-known chat models: oMLX discovers
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

  private async pollTick(): Promise<void> {
    this.tick += 1
    const running = this.engineProcessRunning()

    if (running) {
      try {
        this.engineModels = await this.deps.engine.models()
      } catch {
        // transient — the process manager's health loop owns liveness
      }
    } else if (this.engineModels.length > 0) {
      this.engineModels = []
    }

    // A tick parked on the await above outlives dispose() — no broadcasts or
    // deferred-restart handling once shutdown has begun.
    if (this.disposed) return

    const status = this.engineStatus()
    const key = JSON.stringify(status)
    if (key !== this.lastEngineKey) {
      this.lastEngineKey = key
      this.deps.broadcast({ type: 'models.statusChanged', engine: status })
    }

    // Every 2nd tick (5s) — the only cadence while the engine is down.
    if (this.tick % 2 === 0) {
      this.deps.broadcast({
        type: 'system.ramReport',
        ram: this.deps.ramGuard.report(this.loadedGB())
      })
    }

    if (this.pendingRegistryRestart && running && (await this.engineIdle())) {
      this.pendingRegistryRestart = false
      await this.syncEngineRegistry()
    }
    // Idle auto-unload is the engine's job now: oMLX enforces the per-model
    // ttl_seconds written by registryEntries().
  }
}
