import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFileSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, normalize, relative, resolve, sep } from 'node:path'
import { shell } from 'electron'
import type { CrispinEvent } from '@shared/ipc'
import type { GitFileStatus, GitLogEntry, GitStatus } from '@shared/types'
import { scopedLogger } from './logger'

const execFileP = promisify(execFile)

const GIT_TIMEOUT_MS = 10_000
/** git show payloads above this never reach the renderer (diffs stay snappy). */
const SHOW_MAX_BYTES = 2 * 1024 * 1024
const LOG_DEFAULT_LIMIT = 100

export interface GitServiceDeps {
  /** Roots must be workspaces the renderer actually opened — never arbitrary paths. */
  isOpenRoot: (root: string) => boolean
  broadcast: (event: CrispinEvent) => void
}

/**
 * Thin `git` CLI wrapper jailed to open workspaces. Pure plumbing — every
 * mutation broadcasts git.changed so the renderer re-pulls status (`.git` is
 * in chokidar's ignore list, so fs events never cover commits).
 */
export class GitService {
  private readonly logger = scopedLogger('git')
  /** First failed spawn toasts once (missing Xcode CLT is the usual cause). */
  private warnedUnavailable = false

  constructor(private readonly deps: GitServiceDeps) {}

  async status(root: string): Promise<GitStatus> {
    let out: string
    try {
      // -uall lists untracked FILES (not collapsed 'dir/' entries) so tree
      // decorations and Changes rows always name real paths.
      out = await this.git(root, [
        'status',
        '--porcelain=v2',
        '--branch',
        '--untracked-files=all',
        '-z'
      ])
    } catch (err) {
      if (err instanceof Error && /not a git repository/i.test(err.message)) {
        return { repo: false, branch: null, ahead: 0, behind: 0, files: [] }
      }
      throw err
    }
    const parsed = parsePorcelainV2(out)
    // Porcelain paths are TOPLEVEL-relative; the IPC contract (and every
    // consumer: decorations, stage/discard pathspecs, trashItem joins) is
    // workspace-relative. A workspace below the repo root must translate —
    // and drop entries outside the workspace entirely.
    const toplevel = (await this.git(root, ['rev-parse', '--show-toplevel'])).trim()
    const prefix = relative(toplevel, resolve(root)).split(sep).join('/')
    if (prefix) {
      const p = `${prefix}/`
      parsed.files = parsed.files
        .filter((f) => f.path.startsWith(p))
        .map((f) => ({
          ...f,
          path: f.path.slice(p.length),
          renamedFrom:
            f.renamedFrom && f.renamedFrom.startsWith(p) ? f.renamedFrom.slice(p.length) : null
        }))
    }
    return { repo: true, ...parsed }
  }

  async stage(root: string, paths: string[]): Promise<void> {
    await this.git(root, ['add', '--', ...this.relPaths(paths)])
    this.changed(root)
  }

  async unstage(root: string, paths: string[]): Promise<void> {
    const rel = this.relPaths(paths)
    try {
      await this.git(root, ['restore', '--staged', '--', ...rel])
    } catch (err) {
      // Unborn branch (nothing committed yet): restore needs HEAD; drop the
      // entries from the index instead. -f because rm --cached refuses files
      // edited after staging — safe, --cached never touches the worktree.
      if (err instanceof Error && /HEAD/i.test(err.message)) {
        await this.git(root, ['rm', '--cached', '-r', '-f', '--quiet', '--', ...rel])
      } else {
        throw err
      }
    }
    this.changed(root)
  }

  /**
   * Tracked files restore from the index; untracked ones go to the macOS
   * Trash (recoverable — never `git clean -f`).
   */
  async discard(root: string, paths: string[]): Promise<void> {
    const rel = this.relPaths(paths)
    const { files } = await this.status(root)
    const untracked = new Set(files.filter((f) => f.untracked).map((f) => f.path))
    const tracked = rel.filter((p) => !untracked.has(p))
    if (tracked.length > 0) await this.git(root, ['restore', '--', ...tracked])
    for (const p of rel.filter((p) => untracked.has(p))) {
      await shell.trashItem(join(resolve(root), p.split('/').join(sep)))
    }
    this.changed(root)
  }

