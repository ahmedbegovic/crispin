import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'
import { createParser } from 'eventsource-parser'
import type { InstalledModel } from '@shared/types'
import type { ManagedProcess, ProcessManager } from './process-manager'
import { allocatePort } from './ports'
import { opencodeConfigKey, writeOpencodeConfig } from './opencode-config'
import { scopedLogger } from './logger'

const MAX_SERVERS = 2
const BASE_PORT = 47631
const START_TIMEOUT_MS = 30_000
const IDLE_SWEEP_MS = 60_000
const IDLE_MAX_MS = 15 * 60_000
/** A server with an SSE event this recent is mid-turn — never evict it. */
const BUSY_GRACE_MS = 30_000
const SSE_RECONNECT_MS = [500, 1000, 2000, 5000]

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export type OpencodeEventListener = (directory: string, event: unknown) => void

export interface OpencodePoolDeps {
  processManager: ProcessManager
  getEnginePort: () => number
  getToolsPort: () => number
  installedModels: () => InstalledModel[]
  /** Rendered Settings instructions — part of the config fingerprint. */
  getInstructionsText: () => string
  /** Runtime-updated binary first, bundled otherwise (see runtime-manager). */
  getOpencodeBinary: () => string
}

interface PoolServer {
  /** Canonical (resolved) workspace path — the pool key. */
  directory: string
  /** 0 or 1 — picks the preferred port (47631/47632). */
  slot: number
  name: string
  proc: ManagedProcess
  port: number
  lastUsedAt: number
  /** Unix ms of the last SSE event — a live turn keeps this fresh. */
  lastEventAt: number
  /** Fingerprint of the config inputs the running process was spawned with. */
  configKey: string
  /** In-flight ensure — concurrent callers for one directory share a start. */
  starting: Promise<void> | null
  /** True once the SSE pump loop is alive (it survives supervised restarts). */
  pumping: boolean
  sseAbort: AbortController | null
  /** Set by stop/dispose: the pump must cease and never reconnect. */
  closed: boolean
}

/**
 * At most two `opencode serve` servers, keyed by workspace directory and
 * supervised by the ProcessManager. Servers idle > 15 min are stopped; at
 * capacity the least-recently-used one is evicted. One SSE pump per server
 * fans every opencode event in to the registered listeners.
 */
export class OpencodePool {
  private readonly servers = new Map<string, PoolServer>()
  private readonly listeners: OpencodeEventListener[] = []
  private readonly sweeper: ReturnType<typeof setInterval>
  private disposed = false
  private readonly log = scopedLogger('opencode-pool')

  constructor(private readonly deps: OpencodePoolDeps) {
    this.sweeper = setInterval(() => void this.sweepIdle(), IDLE_SWEEP_MS)
  }

  /** Spawn (or reuse) the server for a workspace; resolves once it is healthy. */
  async ensureServer(directory: string): Promise<{ baseUrl: string; directory: string }> {
    if (this.disposed) throw new Error('opencode pool is disposed')
    const dir = resolve(directory)
    let server = this.servers.get(dir)
    if (!server) {
      await this.evictForCapacity()
      // The eviction await yields — a concurrent ensure may have won the race.
      server = this.servers.get(dir)
    }
    if (!server) {
      server = this.createServer(dir)
      this.servers.set(dir, server)
    }
    const srv = server
    srv.lastUsedAt = Date.now()
    // A running server whose config inputs drifted (engine port moved, model
    // installed/removed) is serving a dead baseURL or a stale model list —
    // stop the process (not stopServer: the entry stays pooled, the SSE pump
    // exits on 'stopped') so the start path below respawns it fresh. Sessions
    // persist on disk across opencode restarts, so this is safe.
    if (srv.proc.snapshot().state === 'running' && srv.configKey !== this.currentConfigKey()) {
      this.log.info(`${srv.name} config stale — restarting`)
      await srv.proc.stop()
    }
    if (srv.proc.snapshot().state !== 'running') {
      if (!srv.starting) {
        srv.starting = this.startServer(srv).finally(() => {
          srv.starting = null
        })
      }
      await srv.starting
    }
    return { baseUrl: this.baseUrl(srv), directory: dir }
  }

