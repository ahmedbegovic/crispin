import { handle } from '../ipc/router'
import type { AppSettingsService } from '../services/app-settings'

export function registerSettingsFeature(appSettings: AppSettingsService): void {
  handle('settings.get', () => appSettings.get())

  handle('settings.update', ({ settings }) => {
    appSettings.update(settings)
    return { ok: true }
  })
}
