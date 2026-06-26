import { create } from 'zustand'
import type { DownloadInfo, Feature, HFSearchResult, ModelsOverview, Tier } from '@shared/types'
import { call, onEvent } from '@/lib/ipc'

interface ModelsStore {
  overview: ModelsOverview | null
  searchResults: HFSearchResult[] | null
  searching: boolean
  initialized: boolean
  init: () => Promise<void>
  refresh: () => Promise<void>
  download: (repoId: string, force?: boolean) => Promise<void>
  cancelDownload: (id: string) => Promise<void>
  deleteModel: (repoId: string) => Promise<void>
  search: (query: string) => Promise<void>
  load: (
    repoId: string,
    opts?: { force?: boolean; allowBroken?: boolean }
  ) => Promise<{ ok: boolean; reason?: string }>
  unload: (repoId: string) => Promise<{ ok: boolean; reason?: string }>
  unloadAll: () => Promise<void>
  setDefault: (feature: Feature, tier: Tier) => Promise<void>
  setTierSelection: (tier: Tier, repoId: string | null) => Promise<void>
}

function upsertDownload(downloads: DownloadInfo[], download: DownloadInfo): DownloadInfo[] {
  const index = downloads.findIndex((d) => d.id === download.id)
  if (index === -1) return [download, ...downloads]
  return downloads.map((d, i) => (i === index ? download : d))
}

// HF search latency is variable enough that responses resolve out of order;
// only the newest request may write results or clear the spinner.
let searchSeq = 0

export const useModelsStore = create<ModelsStore>((set, get) => ({
  overview: null,
  searchResults: null,
  searching: false,
  initialized: false,

  init: async () => {
    // Listeners latch once, but refresh runs on every mount so reopening the
    // tab heals staleness even if an event raced or was missed.
    if (!get().initialized) {
      set({ initialized: true })
      onEvent('models.downloadProgress', (event) => {
        set((s) =>
          s.overview
            ? {
                overview: {
                  ...s.overview,
                  downloads: upsertDownload(s.overview.downloads, event.download)
                }
              }
            : {}
        )
        // A finished download changes what's installed and how tiers resolve.
        if (event.download.status === 'done') void get().refresh()
      })
      onEvent('models.statusChanged', (event) =>
        set((s) => (s.overview ? { overview: { ...s.overview, engine: event.engine } } : {}))
      )
      onEvent('models.installedChanged', () => void get().refresh())
      onEvent('system.ramReport', (event) =>
        set((s) => (s.overview ? { overview: { ...s.overview, ram: event.ram } } : {}))
      )
    }
    await get().refresh()
  },

  refresh: async () => {
    const overview = await call('models.overview')
    set({ overview })
  },

  download: async (repoId, force) => {
    await call('models.download', { repoId, force })
    // Pick up the queued entry right away instead of waiting for the first event.
    await get().refresh()
  },

  cancelDownload: async (id) => {
    await call('models.cancelDownload', { downloadId: id })
  },

  deleteModel: async (repoId) => {
    await call('models.delete', { repoId })
    await get().refresh()
  },

  search: async (query) => {
    const seq = ++searchSeq
    set({ searching: true })
    try {
      const { results } = await call('models.search', { query })
      if (seq === searchSeq) set({ searchResults: results })
    } finally {
      if (seq === searchSeq) set({ searching: false })
    }
  },

  load: async (repoId, opts) => {
    // Surfaced to the caller so the UI can offer the matching override on a
    // refusal: RAM (force) or known-broken-quant (allowBroken).
    return call('models.load', { repoId, force: opts?.force, allowBroken: opts?.allowBroken })
  },

  unload: async (repoId) => {
    // Surfaced to the caller so the UI can toast the refusal reason.
    return call('models.unload', { repoId })
  },

  unloadAll: async () => {
    await call('models.unloadAll')
  },

  setTierSelection: async (tier, repoId) => {
    await call('models.setTierSelection', { tier, repoId })
    // Selection changes the tier's active model — refetch the resolved view.
    await get().refresh()
  },

  setDefault: async (feature, tier) => {
    // Optimistic: the select reflects the choice instantly; revert if main
    // never persisted it so the UI can't drift from the saved defaults.
    const prev = get().overview?.defaults[feature]
    set((s) =>
      s.overview
        ? { overview: { ...s.overview, defaults: { ...s.overview.defaults, [feature]: tier } } }
        : {}
    )
    try {
      await call('models.setDefault', { feature, tier })
    } catch (err) {
      if (prev)
        set((s) =>
          s.overview
            ? { overview: { ...s.overview, defaults: { ...s.overview.defaults, [feature]: prev } } }
            : {}
        )
      throw err
    }
  }
}))