  /** Bump the LRU clock without spawning anything. */
  touch(directory: string): void {
    const server = this.servers.get(resolve(directory))
    if (server) server.lastUsedAt = Date.now()
  }

  /** The pooled server for a workspace, only if already running — never spawns. */
  runningServer(directory: string): { baseUrl: string; directory: string } | null {
    const server = this.servers.get(resolve(directory))
    if (!server || server.proc.snapshot().state !== 'running') return null
    return { baseUrl: this.baseUrl(server), directory: server.directory }
  }

  /** Every parsed SSE event from every pool server, tagged with its directory. */
  onEvent(cb: OpencodeEventListener): void {
    this.listeners.push(cb)
  }

  async dispose(): Promise<void> {
    this.disposed = true
    clearInterval(this.sweeper)
    await Promise.all([...this.servers.values()].map((s) => this.stopServer(s)))
  }

  /** Stop every server (binary/runtime swap) — next prompt respawns fresh. */
  async stopAll(): Promise<void> {
    await Promise.all([...this.servers.values()].map((s) => this.stopServer(s)))
  }

  // --- lifecycle -------------------------------------------------------------

  private baseUrl(server: PoolServer): string {
    return `http://127.0.0.1:${server.port}`
  }

  private freeSlot(): number {
    const used = new Set([...this.servers.values()].map((s) => s.slot))
    for (let i = 0; i < MAX_SERVERS; i++) if (!used.has(i)) return i
    return this.servers.size // unreachable below MAX_SERVERS
  }

  private createServer(dir: string): PoolServer {
    const hash = createHash('sha256').update(dir).digest('hex').slice(0, 8)
    const server: PoolServer = {
      directory: dir,
      slot: this.freeSlot(),
      name: `opencode:${hash}`,
      // stopServer() unregisters the name after the stop completes, so this
      // register() never collides with a live ManagedProcess from an earlier
      // eviction of the same directory (same name).
      proc: null as unknown as ManagedProcess,
      port: 0,
      lastUsedAt: Date.now(),
      lastEventAt: 0,
      configKey: '',
      starting: null,
      pumping: false,
      sseAbort: null,
      closed: false
    }
    server.proc = this.deps.processManager.register({
      name: server.name,
      port: () => server.port || null,
      healthUrl: () => `${this.baseUrl(server)}/api/health`,
      startTimeoutMs: START_TIMEOUT_MS,
      command: async () => {
        server.port = await allocatePort(BASE_PORT + server.slot)
        // The config is the spawn contract — regenerate it with the current
        // ports and model list (same pattern as the engine writeConfigForSpawn).
        const configOpts = {
          enginePort: this.deps.getEnginePort(),
          toolsPort: this.deps.getToolsPort(),
          models: this.deps.installedModels(),
          instructionsText: this.deps.getInstructionsText()
        }
        server.configKey = opencodeConfigKey(configOpts)
        const configPath = writeOpencodeConfig(configOpts)
        return {
          cmd: this.deps.getOpencodeBinary(),
          args: ['serve', '--port', String(server.port), '--hostname', '127.0.0.1'],
          cwd: server.directory,
          env: { OPENCODE_CONFIG: configPath }
        }
      }
    })
    return server
  }

  private async startServer(server: PoolServer): Promise<void> {
    const state = server.proc.snapshot().state
    if (state === 'stopped' || state === 'failed') await server.proc.start()
    // start() resolves when healthy OR when crashing into backoff — wait for
    // an actual verdict before handing the baseUrl to a caller.
    const deadline = Date.now() + START_TIMEOUT_MS
    while (Date.now() < deadline) {
      const s = server.proc.snapshot().state
      if (s === 'running') {
        this.startEventPump(server)
        return
      }
      // 'stopped' means a concurrent stop/dispose landed mid-start — terminal,
      // mirroring the pumpEvents loop-top check; don't pin the caller for 30s.
      if (s === 'failed' || s === 'stopped' || server.closed || this.disposed) break
      await sleep(250)
    }
    await this.stopServer(server)
    throw new Error(`opencode server for ${server.directory} failed to start`)
  }

