import { statSync } from 'node:fs'
import { spawn, type IPty } from 'node-pty'
import type { CrispinEvent } from '@shared/ipc'
import { scopedLogger } from './logger'

const MAX_TERMINALS = 4
/** One renderer frame — batches chatty pty output into ~60Hz term.data events. */
const FLUSH_MS = 16

export interface TermServiceDeps {
  broadcast: (event: CrispinEvent) => void
}

interface Terminal {
  pty: IPty
  buffer: string
  flushTimer: NodeJS.Timeout | null
}

/** node-pty may abort on zero/fractional dimensions — never pass them through. */
const clampDim = (n: number): number => Math.max(1, Math.floor(n))

/**
 * Live node-pty terminals for the Code tab, keyed by termId. Scrollback is the
 * renderer's responsibility (xterm); main only pumps batched output through.
 */
export class TermService {
  private readonly terms = new Map<string, Terminal>()
  private disposed = false
  private readonly log = scopedLogger('term')

  constructor(private readonly deps: TermServiceDeps) {}

  create(cwd: string, cols: number, rows: number): string {
    if (this.disposed) throw new Error('terminal service is disposed')
    if (this.terms.size >= MAX_TERMINALS) {
      throw new Error(`Terminal limit reached (${MAX_TERMINALS}) — close one first.`)
    }
    let isDir = false
    try {
      isDir = statSync(cwd).isDirectory()
    } catch {
      // missing path — same rejection below
    }
    if (!isDir) throw new Error(`Not a directory: ${cwd}`)

    const termId = crypto.randomUUID()
    const shell = process.env.SHELL || '/bin/zsh'
    const pty = spawn(shell, ['-l'], {
      name: 'xterm-256color',
      cols: clampDim(cols),
      rows: clampDim(rows),
      cwd,
      env: { ...process.env, TERM: 'xterm-256color' }
    })
    const term: Terminal = { pty, buffer: '', flushTimer: null }
    this.terms.set(termId, term)
    pty.onData((data) => {
      term.buffer += data
      if (!term.flushTimer) {
        term.flushTimer = setTimeout(() => this.flush(termId, term), FLUSH_MS)
      }
    })
    pty.onExit(({ exitCode }) => {
      this.flush(termId, term)
      this.terms.delete(termId)
      this.deps.broadcast({ type: 'term.exit', termId, exitCode: exitCode ?? null })
    })
    this.log.info(`spawned ${shell} (pid ${pty.pid}) in ${cwd}`)
    return termId
  }

  // write/resize/kill tolerate unknown ids: the pty may have exited (term.exit
  // already broadcast) while the renderer's call was still in flight.

  write(termId: string, data: string): void {
    this.terms.get(termId)?.pty.write(data)
  }

  resize(termId: string, cols: number, rows: number): void {
    this.terms.get(termId)?.pty.resize(clampDim(cols), clampDim(rows))
  }

  kill(termId: string): void {
    const term = this.terms.get(termId)
    if (!term) return
    try {
      term.pty.kill() // onExit flushes, broadcasts term.exit, and cleans up
    } catch (err) {
      this.log.warn(`kill failed for ${termId}: ${err instanceof Error ? err.message : err}`)
      this.terms.delete(termId)
    }
  }

  dispose(): void {
    this.disposed = true
    for (const term of this.terms.values()) {
      if (term.flushTimer) clearTimeout(term.flushTimer)
      try {
        term.pty.kill()
      } catch {
        // already dead
      }
    }
    this.terms.clear()
  }

  private flush(termId: string, term: Terminal): void {
    if (term.flushTimer) {
      clearTimeout(term.flushTimer)
      term.flushTimer = null
    }
    if (!term.buffer) return
    const data = term.buffer
    term.buffer = ''
    this.deps.broadcast({ type: 'term.data', termId, data })
  }
}
