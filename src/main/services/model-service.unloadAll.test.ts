import { describe, it, expect, vi } from 'vitest'
import type { EngineModelInfo } from '@shared/types'
import { ModelService, type ModelServiceDeps } from './model-service'

// Guards the Pass-1 finding: models.unloadAll must refuse mid-generation exactly
// like models.unload, instead of tearing the generating model down under a live
// stream. Builds the minimal deps unloadAll + refreshEngineModels actually touch.

function makeService(opts: { numRunning: number; loaded: EngineModelInfo[] }) {
  const unloadModel = vi.fn(async (_id: string) => {})
  const deps = {
    engine: {
      models: async () => opts.loaded,
      status: async () => ({ running: true, numRunning: opts.numRunning }),
      unloadModel,
      setDraining: () => {},
      get inflight() {
        return opts.numRunning
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
    // unused by these paths, present to satisfy the type
    db: {},
    tools: {},
    appSettings: {},
    getEnginePort: () => 1,
    getLastAppActivityAt: () => 0,
    isResearchActive: () => false,
    isNewsBusy: () => false
  } as unknown as ModelServiceDeps
  return { svc: new ModelService(deps), unloadModel }
}

const loaded = (id: string): EngineModelInfo => ({ id, state: 'loaded', memoryGB: 5 })

describe('ModelService.unloadAll mid-generation guard', () => {
  it('refuses (ok:false) and unloads nothing while the engine is busy', async () => {
    const { svc, unloadModel } = makeService({ numRunning: 1, loaded: [loaded('m1')] })
    await svc.refreshEngineModels() // populate engineModels from the engine

    const res = await svc.unloadAll()

    expect(res.ok).toBe(false)
    expect(res.reason).toMatch(/busy/i)
    expect(unloadModel).not.toHaveBeenCalled()
  })

  it('unloads every loaded chat model when the engine is idle', async () => {
    const { svc, unloadModel } = makeService({ numRunning: 0, loaded: [loaded('m1'), loaded('m2')] })
    await svc.refreshEngineModels()

    const res = await svc.unloadAll()

    expect(res.ok).toBe(true)
    expect(unloadModel).toHaveBeenCalledTimes(2)
    expect(unloadModel.mock.calls.map((c) => c[0]).sort()).toEqual(['m1', 'm2'])
  })
})