  private async stopServer(server: PoolServer): Promise<void> {
    server.closed = true
    server.sseAbort?.abort()
    this.servers.delete(server.directory)
    await server.proc.stop()
    // After the stop: a later ensureServer for this directory registers the
    // same name, and ProcessManager.register refuses to overwrite a live proc.
    this.deps.processManager.unregister(server.name, server.proc)
  }

  private currentConfigKey(): string {
    return opencodeConfigKey({
      enginePort: this.deps.getEnginePort(),
      toolsPort: this.deps.getToolsPort(),
      models: this.deps.installedModels(),
      instructionsText: this.deps.getInstructionsText()
    })
  }

  private async evictForCapacity(): Promise<void> {
    while (this.servers.size >= MAX_SERVERS) {
      // A turn runs server-side long after prompt admission — a server still
      // emitting SSE events is mid-turn and must never be the eviction victim.
      const now = Date.now()
      const candidates = [...this.servers.values()].filter(
        (s) => now - s.lastEventAt > BUSY_GRACE_MS
      )
      if (candidates.length === 0) {
        throw new Error('Both agent workspaces are busy — wait for a turn to finish first.')
      }
      const lru = candidates.sort((a, b) => a.lastUsedAt - b.lastUsedAt)[0]
      this.log.info(`at capacity — evicting ${lru.name} (${lru.directory})`)
      await this.stopServer(lru)
    }
  }

  private async sweepIdle(): Promise<void> {
    if (this.disposed) return
    const now = Date.now()
    for (const server of [...this.servers.values()]) {
      const lastActive = Math.max(server.lastUsedAt, server.lastEventAt)
      if (server.starting || now - lastActive <= IDLE_MAX_MS) continue
      this.log.info(`${server.name} idle ${Math.round((now - lastActive) / 60_000)} min — stopping`)
      await this.stopServer(server)
    }
  }

  // --- SSE event bus -----------------------------------------------------------

  private startEventPump(server: PoolServer): void {
    if (server.pumping || server.closed || this.disposed) return
    server.pumping = true
    void this.pumpEvents(server).finally(() => {
      server.pumping = false
    })
  }

  /**
   * One long-lived GET /event per server. Reconnects with small backoff across
   * drops and supervised restarts; exits once the server is stopped/failed,
   * evicted, or the pool is disposed. startServer() revives it after that.
   */
  private async pumpEvents(server: PoolServer): Promise<void> {
    let attempt = 0
    while (!server.closed && !this.disposed) {
      const state = server.proc.snapshot().state
      if (state === 'stopped' || state === 'failed') return
      const abort = new AbortController()
      server.sseAbort = abort
      try {
        const res = await fetch(`${this.baseUrl(server)}/event`, { signal: abort.signal })
        if (!res.ok || !res.body) throw new Error(`GET /event → ${res.status}`)
        attempt = 0
        const parser = createParser({ onEvent: (event) => this.emit(server, event.data) })
        const reader = res.body.getReader()
        const decoder = new TextDecoder()
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          parser.feed(decoder.decode(value, { stream: true }))
        }
      } catch (err) {
        if (!server.closed && !this.disposed) {
          this.log.warn(`${server.name} event stream dropped: ${err instanceof Error ? err.message : err}`)
        }
      } finally {
        server.sseAbort = null
      }
      if (server.closed || this.disposed) return
      await sleep(SSE_RECONNECT_MS[Math.min(attempt, SSE_RECONNECT_MS.length - 1)])
      attempt += 1
    }
  }

  private emit(server: PoolServer, data: string): void {
    server.lastEventAt = Date.now() // live SSE traffic = mid-turn, never evict
    let event: unknown
    try {
      event = JSON.parse(data)
    } catch {
      return // tolerate a malformed SSE line rather than killing the pump
    }
    for (const listener of this.listeners) {
      try {
        listener(server.directory, event)
      } catch (err) {
        this.log.warn(`event listener threw: ${err instanceof Error ? err.message : err}`)
      }
    }
  }
}