  async commit(root: string, message: string): Promise<{ hash: string }> {
    if (!message.trim()) throw new Error('Commit message is empty')
    await this.git(root, ['commit', '-m', message])
    const hash = (await this.git(root, ['rev-parse', 'HEAD'])).trim()
    this.changed(root)
    return { hash }
  }

  async log(root: string, path?: string, limit = LOG_DEFAULT_LIMIT): Promise<GitLogEntry[]> {
    const args = ['log', `--pretty=format:%H%x00%an%x00%at%x00%s`, '-n', String(limit)]
    if (path) args.push('--follow', '--', ...this.relPaths([path]))
    let out: string
    try {
      out = await this.git(root, args)
    } catch (err) {
      // Unborn branch / empty repo — an empty history, not an error.
      if (err instanceof Error && /does not have any commits|bad default revision/i.test(err.message)) {
        return []
      }
      throw err
    }
    return out
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [hash, author, at, subject] = line.split('\0')
        return { hash, author, timeMs: Number(at) * 1000, subject: subject ?? '' }
      })
      .filter((e) => e.hash)
  }

  /** File content at a ref; null for binaries and >2MB payloads. */
  async show(root: string, ref: string, path: string): Promise<string | null> {
    // ':' admits index refs (':0'); a leading '-' would parse as an option.
    if (!/^[\w.:/~^-]+$/.test(ref) || ref.startsWith('-')) {
      throw new Error(`Invalid ref: ${ref}`)
    }
    const [rel] = this.relPaths([path])
    let out: string
    try {
      // './' anchors the path to the cwd (the workspace) — bare paths in a
      // <ref>:<path> spec are TOPLEVEL-relative and break subdir workspaces.
      out = await this.git(root, ['show', `${ref}:./${rel}`])
    } catch {
      return null // path absent at that ref (new file, unborn HEAD)
    }
    if (Buffer.byteLength(out) > SHOW_MAX_BYTES || out.includes('\0')) return null
    return out
  }

  /**
   * Both sides of a Monaco diff. staged: HEAD vs index; unstaged: index vs
   * worktree (falling back to HEAD when the file was never staged).
   */
  async diffFile(
    root: string,
    path: string,
    staged: boolean
  ): Promise<{ original: string; modified: string }> {
    const [rel] = this.relPaths([path])
    if (staged) {
      return {
        original: (await this.show(root, 'HEAD', rel)) ?? '',
        modified: (await this.show(root, ':0', rel)) ?? ''
      }
    }
    const indexSide = (await this.show(root, ':0', rel)) ?? (await this.show(root, 'HEAD', rel)) ?? ''
    let worktree = ''
    try {
      worktree = readFileSync(join(resolve(root), rel.split('/').join(sep)), 'utf8')
    } catch {
      // deleted in the worktree — an empty modified side reads correctly
    }
    return { original: indexSide, modified: worktree }
  }

  async init(root: string): Promise<void> {
    await this.git(root, ['init'])
    this.changed(root)
  }

  /** Append to .gitignore, deduped against existing lines. */
  ignoreAdd(root: string, pattern: string): void {
    this.assertRoot(root)
    const trimmed = pattern.trim()
    if (!trimmed) return
    const file = join(resolve(root), '.gitignore')
    let existing = ''
    try {
      existing = readFileSync(file, 'utf8')
    } catch {
      // no .gitignore yet
    }
    if (existing.split('\n').some((line) => line.trim() === trimmed)) return
    const body = existing.length > 0 && !existing.endsWith('\n') ? `${existing}\n` : existing
    writeFileSync(file, `${body}${trimmed}\n`)
    this.changed(root)
  }

  // --- plumbing ---------------------------------------------------------------

  private assertRoot(root: string): void {
    if (!this.deps.isOpenRoot(root)) throw new Error('Not an open workspace')
  }

  /** Workspace-relative '/'-separated paths only — no absolutes, no escapes. */
  private relPaths(paths: string[]): string[] {
    if (paths.length === 0) throw new Error('No paths given')
    return paths.map((p) => {
      const normalized = normalize(p).split(sep).join('/')
      if (
        isAbsolute(p) ||
        normalized === '..' ||
        normalized.startsWith('../') ||
        normalized === '' ||
        normalized.startsWith('-')
      ) {
        throw new Error(`Invalid workspace path: ${p}`)
      }
      return normalized
    })
  }

  private async git(root: string, args: string[]): Promise<string> {
    this.assertRoot(root)
    try {
      const { stdout } = await execFileP('git', args, {
        cwd: resolve(root),
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: 16 * 1024 * 1024,
        // Never take optional locks — status must not block a concurrent
        // terminal-side git operation (and vice versa).
        env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' }
      })
      return stdout
    } catch (err) {
      const e = err as NodeJS.ErrnoException & { stderr?: string }
      // First spawn on a fresh macOS hits the missing-CLT stub — say so once.
      if ((e.code === 'ENOENT' || /xcrun|xcode-select/i.test(e.stderr ?? '')) && !this.warnedUnavailable) {
        this.warnedUnavailable = true
        this.deps.broadcast({
          type: 'system.toast',
          level: 'warn',
          message: 'git is not available — install the Xcode Command Line Tools (xcode-select --install).'
        })
      }
      const detail = (e.stderr ?? '').trim() || e.message
      this.logger.warn(`git ${args[0]} failed: ${detail}`)
      throw new Error(detail)
    }
  }

  private changed(root: string): void {
    this.deps.broadcast({ type: 'git.changed', root: resolve(root) })
  }
}

