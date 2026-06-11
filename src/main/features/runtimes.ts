import { handle } from '../ipc/router'
import type { RuntimeManager } from '../services/runtime-manager'

/** Registers every runtimes.* IPC method. */
export function registerRuntimesFeature(runtimes: RuntimeManager): void {
  handle('runtimes.status', () => runtimes.status())

  handle('runtimes.checkLatest', () => runtimes.checkLatest())

  handle('runtimes.update', async ({ component, version }) => {
    await runtimes.update(component, version)
    return { ok: true }
  })

  handle('runtimes.reset', async ({ component }) => {
    await runtimes.reset(component)
    return { ok: true }
  })
}
