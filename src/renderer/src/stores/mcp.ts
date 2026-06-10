import { create } from 'zustand'
import type { McpServer } from '@shared/types'
import { call } from '@/lib/ipc'

export interface McpTestResult {
  ok: boolean
  tools?: string[]
  error?: string
}

interface McpStore {
  servers: McpServer[]
  testing: Record<string, boolean>
  testResults: Record<string, McpTestResult>
  initialized: boolean
  init: () => Promise<void>
  refresh: () => Promise<void>
  upsert: (server: McpServer) => Promise<void>
  remove: (id: string) => Promise<void>
  toggle: (id: string, enabled: boolean) => Promise<void>
  test: (id: string) => Promise<void>
}

export const useMcpStore = create<McpStore>((set, get) => ({
  servers: [],
  testing: {},
  testResults: {},
  initialized: false,

  init: async () => {
    if (get().initialized) return
    set({ initialized: true })
    await get().refresh()
  },

  refresh: async () => {
    const { servers } = await call('mcp.list')
    set({ servers })
  },

  upsert: async (server) => {
    const { server: saved } = await call('mcp.upsert', { server })
    set((s) => {
      const index = s.servers.findIndex((x) => x.id === saved.id)
      return {
        servers:
          index === -1 ? [...s.servers, saved] : s.servers.map((x, i) => (i === index ? saved : x)),
        // A config change invalidates any earlier test verdict.
        testResults: Object.fromEntries(
          Object.entries(s.testResults).filter(([id]) => id !== saved.id)
        )
      }
    })
  },

  remove: async (id) => {
    await call('mcp.remove', { id })
    set((s) => ({ servers: s.servers.filter((x) => x.id !== id) }))
  },

  toggle: async (id, enabled) => {
    const server = get().servers.find((x) => x.id === id)
    if (!server) return
    // Optimistic flip; revert if main rejects the upsert.
    set((s) => ({ servers: s.servers.map((x) => (x.id === id ? { ...x, enabled } : x)) }))
    try {
      await call('mcp.upsert', { server: { ...server, enabled } })
    } catch (err) {
      set((s) => ({ servers: s.servers.map((x) => (x.id === id ? server : x)) }))
      throw err
    }
  },

  test: async (id) => {
    set((s) => ({ testing: { ...s.testing, [id]: true } }))
    try {
      const result = await call('mcp.test', { id })
      set((s) => ({ testResults: { ...s.testResults, [id]: result } }))
    } catch (err) {
      set((s) => ({
        testResults: {
          ...s.testResults,
          [id]: { ok: false, error: err instanceof Error ? err.message : String(err) }
        }
      }))
    } finally {
      set((s) => {
        const { [id]: _, ...testing } = s.testing
        return { testing }
      })
    }
  }
}))
