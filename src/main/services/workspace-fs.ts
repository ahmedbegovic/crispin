import { readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { watch, type FSWatcher } from 'chokidar'
import type { OrionEvent } from '@shared/ipc'
import type { WorkspaceEntry } from '@shared/types'
import { scopedLogger } from './logger'

/** Noise directories hidden from listings and the watcher alike. */
const IGNORED_DIRS = new Set(['.git', 'node_modules', '.venv', 'dist', 'out', '__pycache__'])
const FS_DEBOUNCE_MS = 250
const MAX_FILE_BYTES = 2 * 1024 * 1024

export interface WorkspaceFsDeps {
  broadcast: (event: OrionEvent) => void
}

interface WatchedRoot {
  watcher: FSWatcher
  /** Workspace-relative '/'-separated paths accumulated for the next flush. */
  pending: Set<string>
  timer: NodeJS.Timeout | null
}

/**
 * Jailed fs access + change watching for Code workspaces. Every path op goes
 * through jailed(), which refuses absolute inputs, '..' segments, and symlink
 * escapes (realpath of the parent must stay under the realpathed root). One
 * chokidar watcher per open root batches events into debounced code.fsChanged
 * broadcasts. Only one workspace is expected open at a time, but watchers are
 * keyed by root regardless.
 */
export class WorkspaceFs {
  /** Keyed by resolve(root) — the same string the renderer round-trips. */
  private readonly watchers = new Map<string, WatchedRoot>()
  private readonly log = scopedLogger('workspace')

  constructor(private readonly deps: WorkspaceFsDeps) {}

  openWorkspace(root: string): WorkspaceEntry[] {
    const key = resolve(root)
    let isDir = false
    try {
      isDir = statSync(key).isDirectory()
    } catch {
      // missing path — same rejection below
    }
    if (!isDir) throw new Error(`Not a directory: ${root}`)
    if (!this.watchers.has(key)) this.startWatcher(key)
    return this.listDir(key, '')
  }

  async closeWorkspace(root: string): Promise<void> {
    const watched = this.watchers.get(resolve(root))
    if (!watched) return
    this.watchers.delete(resolve(root))
    if (watched.timer) clearTimeout(watched.timer)
    await watched.watcher.close()
  }

  listDir(root: string, dir: string): WorkspaceEntry[] {
    const { abs, rel } = this.jailed(root, dir)
    const entries = readdirSync(abs, { withFileTypes: true })
      .filter((d) => !IGNORED_DIRS.has(d.name))
      .map<WorkspaceEntry>((d) => {
        let isDir = d.isDirectory()
        if (d.isSymbolicLink()) {
          try {
            isDir = statSync(join(abs, d.name)).isDirectory()
          } catch {
            // broken link — treat as a file
          }
        }
        return {
          name: d.name,
          path: rel ? `${rel}/${d.name}` : d.name,
          kind: isDir ? 'dir' : 'file'
        }
      })
    return entries.sort((a, b) =>
      a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'dir' ? -1 : 1
    )
  }

  readFile(root: string, path: string): { content: string; mtime: number } {
    const { abs } = this.jailed(root, path)
    const stat = statSync(abs)
    if (!stat.isFile()) throw new Error(`Not a regular file: ${path}`)
    if (stat.size > MAX_FILE_BYTES) {
      throw new Error(
        `File is too large to open (${(stat.size / (1024 * 1024)).toFixed(1)} MB; limit is 2 MB)`
      )
    }
    const buf = readFileSync(abs)
    if (buf.includes(0)) throw new Error(`File appears to be binary: ${path}`)
    return { content: buf.toString('utf8'), mtime: Math.round(stat.mtimeMs) }
  }

  writeFile(
    root: string,
    path: string,
    content: string,
    expectedMtime?: number
  ): { ok: boolean; mtime: number | null; conflict: boolean } {
    const { abs } = this.jailed(root, path)
    if (expectedMtime !== undefined) {
      let diskMtime: number | null = null
      try {
        diskMtime = Math.round(statSync(abs).mtimeMs)
      } catch {
        // deleted on disk — the save below recreates it
      }
      // +1ms tolerance: our own last write rounded the stored mtime.
      if (diskMtime !== null && diskMtime > expectedMtime + 1) {
        return { ok: false, mtime: diskMtime, conflict: true }
      }
    }
    writeFileSync(abs, content)
    return { ok: true, mtime: Math.round(statSync(abs).mtimeMs), conflict: false }
  }

  async dispose(): Promise<void> {
    await Promise.all([...this.watchers.keys()].map((root) => this.closeWorkspace(root)))
  }

  // --- watcher -----------------------------------------------------------------

  private startWatcher(key: string): void {
    const watched: WatchedRoot = {
      watcher: watch(key, {
        ignored: (path: string) => this.isNoise(key, path),
        ignoreInitial: true,
        persistent: true,
        followSymlinks: false
      }),
      pending: new Set(),
      timer: null
    }
    watched.watcher.on('all', (_event, path) => {
      const rel = relative(key, path)
      if (!rel || rel.startsWith('..') || isAbsolute(rel)) return
      watched.pending.add(rel.split(sep).join('/'))
      // The first event arms the flush; later ones ride along in the batch
      // (a fixed window, not a sliding one, so heavy churn can't starve it).
      if (!watched.timer) {
        watched.timer = setTimeout(() => this.flushChanges(key), FS_DEBOUNCE_MS)
      }
    })
    watched.watcher.on('error', (err) => {
      this.log.warn(`watcher error for ${key}: ${err instanceof Error ? err.message : err}`)
    })
    this.watchers.set(key, watched)
    this.log.info(`watching ${key}`)
  }

  private flushChanges(key: string): void {
    const watched = this.watchers.get(key)
    if (!watched) return
    watched.timer = null
    if (watched.pending.size === 0) return
    const paths = [...watched.pending].sort()
    watched.pending.clear()
    this.deps.broadcast({ type: 'code.fsChanged', root: key, paths })
  }

  /** chokidar hands the matcher absolute '/'-normalized paths. */
  private isNoise(root: string, path: string): boolean {
    const rel = relative(root, path)
    if (!rel || rel.startsWith('..')) return false
    return rel.split('/').some((segment) => IGNORED_DIRS.has(segment))
  }

  // --- path jail ----------------------------------------------------------------

  /**
   * Resolves a workspace-relative path to { abs, rel: normalized '/'-form }.
   * The realpath comparisons keep macOS symlinked roots (/tmp → /private/tmp)
   * working while still rejecting symlinked parents that point outside.
   */
  private jailed(root: string, relPath: string): { abs: string; rel: string } {
    if (isAbsolute(relPath)) throw new Error(`Path must be workspace-relative: ${relPath}`)
    const segments = relPath.split('/').filter((s) => s !== '' && s !== '.')
    if (segments.includes('..')) throw new Error(`Path escapes the workspace: ${relPath}`)
    const rootReal = realpathSync(resolve(root))
    if (segments.length === 0) return { abs: rootReal, rel: '' }
    const abs = join(rootReal, ...segments)
    // Defense in depth — the segment filtering above already guarantees this.
    if (!abs.startsWith(rootReal + sep)) throw new Error(`Path escapes the workspace: ${relPath}`)
    const parentReal = realpathSync(dirname(abs))
    if (parentReal !== rootReal && !parentReal.startsWith(rootReal + sep)) {
      throw new Error(`Path escapes the workspace: ${relPath}`)
    }
    return { abs: join(parentReal, basename(abs)), rel: segments.join('/') }
  }
}
