import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import * as fsp from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { shell } from 'electron'
import { watch, type FSWatcher } from 'chokidar'
import type { CrispinEvent } from '@shared/ipc'
import type { WorkspaceEntry } from '@shared/types'
import { scopedLogger } from './logger'

/** Noise directories hidden from listings and the watcher alike. */
const IGNORED_DIRS = new Set(['.git', 'node_modules', '.venv', 'dist', 'out', '__pycache__'])
const FS_DEBOUNCE_MS = 250
const MAX_FILE_BYTES = 2 * 1024 * 1024

export interface WorkspaceFsDeps {
  broadcast: (event: CrispinEvent) => void
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

  /** True for roots the renderer has opened — the git service's jail check. */
  isOpenRoot(root: string): boolean {
    return this.watchers.has(resolve(root))
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

  createFile(root: string, path: string): void {
    const { abs } = this.jailedTarget(root, path)
    if (existsSync(abs)) throw new Error(`Already exists: ${path}`)
    writeFileSync(abs, '')
  }

  createDir(root: string, path: string): void {
    const { abs } = this.jailedTarget(root, path)
    if (existsSync(abs)) throw new Error(`Already exists: ${path}`)
    mkdirSync(abs)
  }

  move(root: string, from: string, to: string): void {
    const src = this.jailed(root, from)
    const dst = this.jailedTarget(root, to)
    if (!existsSync(src.abs)) throw new Error(`No such file or directory: ${from}`)
    // On case-insensitive APFS, existsSync('Foo') is true while renaming
    // 'foo' → 'Foo' — a case-only rename of the SAME entry is legal and
    // renameSync handles it in place. Only a genuinely different entry blocks.
    const caseOnly = src.abs !== dst.abs && src.abs.toLowerCase() === dst.abs.toLowerCase()
    if (!caseOnly && existsSync(dst.abs)) throw new Error(`Already exists: ${to}`)
    this.refuseIntoSelf(src.abs, dst.abs, 'move', from)
    renameSync(src.abs, dst.abs)
  }

  copy(root: string, from: string, to: string): void {
    const src = this.jailed(root, from)
    const dst = this.jailedTarget(root, to)
    if (!existsSync(src.abs)) throw new Error(`No such file or directory: ${from}`)
    if (existsSync(dst.abs)) throw new Error(`Already exists: ${to}`)
    this.refuseIntoSelf(src.abs, dst.abs, 'copy', from)
    cpSync(src.abs, dst.abs, { recursive: true, errorOnExist: true, force: false })
  }

  /** Recoverable delete — macOS Trash, never a hard unlink. */
  async deleteEntry(root: string, path: string): Promise<void> {
    const { abs, rel } = this.jailed(root, path)
    if (rel === '') throw new Error('Refusing to trash the workspace root')
    if (!existsSync(abs)) throw new Error(`No such file or directory: ${path}`)
    await shell.trashItem(abs)
  }

  revealEntry(root: string, path: string): void {
    const { abs } = this.jailed(root, path)
    shell.showItemInFolder(abs)
  }

  /** Context menu's "Open in Default App" — macOS picks the handler. */
  async openDefault(root: string, path: string): Promise<void> {
    const { abs } = this.jailed(root, path)
    const error = await shell.openPath(abs)
    if (error) throw new Error(error)
  }

  /** PERMANENT delete (rm -rf) — the UI confirms before calling. */
  deletePermanent(root: string, path: string): void {
    const { abs, rel } = this.jailed(root, path)
    if (rel === '') throw new Error('Refusing to delete the workspace root')
    if (!existsSync(abs)) throw new Error(`No such file or directory: ${path}`)
    rmSync(abs, { recursive: true, force: true })
  }

  /**
   * Case-insensitive literal search under dir. Skips noise dirs, >2MB files
   * and binaries; capped (results carry 1-based line/column for Monaco).
   * Async file IO on purpose: this runs in the MAIN process and re-runs per
   * debounced keystroke — a synchronous scan would freeze the whole app.
   */
  async searchInFolder(
    root: string,
    dir: string,
    query: string,
    maxResults = 500
  ): Promise<Array<{ path: string; line: number; column: number; preview: string }>> {
    const start = this.jailed(root, dir)
    const needle = query.toLowerCase()
    const results: Array<{ path: string; line: number; column: number; preview: string }> = []
    if (!needle) return results

    const walk = async (dirAbs: string, dirRel: string): Promise<void> => {
      if (results.length >= maxResults) return
      let entries
      try {
        entries = await fsp.readdir(dirAbs, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        if (results.length >= maxResults) return
        const rel = dirRel ? `${dirRel}/${entry.name}` : entry.name
        const abs = join(dirAbs, entry.name)
        if (entry.isDirectory()) {
          if (!IGNORED_DIRS.has(entry.name)) await walk(abs, rel)
          continue
        }
        if (!entry.isFile()) continue
        try {
          if ((await fsp.stat(abs)).size > MAX_FILE_BYTES) continue
        } catch {
          continue
        }
        let text: string
        try {
          text = await fsp.readFile(abs, 'utf8')
        } catch {
          continue
        }
        if (text.includes('\0')) continue // binary
        if (!text.toLowerCase().includes(needle)) continue
        const lines = text.split('\n')
        for (let i = 0; i < lines.length && results.length < maxResults; i++) {
          const column = lines[i].toLowerCase().indexOf(needle)
          if (column === -1) continue
          results.push({
            path: rel,
            line: i + 1,
            column: column + 1,
            preview: lines[i].trim().slice(0, 200)
          })
        }
      }
    }
    await walk(start.abs, start.rel)
    return results
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

  /**
   * jailed() for paths being created (new entries, move/copy destinations):
   * a missing intermediate directory otherwise surfaces as realpathSync's
   * cryptic ENOENT, and a file in the parent position would only fail at the
   * eventual fs call.
   */
  private jailedTarget(root: string, relPath: string): { abs: string; rel: string } {
    let target: { abs: string; rel: string }
    try {
      target = this.jailed(root, relPath)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error(`Parent directory does not exist: ${relPath}`)
      }
      throw err
    }
    if (target.rel !== '' && !statSync(dirname(target.abs)).isDirectory()) {
      throw new Error(`Parent directory does not exist: ${relPath}`)
    }
    return target
  }

  /**
   * renameSync EINVALs (cryptically) when a directory is targeted at its own
   * subtree, and cpSync would recurse forever — refuse upfront. Callers verify
   * the source exists first, so statSync here is safe.
   */
  private refuseIntoSelf(
    srcAbs: string,
    dstAbs: string,
    verb: 'move' | 'copy',
    from: string
  ): void {
    if (!statSync(srcAbs).isDirectory()) return
    if (dstAbs === srcAbs || dstAbs.startsWith(srcAbs + sep)) {
      throw new Error(`Cannot ${verb} a directory into itself: ${from}`)
    }
  }
}
