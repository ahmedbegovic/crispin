import { create } from 'zustand'
import type { WorkspaceEntry } from '@shared/types'
import { call, onEvent } from '@/lib/ipc'
import { pushToast } from '@/stores/toasts'

export interface OpenFile {
  /** Workspace-relative path, '/'-separated. */
  path: string
  content: string
  /** mtime of the last loaded/saved disk state — writeFile's expectedMtime guard. */
  savedMtime: number
  dirty: boolean
  /** Changed on disk under local edits (or a guarded write was refused). */
  conflict: boolean
}

function parentDir(path: string): string {
  const i = path.lastIndexOf('/')
  return i === -1 ? '' : path.slice(0, i)
}

// Cmd+S is handled by both a monaco command and a DOM keydown fallback — the
// in-flight set absorbs the double fire so two writes never race one mtime.
const savingPaths = new Set<string>()

interface CodeStore {
  /** Absolute path of the open workspace; null = empty state. */
  root: string | null
  /** Loaded listings keyed by workspace-relative dir ('' = the root level). */
  childrenByDir: Record<string, WorkspaceEntry[]>
  expanded: Record<string, boolean>
  openFiles: OpenFile[]
  activePath: string | null
  initialized: boolean
  init: () => Promise<void>
  /** Native folder picker -> openWorkspace. No-op when cancelled. */
  pickWorkspace: () => Promise<void>
  openWorkspace: (root: string) => Promise<void>
  closeWorkspace: () => Promise<void>
  toggleDir: (dir: string) => void
  loadDir: (dir: string) => Promise<void>
  openFile: (path: string) => Promise<void>
  setActive: (path: string) => void
  edit: (path: string, content: string) => void
  /** overwrite skips the expectedMtime guard — the conflict bar's Overwrite. */
  save: (path: string, opts?: { overwrite?: boolean }) => Promise<void>
  reloadFromDisk: (path: string) => Promise<void>
  /** Drops the buffer without saving — callers confirm dirty closes first. */
  closeFile: (path: string) => void
}

