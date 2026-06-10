import './monaco-setup'
import { useEffect, useState } from 'react'
import { Code2, FolderOpen, SquareTerminal } from 'lucide-react'
import { useCodeStore } from '@/stores/code'
import { toastError } from '@/stores/toasts'
import ConfirmDialog from '@/components/ConfirmDialog'
import FileTree from './FileTree'
import EditorPane from './EditorPane'
import TerminalPane from './TerminalPane'
import AgentPanel from './AgentPanel'

function dirName(path: string): string {
  return path.split('/').filter(Boolean).pop() ?? path
}

export default function CodeTab() {
  const init = useCodeStore((s) => s.init)
  const root = useCodeStore((s) => s.root)
  const pickWorkspace = useCodeStore((s) => s.pickWorkspace)
  const dirtyCount = useCodeStore((s) => s.openFiles.reduce((n, f) => (f.dirty ? n + 1 : n), 0))
  const [terminalOpen, setTerminalOpen] = useState(true)
  const [switchConfirm, setSwitchConfirm] = useState(false)

  useEffect(() => {
    void init().catch(toastError)
  }, [init])

  // Switching workspaces drops all buffers — confirm before discarding edits.
  const requestPickWorkspace = (): void => {
    if (useCodeStore.getState().openFiles.some((f) => f.dirty)) setSwitchConfirm(true)
    else void pickWorkspace().catch(toastError)
  }

  if (!root) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4">
        <Code2 size={32} strokeWidth={1.5} className="text-zinc-700" />
        <div className="text-center">
          <h2 className="text-[14px] font-medium text-zinc-300">No workspace</h2>
          <p className="mt-1 text-[12px] text-zinc-600">
            Open a folder to edit files, run a terminal and pair with the agent on code.
          </p>
        </div>
        <button
          onClick={() => void pickWorkspace().catch(toastError)}
          className="no-drag flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-1.5 text-[12px] font-medium text-white hover:bg-emerald-500"
        >
          <FolderOpen size={14} />
          Open folder
        </button>
      </div>
    )
  }

  return (
    <div className="flex h-full">
      <FileTree />
      <div className="flex min-w-0 flex-1 flex-col">
        {/* pt-12 clears the hiddenInset titlebar band (h-12, traffic lights centered). */}
        <header className="flex shrink-0 items-center gap-2.5 border-b border-zinc-800/80 px-4 pb-2.5 pt-12">
          <span className="shrink-0 text-[13px] font-medium text-zinc-200">{dirName(root)}</span>
          <span title={root} className="min-w-0 truncate text-[11px] text-zinc-600">
            {root}
          </span>
          <div className="no-drag ml-auto flex shrink-0 items-center gap-0.5">
            <button
              onClick={() => setTerminalOpen((prev) => !prev)}
              title={terminalOpen ? 'Hide terminal' : 'Show terminal'}
              className={`rounded-md p-1.5 hover:bg-zinc-800 hover:text-zinc-200 ${
                terminalOpen ? 'text-zinc-300' : 'text-zinc-500'
              }`}
            >
              <SquareTerminal size={14} />
            </button>
            <button
              onClick={requestPickWorkspace}
              title="Open folder"
              className="rounded-md p-1.5 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
            >
              <FolderOpen size={14} />
            </button>
          </div>
        </header>
        <div className="min-h-0 flex-1">
          <EditorPane />
        </div>
        {/* Keyed by root: a workspace switch remounts, killing the old pty. */}
        <TerminalPane key={root} root={root} open={terminalOpen} />
      </div>
      <AgentPanel root={root} />
      <ConfirmDialog
        open={switchConfirm}
        title="Discard unsaved changes?"
        body={
          dirtyCount === 1
            ? '1 open file has unsaved changes. Switching workspaces will discard them.'
            : `${dirtyCount} open files have unsaved changes. Switching workspaces will discard them.`
        }
        confirmLabel="Discard"
        danger
        onConfirm={() => {
          setSwitchConfirm(false)
          void pickWorkspace().catch(toastError)
        }}
        onCancel={() => setSwitchConfirm(false)}
      />
    </div>
  )
}
