import { create } from 'zustand'
import type { ProcessSnapshot, SystemStatus } from '@shared/types'
import { call, onEvent } from '@/lib/ipc'

interface SystemStore {
  status: SystemStatus | null
  processes: Record<string, ProcessSnapshot>
  initialized: boolean
  init: () => Promise<void>
  restartProcess: (name: string) => Promise<void>
}

export const useSystemStore = create<SystemStore>((set, get) => ({
  status: null,
  processes: {},
  initialized: false,

  init: async () => {
    if (get().initialized) return
    set({ initialized: true })
    onEvent('system.processState', (event) =>
      set((s) => ({ processes: { ...s.processes, [event.process.name]: event.process } }))
    )
    const status = await call('system.status')
    set({
      status,
      processes: Object.fromEntries(status.processes.map((p) => [p.name, p]))
    })
  },

  restartProcess: async (name) => {
    await call('system.restartProcess', { name })
  }
}))
