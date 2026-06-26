import { describe, it, expect, vi } from 'vitest'
import { ModelService, type ModelServiceDeps } from './model-service'

// Guards the review finding: installed[].sampling comes from unvalidated HF
// generation_config.json (tools.localModels), then feeds the bounded
// installedModelSchema.sampling in models.overview. Out-of-bounds sampling must
// degrade to null (keep the model) rather than fail the overview output.parse.

function makeService(models: unknown[]) {
  const deps = {
    engine: {
      models: async () => [],
      status: async () => ({ running: true, numRunning: 0 }),
      unloadModel: async () => {},
      setDraining: () => {},
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
    // phantomPartial() reads model_downloads; no rows = not phantom.
    db: { prepare: () => ({ get: () => ({ total: 0, done: 0 }) }) },
    tools: { localModels: async () => ({ models }) },
    appSettings: {},
    getEnginePort: () => 1,
    getLastAppActivityAt: () => 0,
    isResearchActive: () => false,
    isNewsBusy: () => false
  } as unknown as ModelServiceDeps
  return new ModelService(deps)
}

const model = (sampling: unknown) => ({
  repo_id: 'org/m-4bit',
  size_bytes: 1,
  last_modified_ms: null,
  context_length: 4096,
  sampling
})

describe('ModelService.refreshInstalled — sampling hydration', () => {
  it('nulls out-of-bounds generation_config sampling but keeps the model', async () => {
    const svc = makeService([model({ temperature: 99, top_p: 0.5, top_k: 40 })]) // temp 99 > max 5
    const installed = await svc.refreshInstalled()
    expect(installed).toHaveLength(1) // model still listed
    expect(installed[0].sampling).toBeNull() // bad sampling dropped to null
  })

  it('preserves in-bounds sampling unchanged', async () => {
    const svc = makeService([model({ temperature: 0.7, top_p: 0.9, top_k: 40 })])
    const installed = await svc.refreshInstalled()
    expect(installed[0].sampling).toEqual({ temperature: 0.7, topP: 0.9, topK: 40 })
  })
})
