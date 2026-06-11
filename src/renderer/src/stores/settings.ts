import { create } from 'zustand'
import type { AppSettings } from '@shared/ipc'
import { call, onEvent } from '@/lib/ipc'

interface SettingsStore {
  settings: AppSettings | null
  initialized: boolean
  init: () => Promise<void>
  /** Shallow-merge patch over the current object; full-object PUT to main. */
  update: (patch: Partial<AppSettings>) => Promise<void>
}

export const useSettingsStore = create<SettingsStore>((set, get) => ({
  settings: null,
  initialized: false,

  init: async () => {
    if (get().initialized) return
    set({ initialized: true })
    onEvent('settings.changed', (event) => set({ settings: event.settings }))
    set({ settings: await call('settings.get') })
  },

  update: async (patch) => {
    const current = get().settings
    if (!current) return
    const next = { ...current, ...patch }
    set({ settings: next }) // optimistic — settings.changed confirms
    try {
      await call('settings.update', { settings: next })
    } catch (err) {
      set({ settings: await call('settings.get') }) // revert to truth
      throw err
    }
  }
}))
