import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { RotateCw } from 'lucide-react'
import '@xterm/xterm/css/xterm.css'
import { call, onEvent } from '@/lib/ipc'
import { toastError } from '@/stores/toasts'

interface Props {
  /** Absolute workspace root — the shell's cwd. Key the component by it. */
  root: string
  /** Toggled pane visibility; the pty stays alive while hidden. */
  open: boolean
}

const TERMINAL_THEME = {
  background: '#0c0c0e',
  foreground: '#d4d4d8',
  cursor: '#d4d4d8',
  selectionBackground: '#3f3f46'
}

export default function TerminalPane({ root, open }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const termIdRef = useRef<string | null>(null)
  const restartingRef = useRef(false)
  // First reveal latches: the shell spawns once, then the pty stays alive
  // while the pane is hidden. State (not a ref) so StrictMode's simulated
  // remount re-runs the lifecycle effect below instead of skipping it.
  const [revealed, setRevealed] = useState(open)
  const [exited, setExited] = useState(false)

  useEffect(() => {
    if (open) setRevealed(true)
  }, [open])

  // One symmetric lifecycle: the xterm instance, the pty and the event
  // subscriptions are created together and torn down together, so a
  // cleanup + re-run (StrictMode's simulated remount) rebuilds a working
  // terminal instead of leaving a disposed one behind a stale latch.
  useEffect(() => {
    if (!revealed) return
    const el = containerRef.current
    if (!el) return
    let disposed = false

    const term = new Terminal({
      fontSize: 12,
      fontFamily: '"SF Mono", Menlo, monospace',
      scrollback: 5000,
      cursorBlink: true,
      theme: TERMINAL_THEME
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(el)
    fit.fit()
    term.onData((data) => {
      const termId = termIdRef.current
      if (termId) void call('term.write', { termId, data }).catch(() => {})
    })
    termRef.current = term
    fitRef.current = fit

    const offData = onEvent('term.data', (event) => {
      if (event.termId === termIdRef.current) termRef.current?.write(event.data)
    })
    const offExit = onEvent('term.exit', (event) => {
      if (event.termId !== termIdRef.current) return
      termIdRef.current = null
      setExited(true)
    })

    void call('term.create', { cwd: root, cols: term.cols, rows: term.rows })
      .then(({ termId }) => {
        if (disposed) {
          // Torn down while create was in flight — kill the orphan pty
          // instead of adopting it, so it never counts against the cap.
          void call('term.kill', { termId }).catch(() => {})
          return
        }
        termIdRef.current = termId
        setExited(false)
        term.focus()
      })
      .catch((err) => {
        if (disposed) return
        setExited(true) // the Restart overlay is the retry surface
        toastError(err)
      })

    return () => {
      disposed = true
      offData()
      offExit()
      // Cleanup also runs on workspace close/switch (the component is keyed
      // by root) — kill the pty along with the buffer.
      const termId = termIdRef.current
      if (termId) void call('term.kill', { termId }).catch(() => {})
      termIdRef.current = null
      term.dispose()
      termRef.current = null
      fitRef.current = null
    }
  }, [revealed, root])

  // The exited overlay's retry — reuses the live Terminal buffer.
  const restart = async (): Promise<void> => {
    const term = termRef.current
    if (!term || restartingRef.current) return
    restartingRef.current = true
    try {
      term.reset()
      const { termId } = await call('term.create', { cwd: root, cols: term.cols, rows: term.rows })
      if (termRef.current !== term) {
        // The lifecycle tore down mid-create — don't leak the pty.
        void call('term.kill', { termId }).catch(() => {})
        return
      }
      termIdRef.current = termId
      setExited(false)
      term.focus()
    } finally {
      restartingRef.current = false
    }
  }

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const observer = new ResizeObserver(() => {
      const term = termRef.current
      const fit = fitRef.current
      if (!term || !fit) return
      // A hidden pane (display:none) proposes no dimensions — skip until shown.
      const dims = fit.proposeDimensions()
      if (!dims || !Number.isFinite(dims.cols) || dims.cols < 2 || dims.rows < 1) return
      fit.fit()
      const termId = termIdRef.current
      if (termId)
        void call('term.resize', { termId, cols: term.cols, rows: term.rows }).catch(() => {})
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  return (
    <div
      className={`no-drag relative h-56 shrink-0 border-t border-zinc-800/80 bg-[#0c0c0e] ${
        open ? '' : 'hidden'
      }`}
    >
      <div ref={containerRef} className="absolute inset-0 pl-2 pt-1.5" />
      {exited && (
        <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 bg-black/70">
          <p className="text-[12px] text-zinc-500">The shell exited or failed to start.</p>
          <button
            onClick={() => void restart().catch(toastError)}
            className="flex items-center gap-1.5 rounded-lg border border-zinc-700 bg-zinc-900 px-2.5 py-1 text-[12px] font-medium text-zinc-300 hover:border-zinc-600 hover:text-zinc-100"
          >
            <RotateCw size={12} />
            Restart
          </button>
        </div>
      )}
    </div>
  )
}
