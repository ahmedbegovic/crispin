import { describe, it, expect, vi } from 'vitest'
import type { EngineModelInfo } from '@shared/types'
import { ModelService, type ModelServiceDeps } from './model-service'

// Guards the coordinator's core invariant: every engine-lifecycle op runs on ONE
// FIFO chain under the drain gate, so two of them can never interleave (finding C
// was exactly an off-chain op racing one on the chain). Parks the first op's engine
// call on a deferred and asserts the second does not begin until it resolves.

const loaded = (id: string): EngineModelInfo => ({ id, state: 'loaded', memoryGB: 5 })

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => (resolve = r))
  return { promise, resolve }
}

describe('ModelService lifecycle serialization', () => {
  it('serializes two unloads on the single chain — no interleave, each under its own gate', async () => {
    const order: string[] = []
    const firstUnload = deferred<void>()
    let calls = 0
    const unloadModel = vi.fn(async (id: string) => {
      order.push(`unload:${id}`)
      if (calls++ === 0) await firstUnload.promise // park the first op mid-chain
    })

    const deps = {
      engine: {
        models: async () => [loaded('a'), loaded('b')],
        status: async () => ({ running: true, numRunning: 0 }),
        unloadModel,
        setDraining: (v: boolean) => order.push(`draining:${v}`),
        get inflight() {
          return 0
        }
      },
      processManager: {
        get: () => ({ snapshot: () => ({ name: 'engine', state: 'running', port: 1, pid: 1 }) })
      },
      ramGuard: {
        report: () => ({ totalGB: 32, freeGB: 10, availableGB: 10, budgetGB: 18.5, loadedGB: 0 })
      },
      isLibraryIngesting: () => false,
      broadcast: vi.fn(),
      db: {},
      tools: {},
      appSettings: {},
      getEnginePort: () => 1,
      getLastAppActivityAt: () => 0,
      isResearchActive: () => false,
      isNewsBusy: () => false
    } as unknown as ModelServiceDeps

    const svc = new ModelService(deps)
    await svc.refreshEngineModels() // populate engineModels with a + b loaded

    const p1 = svc.unload('a')
    const p2 = svc.unload('b')
    await new Promise((r) => setTimeout(r, 20))

    // Second unload is queued behind the first on the chain — it has NOT started.
    expect(order.filter((o) => o.startsWith('unload:'))).toEqual(['unload:a'])

    firstUnload.resolve()
    await Promise.all([p1, p2])

    // Strict order, no interleave; each op opened + closed its own drain gate.
    expect(order.filter((o) => o.startsWith('unload:'))).toEqual(['unload:a', 'unload:b'])
    expect(order).toEqual([
      'draining:true',
      'unload:a',
      'draining:false',
      'draining:true',
      'unload:b',
      'draining:false'
    ])
  })
})
