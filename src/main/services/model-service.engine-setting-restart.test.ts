import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./logger', () => ({
  scopedLogger: () => ({ info: () => {}, warn: () => {}, error: () => {} }),
  initLogging: () => {},
  log: { info: () => {}, warn: () => {}, error: () => {} }
}))

// Controllable settings store so the service's offload reads/writes are deterministic.
const settingsStore: Record<string, unknown> = {}
vi.mock('./settings', () => ({
  get: (_db: unknown, key: string, fallback: unknown) =>
    key in settingsStore ? settingsStore[key] : fallback,
  set: (_db: unknown, key: string, value: unknown) => {
    settingsStore[key] = value
  }
}))

import { ModelService, type ModelServiceDeps } from './model-service'

// A spawn-time engine knob (moeOffloadGB / moeOffloadOptimistic) is read into the engine
// env only at spawn, so applying a change means a restart. It must (a) never kill an
// in-flight generation, (b) never be silently DROPPED — including in transient engine
// states — and (c) never fire a redundant restart once the running engine already has the
// new config, and the RAM math must judge a load against what the engine ACTUALLY has.

// A structural test handle — reaching past `private` for the few internals we drive
// directly (a standalone shape, not `ModelService & …`, so the private `appliedOffload`
// doesn't collapse the intersection to `never`).
type Svc = {
  restartForEngineSettingChange(): Promise<void>
  appliedOffload: { gb: number | 'auto'; optimistic: boolean } | null
  offloadGBForEstimate(): number | 'auto'
  pollOnce(): Promise<void>
  writeConfig(port: number): unknown
}

function makeService(opts?: { state?: { v: string }; numRunning?: { v: number } }) {
  const state = opts?.state ?? { v: 'running' }
  const numRunning = opts?.numRunning ?? { v: 0 }
  const restart = vi.fn(async () => {})
  const broadcast = vi.fn()
  const engineProc = {
    snapshot: () => ({ name: 'engine', state: state.v, port: 1, pid: 1 }),
    restart
  }
  const deps = {
    engine: {
      models: async () => [],
      status: async () => ({ running: true, numRunning: numRunning.v }),
      setDraining: () => {},
      get inflight() {
        return numRunning.v
      }
    },
    processManager: { get: () => engineProc },
    ramGuard: {
      report: () => ({ totalGB: 32, freeGB: 10, availableGB: 10, budgetGB: 18.5, loadedGB: 0 })
    },
    isLibraryIngesting: () => false,
    broadcast,
    db: {},
    tools: {},
    appSettings: { idleUnloadSeconds: () => 0 },
    getEnginePort: () => 1,
    getLastAppActivityAt: () => 0,
    isResearchActive: () => false,
    isNewsBusy: () => false
  } as unknown as ModelServiceDeps

  const svc = new ModelService(deps) as unknown as Svc
  // The config write hits the real app-data dir; the restart behavior is what we test.
  vi.spyOn(svc, 'writeConfig').mockReturnValue([])
  return { svc, restart, broadcast, state, numRunning }
}

const toast = expect.objectContaining({ type: 'system.toast' })

beforeEach(() => {
  for (const k of Object.keys(settingsStore)) delete settingsStore[k]
})

describe('ModelService.restartForEngineSettingChange — durable, idempotent spawn-time-knob apply', () => {
  it('restarts the engine immediately when it is idle', async () => {
    const { svc, restart, broadcast } = makeService()
    await svc.restartForEngineSettingChange()
    expect(restart).toHaveBeenCalledTimes(1)
    expect(broadcast).not.toHaveBeenCalledWith(toast)
  })

  it('defers (toast, no kill) instead of dropping the change when a generation is in flight', async () => {
    const { svc, restart, broadcast } = makeService({ numRunning: { v: 1 } })
    await svc.restartForEngineSettingChange()
    expect(restart).not.toHaveBeenCalled() // never yanks the in-flight generation
    expect(broadcast).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'system.toast', level: 'warn' })
    )
  })

  it('applies the deferred restart on the next idle poll tick', async () => {
    const numRunning = { v: 1 }
    const { svc, restart } = makeService({ numRunning })
    await svc.restartForEngineSettingChange() // busy → deferred, not dropped
    expect(restart).not.toHaveBeenCalled()

    numRunning.v = 0 // the generation finished
    await svc.pollOnce()
    expect(restart).toHaveBeenCalledTimes(1) // the deferred restart fired once idle
  })

  it('does NOT restart when the running engine already has the desired offload config (idempotent)', async () => {
    const { svc, restart } = makeService()
    // The engine was spawned with exactly the current (default) settings.
    svc.appliedOffload = { gb: 0, optimistic: false }
    await svc.restartForEngineSettingChange()
    expect(restart).not.toHaveBeenCalled()
  })

  it('does not drop a change made while the engine is in a transient (non-running) state', async () => {
    const state = { v: 'waiting_healthy' }
    const numRunning = { v: 0 }
    const { svc, restart } = makeService({ state, numRunning })
    settingsStore['engine.moeOffloadGB'] = 'auto'

    await svc.restartForEngineSettingChange() // transient → cannot restart yet, but must not be lost
    expect(restart).not.toHaveBeenCalled()

    state.v = 'running' // engine came up (with the OLD env, since its spawn predated the change)
    await svc.pollOnce()
    expect(restart).toHaveBeenCalledTimes(1) // applied once it reached a running+idle state
  })

  it('broadcasts the deferred toast only once across repeated busy attempts', async () => {
    const { svc, broadcast } = makeService({ numRunning: { v: 1 } })
    await svc.restartForEngineSettingChange()
    await svc.restartForEngineSettingChange() // still busy — must not re-toast the same deferral
    expect(broadcast.mock.calls.filter(([e]) => e?.type === 'system.toast')).toHaveLength(1)
  })
})

describe('ModelService.offloadGBForEstimate — RAM math judges a load against the APPLIED config', () => {
  it('uses the config the running engine was spawned with, not a not-yet-applied new setting', () => {
    const { svc } = makeService()
    svc.appliedOffload = { gb: 0, optimistic: false } // engine running with offload OFF
    settingsStore['engine.moeOffloadGB'] = 'auto' // user just enabled auto (restart pending)
    expect(svc.offloadGBForEstimate()).toBe(0) // judge the load against the still-OFF engine
  })

  it('uses the desired setting when the engine is down (a load will spawn it fresh)', () => {
    const { svc } = makeService({ state: { v: 'stopped' } })
    settingsStore['engine.moeOffloadGB'] = 'auto'
    expect(svc.offloadGBForEstimate()).toBe('auto')
  })
})
