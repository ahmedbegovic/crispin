import { create } from 'zustand'

/** Module id or 'settings' (the pinned gear, not a module). */
export type AppTabId = string

interface UiStore {
  activeTab: AppTabId
  setActiveTab: (id: AppTabId) => void
}

/** Cross-cutting shell state — e.g. News fetch-on-open watches activeTab. */
export const useUiStore = create<UiStore>((set) => ({
  activeTab: 'chat',
  setActiveTab: (id) => set({ activeTab: id })
}))
