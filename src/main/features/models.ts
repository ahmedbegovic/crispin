import { app } from 'electron'
import { allocatePort } from '../services/ports'
import { sidecarDir, uvBinary, uvEnvFor } from '../services/paths'
import { engineConfigPath } from '../services/engine-config'
import { isPinned } from '../services/runtime-manager'
import { handle } from '../ipc/router'
import type { ProcessManager } from '../services/process-manager'
import type { ModelService } from '../services/model-service'
import type { EngineClient } from '../services/engine-client'

export interface ModelsFeatureDeps {
  processManager: ProcessManager
  modelService: ModelService
  engineClient: EngineClient
  ports: { engine: number }
}

/** Registers the engine sidecar and every models.* IPC method. */
export function registerModelsFeature(deps: ModelsFeatureDeps): void {
  const { processManager, modelService, engineClient, ports } = deps

  processManager.register({
    name: 'engine',
    port: () => ports.engine || null,
    healthUrl: () => `http://127.0.0.1:${ports.engine}/health`,
    // Packaged first run uv-syncs the venv (mlx wheels are large).
    startTimeoutMs: app.isPackaged ? 900_000 : 180_000,
    // A request in flight through main's client (generation, or a blocking
    // /load via warm()) means work, not a hang — never escalate failed
    // probes to a kill mid-generation.
    busy: () => engineClient.inflight > 0,
    command: async () => {
      ports.engine = await allocatePort(47621)
      // The config is the spawn contract — rewrite it with the fresh port.
      modelService.writeConfigForSpawn(ports.engine)
      const dir = sidecarDir('engine')
      return {
        cmd: uvBinary(),
        args: [
          'run',
          // A runtime-pinned venv must not be re-synced back to the bundled
          // lock on spawn (see runtime-manager.ts) — reset deletes the marker.
          ...(isPinned('engine') ? ['--no-sync'] : []),
          '--project',
          dir,
          'python',
          'run_engine.py',
          '--config',
          engineConfigPath()
        ],
        cwd: dir,
        env: uvEnvFor('engine')
      }
    }
  })

  handle('models.overview', () => modelService.overview())

  handle('models.download', async ({ repoId, force }) => ({
    downloadId: await modelService.startDownload(repoId, force ?? false)
  }))

  handle('models.cancelDownload', async ({ downloadId }) => ({
    ok: await modelService.cancelDownload(downloadId)
  }))

  handle('models.delete', async ({ repoId }) => {
    await modelService.deleteModel(repoId)
    return { ok: true }
  })

  handle('models.search', async ({ query }) => ({ results: await modelService.search(query) }))

  handle('models.load', ({ repoId, force }) => modelService.load(repoId, force ?? false))

  handle('models.unload', ({ repoId }) => modelService.unload(repoId))

  handle('models.unloadAll', async () => {
    await modelService.unloadAll()
    return { ok: true }
  })

  handle('models.setDefault', ({ feature, tier }) => {
    modelService.setDefault(feature, tier)
    return { ok: true }
  })

  handle('models.setTierSelection', ({ tier, repoId }) => {
    modelService.setTierSelection(tier, repoId)
    return { ok: true }
  })
}