/**
 * Parse `git status --porcelain=v2 --branch -z`. Entries are NUL-separated;
 * a rename ('2') entry's ORIGINAL path arrives as the NEXT NUL token.
 */
function parsePorcelainV2(out: string): Omit<GitStatus, 'repo'> {
  let branch: string | null = null
  let ahead = 0
  let behind = 0
  const files: GitFileStatus[] = []

  const tokens = out.split('\0')
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    if (!token) continue
    if (token.startsWith('# branch.head ')) {
      const name = token.slice('# branch.head '.length)
      branch = name === '(detached)' ? null : name
    } else if (token.startsWith('# branch.ab ')) {
      const m = /\+(\d+) -(\d+)/.exec(token)
      if (m) {
        ahead = Number(m[1])
        behind = Number(m[2])
      }
    } else if (token.startsWith('? ')) {
      files.push({
        path: token.slice(2),
        indexState: '.',
        worktreeState: '.',
        untracked: true,
        renamedFrom: null
      })
    } else if (token.startsWith('1 ')) {
      // 1 XY sub mH mI mW hH hI <path>
      const parts = token.split(' ')
      const xy = parts[1] ?? '..'
      files.push({
        path: parts.slice(8).join(' '),
        indexState: xy[0] ?? '.',
        worktreeState: xy[1] ?? '.',
        untracked: false,
        renamedFrom: null
      })
    } else if (token.startsWith('2 ')) {
      // 2 XY sub mH mI mW hH hI Xscore <path> NUL <origPath>
      const parts = token.split(' ')
      const xy = parts[1] ?? '..'
      files.push({
        path: parts.slice(9).join(' '),
        indexState: xy[0] ?? '.',
        worktreeState: xy[1] ?? '.',
        untracked: false,
        renamedFrom: tokens[++i] ?? null
      })
    } else if (token.startsWith('u ')) {
      // u XY sub m1 m2 m3 mW h1 h2 h3 <path>
      const parts = token.split(' ')
      const xy = parts[1] ?? '..'
      files.push({
        path: parts.slice(10).join(' '),
        indexState: xy[0] ?? '.',
        worktreeState: xy[1] ?? '.',
        untracked: false,
        renamedFrom: null
      })
    }
  }
  return { branch, ahead, behind, files }
}
