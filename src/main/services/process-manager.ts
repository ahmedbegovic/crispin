import { spawn, type ChildProcess } from 'node:child_process'
import type { ProcessSnapshot, ProcessState } from '@shared/types'
import { scopedLogger } from './logger'

export interface SpawnPlan {
  cmd: string
  args: string[]
  cwd?: string
  env?: Record<string, string>
}

export interface ManagedProcessSpec {
  name: string
  /** Resolved lazily at each spawn so ports/config are always current. */
  command: () => Promise<SpawnPlan>
  /** URL that returns 2xx once the process is ready to serve. */
  healthUrl: () => string
  port: () => number | null
  /** How long to wait for first healthy response after spawn. */
  startTimeoutMs?: number
  healthIntervalMs?: number
}

const BACKOFF_MS = [1000, 2000, 5000, 15000, 30000]
const CRASH_WINDOW_MS = 60_000
const MAX_CRASHES_IN_WINDOW = 3
const HEALTH_FAILS_BEFORE_RESTART = 3

export type ProcessChangeListener = (snapshot: ProcessSnapshot) => void

export class ManagedProcess {
  private child: ChildProcess | null = null
  private state: ProcessState = 'stopped'
  private detail = ''
  private stopping = false
  private crashTimes: number[] = []
  private healthFails = 0
  private healthTimer: ReturnType<typeof setInterval> | null = null
  private pendingRestart: ReturnType<typeof setTimeout> | null = null
  private restartAttempt = 0
  private readonly log: ReturnType<typeof scopedLogger>

  constructor(
    readonly spec: ManagedProcessSpec,
    private readonly onChange: ProcessChangeListener
  ) {
    this.log = scopedLogger(spec.name)
  }

  snapshot(): ProcessSnapshot {
    return {
      name: this.spec.name,
      state: this.state,
      port: this.state === 'stopped' || this.state === 'failed' ? null : this.spec.port(),
      pid: this.child?.pid ?? null,
      detail: this.detail || undefined
    }
  }

  private setState(state: ProcessState, detail = ''): void {
    this.state = state
    this.detail = detail
    this.log.info(`state → ${state}${detail ? ` (${detail})` : ''}`)
    this.onChange(this.snapshot())
  }

  async start(): Promise<void> {
    if (this.state !== 'stopped' && this.state !== 'failed') return
    this.stopping = false
    this.crashTimes = []
    this.restartAttempt = 0
    await this.spawnOnce()
  }

