import type { AppSettings, CrispinEvent } from '@shared/ipc'
import { defaultModulesEnabled } from '@shared/modules'
import type { Feature } from '@shared/types'
import type { CrispinDatabase } from './db'
import * as settings from './settings'

/** One knob for both the main-side idle sweep and the oMLX TTL backstop. */
export const DEFAULT_IDLE_UNLOAD_SECONDS = 300

export interface AppSettingsServiceDeps {
  db: CrispinDatabase
  broadcast: (event: CrispinEvent) => void
}

/**
 * Assembles the Settings page's full object from per-area `settings` table
 * keys (and disassembles it on update). Main-side consumers read through the
 * typed helpers; the renderer gets the whole object plus `settings.changed`.
 */
export class AppSettingsService {
  constructor(private readonly deps: AppSettingsServiceDeps) {}

  get(): AppSettings {
    const db = this.deps.db
    return {
      profile: settings.get(db, 'profile', { userName: '', assistantName: 'Crispin' }),
      instructions: settings.get(db, 'instructions', { global: '', perModule: {} }),
      modulesEnabled: {
        ...defaultModulesEnabled(),
        ...settings.get<Record<string, boolean>>(db, 'modules.enabled', {})
      },
      idleUnloadSeconds: settings.get(db, 'models.idleUnloadSeconds', DEFAULT_IDLE_UNLOAD_SECONDS),
      newsTopics: settings.get<string[]>(db, 'news.topics', []),
      tierSelections: settings.get(db, 'models.tierSelections', {})
    }
  }

  update(next: AppSettings): void {
    const db = this.deps.db
    settings.set(db, 'profile', next.profile)
    settings.set(db, 'instructions', next.instructions)
    settings.set(db, 'modules.enabled', next.modulesEnabled)
    settings.set(db, 'models.idleUnloadSeconds', next.idleUnloadSeconds)
    settings.set(db, 'news.topics', next.newsTopics)
    settings.set(db, 'models.tierSelections', next.tierSelections)
    this.deps.broadcast({ type: 'settings.changed', settings: this.get() })
  }

  profile(): AppSettings['profile'] {
    return this.get().profile
  }

  /** Trimmed per-module instruction, '' when unset. */
  moduleInstruction(module: Feature): string {
    return this.get().instructions.perModule[module]?.trim() ?? ''
  }

  globalInstruction(): string {
    return this.get().instructions.global.trim()
  }

  moduleEnabled(moduleId: string): boolean {
    const enabled = this.get().modulesEnabled
    return enabled[moduleId] ?? true
  }

  idleUnloadSeconds(): number {
    return this.get().idleUnloadSeconds
  }

  newsTopics(): string[] {
    return this.get().newsTopics
  }

  tierSelections(): AppSettings['tierSelections'] {
    return this.get().tierSelections
  }
}