export const useCodeStore = create<CodeStore>((set, get) => ({
  root: null,
  childrenByDir: {},
  expanded: {},
  openFiles: [],
  activePath: null,
  initialized: false,

  init: async () => {
    if (get().initialized) return
    set({ initialized: true })

    onEvent('code.fsChanged', (event) => {
      if (event.root !== get().root) return
      const dirs = new Set<string>()
      for (const path of event.paths) {
        dirs.add(parentDir(path))
        const file = get().openFiles.find((f) => f.path === path)
        if (!file) continue
        if (file.dirty) {
          // May be the echo of our own save — flag only if the disk actually
          // diverged from the last saved state (writeFile's +1ms tolerance).
          void call('code.readFile', { root: event.root, path })
            .then(({ mtime }) => {
              if (get().root !== event.root) return
              set((s) => ({
                openFiles: s.openFiles.map((f) =>
                  f.path === path && f.dirty && mtime > f.savedMtime + 1
                    ? { ...f, conflict: true }
                    : f
                )
              }))
            })
            .catch(() => {
              // Unreadable now (deleted/moved?) — surface the conflict bar.
              set((s) => ({
                openFiles: s.openFiles.map((f) => (f.path === path ? { ...f, conflict: true } : f))
              }))
            })
        } else {
          // Clean buffers follow the disk silently; re-check dirty at apply
          // time in case an edit landed while the read was in flight.
          void call('code.readFile', { root: event.root, path })
            .then(({ content, mtime }) => {
              if (get().root !== event.root) return
              set((s) => ({
                openFiles: s.openFiles.map((f) =>
                  f.path === path && !f.dirty
                    ? { ...f, content, savedMtime: mtime, conflict: false }
                    : f
                )
              }))
            })
            .catch(() => {
              // Unreadable now (deleted/moved?) — surface the conflict bar.
              set((s) => ({
                openFiles: s.openFiles.map((f) => (f.path === path ? { ...f, conflict: true } : f))
              }))
            })
        }
      }
      for (const dir of dirs) {
        if (!get().childrenByDir[dir]) continue // never loaded — nothing to refresh
        void call('code.listDir', { root: event.root, dir })
          .then(({ entries }) => {
            if (get().root !== event.root) return
            set((s) => ({ childrenByDir: { ...s.childrenByDir, [dir]: entries } }))
          })
          .catch(() => {
            // The dir itself is gone; its parent's refresh removes the row.
            // Also collapse it so a recreated dir re-expands with a fresh
            // loadDir instead of rendering a stuck "Loading…".
            set((s) => {
              const { [dir]: _c, ...childrenByDir } = s.childrenByDir
              const { [dir]: _e, ...expanded } = s.expanded
              return { childrenByDir, expanded }
            })
          })
      }
    })

    const { path } = await call('code.lastWorkspace')
    if (path && get().root === null) {
      // A stale last-workspace (moved/deleted) just lands on the empty state.
      await get()
        .openWorkspace(path)
        .catch(() => {})
    }
  },

  pickWorkspace: async () => {
    const { path } = await call('code.pickWorkspace')
    if (!path) return
    await get().openWorkspace(path)
  },

  openWorkspace: async (root) => {
    const prev = get().root
    const { entries } = await call('code.openWorkspace', { root })
    if (prev === root) {
      // Re-picked the same folder — just refresh the top level.
      set((s) => ({ childrenByDir: { ...s.childrenByDir, '': entries } }))
      return
    }
    // Open the new root first so a failed pick keeps the old workspace intact.
    if (prev) void call('code.closeWorkspace', { root: prev }).catch(() => {})
    set({
      root,
      childrenByDir: { '': entries },
      expanded: {},
      openFiles: [],
      activePath: null
    })
  },

  closeWorkspace: async () => {
    const root = get().root
    if (!root) return
    set({ root: null, childrenByDir: {}, expanded: {}, openFiles: [], activePath: null })
    await call('code.closeWorkspace', { root })
  },

  toggleDir: (dir) => {
    const expand = !get().expanded[dir]
    set((s) => ({ expanded: { ...s.expanded, [dir]: expand } }))
    if (expand && !get().childrenByDir[dir]) {
      void get()
        .loadDir(dir)
        .catch((err) =>
          pushToast('error', err instanceof Error ? err.message : String(err))
        )
    }
  },

  loadDir: async (dir) => {
    const root = get().root
    if (!root) return
    const { entries } = await call('code.listDir', { root, dir })
    if (get().root !== root) return
    set((s) => ({ childrenByDir: { ...s.childrenByDir, [dir]: entries } }))
  },

  openFile: async (path) => {
    if (get().openFiles.some((f) => f.path === path)) {
      set({ activePath: path })
      return
    }
    const root = get().root
    if (!root) return
    const { content, mtime } = await call('code.readFile', { root, path })
    if (get().root !== root) return
    set((s) =>
      s.openFiles.some((f) => f.path === path)
        ? { activePath: path } // double-click race — keep the first buffer
        : {
            openFiles: [
              ...s.openFiles,
              { path, content, savedMtime: mtime, dirty: false, conflict: false }
            ],
            activePath: path
          }
    )
  },

  setActive: (path) => {
    if (get().openFiles.some((f) => f.path === path)) set({ activePath: path })
  },

  edit: (path, content) => {
    set((s) => ({
      openFiles: s.openFiles.map((f) => (f.path === path ? { ...f, content, dirty: true } : f))
    }))
  },

  save: async (path, opts) => {
    const root = get().root
    const file = get().openFiles.find((f) => f.path === path)
    if (!root || !file) return
    if (!file.dirty && !file.conflict) return
    if (savingPaths.has(path)) return
    savingPaths.add(path)
    try {
      const result = await call('code.writeFile', {
        root,
        path,
        content: file.content,
        expectedMtime: opts?.overwrite ? undefined : file.savedMtime
      })
      if (result.conflict) {
        set((s) => ({
          openFiles: s.openFiles.map((f) => (f.path === path ? { ...f, conflict: true } : f))
        }))
        return
      }
      set((s) => ({
        openFiles: s.openFiles.map((f) =>
          f.path === path
            ? {
                ...f,
                // Edits that landed during the write keep the buffer dirty.
                dirty: f.content !== file.content,
                savedMtime: result.mtime ?? f.savedMtime,
                conflict: false
              }
            : f
        )
      }))
    } finally {
      savingPaths.delete(path)
    }
  },

  reloadFromDisk: async (path) => {
    const root = get().root
    if (!root) return
    const { content, mtime } = await call('code.readFile', { root, path })
    if (get().root !== root) return
    set((s) => ({
      openFiles: s.openFiles.map((f) =>
        f.path === path ? { ...f, content, savedMtime: mtime, dirty: false, conflict: false } : f
      )
    }))
  },

  closeFile: (path) => {
    set((s) => {
      const index = s.openFiles.findIndex((f) => f.path === path)
      if (index === -1) return {}
      const openFiles = s.openFiles.filter((f) => f.path !== path)
      return {
        openFiles,
        activePath:
          s.activePath === path
            ? (openFiles[Math.min(index, openFiles.length - 1)]?.path ?? null)
            : s.activePath
      }
    })
  }
}))