  private async spawnOnce(): Promise<void> {
    if (this.stopping) return
    this.setState('spawning')
    let plan: SpawnPlan
    try {
      plan = await this.spec.command()
    } catch (err) {
      this.setState('failed', `could not build command: ${err instanceof Error ? err.message : err}`)
      return
    }
    this.log.info(`spawn: ${plan.cmd} ${plan.args.join(' ')}`)
    const child = spawn(plan.cmd, plan.args, {
      cwd: plan.cwd,
      env: { ...process.env, ...plan.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      // Own process group so wrappers like `uv run` die together with the
      // servers they spawn — no orphaned children squatting on our ports.
      detached: true
    })
    this.child = child
    child.stdout?.on('data', (b: Buffer) => this.log.info(b.toString().trimEnd()))
    child.stderr?.on('data', (b: Buffer) => this.log.warn(b.toString().trimEnd()))
    child.once('error', (err) => {
      this.log.error(`spawn error: ${err.message}`)
    })
    child.once('exit', (code, signal) => this.onExit(code, signal))

    this.setState('waiting_healthy')
    const healthy = await this.waitHealthy(child)
    if (this.stopping || this.child !== child) return
    if (healthy) {
      this.restartAttempt = 0
      this.healthFails = 0
      this.setState('running')
      this.startHealthLoop()
    } else {
      this.log.warn('never became healthy within timeout; killing for restart')
      this.killTree('SIGKILL') // exit handler drives the restart
    }
  }

  /** Signal the whole process group (uv wrapper + python child). */
  private killTree(signal: NodeJS.Signals): void {
    const pid = this.child?.pid
    if (!pid) return
    try {
      process.kill(-pid, signal)
    } catch {
      try {
        this.child?.kill(signal)
      } catch {
        // already gone
      }
    }
  }

  private async probe(): Promise<boolean> {
    try {
      const res = await fetch(this.spec.healthUrl(), { signal: AbortSignal.timeout(2000) })
      return res.ok
    } catch {
      return false
    }
  }

  private async waitHealthy(child: ChildProcess): Promise<boolean> {
    const deadline = Date.now() + (this.spec.startTimeoutMs ?? 30_000)
    while (Date.now() < deadline) {
      if (this.stopping || this.child !== child || child.exitCode !== null) return false
      if (await this.probe()) return true
      await new Promise((r) => setTimeout(r, 500))
    }
    return false
  }

  private startHealthLoop(): void {
    this.stopHealthLoop()
    this.healthTimer = setInterval(async () => {
      if (this.state !== 'running' && this.state !== 'unhealthy') return
      const ok = await this.probe()
      if (ok) {
        if (this.state === 'unhealthy') this.setState('running')
        this.healthFails = 0
        return
      }
      this.healthFails += 1
      if (this.state === 'running') this.setState('unhealthy', `${this.healthFails} failed probes`)
      if (this.healthFails >= HEALTH_FAILS_BEFORE_RESTART) {
        this.log.warn('health probes exhausted; killing for restart')
        this.healthFails = 0
        this.killTree('SIGKILL') // exit handler drives the restart
      }
    }, this.spec.healthIntervalMs ?? 5000)
  }

  private stopHealthLoop(): void {
    if (this.healthTimer) clearInterval(this.healthTimer)
    this.healthTimer = null
  }

  private onExit(code: number | null, signal: string | null): void {
    this.stopHealthLoop()
    this.child = null
    if (this.stopping) {
      this.setState('stopped')
      return
    }
    const now = Date.now()
    this.crashTimes = [...this.crashTimes.filter((t) => now - t < CRASH_WINDOW_MS), now]
    if (this.crashTimes.length >= MAX_CRASHES_IN_WINDOW) {
      this.setState('failed', `crashed ${this.crashTimes.length}× in ${CRASH_WINDOW_MS / 1000}s — check logs`)
      return
    }
    const backoff = BACKOFF_MS[Math.min(this.restartAttempt, BACKOFF_MS.length - 1)]
    this.restartAttempt += 1
    this.setState('restarting', `exit ${signal ?? code}; retry in ${backoff / 1000}s`)
    this.pendingRestart = setTimeout(() => {
      this.pendingRestart = null
      void this.spawnOnce()
    }, backoff)
  }

  async stop(): Promise<void> {
    this.stopping = true
    this.stopHealthLoop()
    if (this.pendingRestart) {
      clearTimeout(this.pendingRestart)
      this.pendingRestart = null
    }
    const child = this.child
    if (!child) {
      this.setState('stopped')
      return
    }
    this.killTree('SIGTERM')
    const exited = await new Promise<boolean>((resolve) => {
      const t = setTimeout(() => resolve(false), 3000)
      child.once('exit', () => {
        clearTimeout(t)
        resolve(true)
      })
    })
    if (!exited) this.killTree('SIGKILL')
  }

  async restart(reason: string): Promise<void> {
    this.log.info(`restart requested: ${reason}`)
    await this.stop()
    await this.start()
  }
}

export class ProcessManager {
  private readonly procs = new Map<string, ManagedProcess>()

  constructor(private readonly onChange: ProcessChangeListener) {}

  register(spec: ManagedProcessSpec): ManagedProcess {
    const proc = new ManagedProcess(spec, this.onChange)
    this.procs.set(spec.name, proc)
    return proc
  }

  get(name: string): ManagedProcess | undefined {
    return this.procs.get(name)
  }

  snapshots(): ProcessSnapshot[] {
    return [...this.procs.values()].map((p) => p.snapshot())
  }

  async shutdown(): Promise<void> {
    await Promise.all([...this.procs.values()].map((p) => p.stop()))
  }
}
