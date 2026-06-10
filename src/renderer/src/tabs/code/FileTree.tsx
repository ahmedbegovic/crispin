import { ChevronRight } from 'lucide-react'
import type { WorkspaceEntry } from '@shared/types'
import { useCodeStore } from '@/stores/code'
import { toastError } from '@/stores/toasts'

const INDENT_PX = 12
const BASE_PAD_PX = 8
/** Chevron width + gap — keeps file names aligned with sibling dir names. */
const FILE_EXTRA_PAD_PX = 17

function TreeNode({ entry, depth }: { entry: WorkspaceEntry; depth: number }) {
  const expanded = useCodeStore((s) => Boolean(s.expanded[entry.path]))
  const active = useCodeStore((s) => s.activePath === entry.path)
  const toggleDir = useCodeStore((s) => s.toggleDir)
  const openFile = useCodeStore((s) => s.openFile)

  if (entry.kind === 'dir') {
    return (
      <>
        <button
          onClick={() => toggleDir(entry.path)}
          title={entry.path}
          style={{ paddingLeft: BASE_PAD_PX + depth * INDENT_PX }}
          className="flex w-full items-center gap-1 py-[3px] pr-2 text-left text-[12px] text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200"
        >
          <ChevronRight
            size={12}
            className={`shrink-0 text-zinc-600 transition-transform ${expanded ? 'rotate-90' : ''}`}
          />
          <span className="truncate">{entry.name}</span>
        </button>
        {expanded && <TreeLevel dir={entry.path} depth={depth + 1} />}
      </>
    )
  }
  return (
    <button
      onClick={() => void openFile(entry.path).catch(toastError)}
      title={entry.path}
      style={{ paddingLeft: BASE_PAD_PX + FILE_EXTRA_PAD_PX + depth * INDENT_PX }}
      className={`flex w-full items-center py-[3px] pr-2 text-left text-[12px] ${
        active ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200'
      }`}
    >
      <span className="truncate">{entry.name}</span>
    </button>
  )
}

function TreeLevel({ dir, depth }: { dir: string; depth: number }) {
  const entries = useCodeStore((s) => s.childrenByDir[dir])
  if (!entries)
    return (
      <div
        style={{ paddingLeft: BASE_PAD_PX + FILE_EXTRA_PAD_PX + depth * INDENT_PX }}
        className="py-[3px] text-[11px] text-zinc-600"
      >
        Loading…
      </div>
    )
  if (entries.length === 0 && depth > 0)
    return (
      <div
        style={{ paddingLeft: BASE_PAD_PX + FILE_EXTRA_PAD_PX + depth * INDENT_PX }}
        className="py-[3px] text-[11px] italic text-zinc-700"
      >
        empty
      </div>
    )
  return (
    <>
      {entries.map((entry) => (
        <TreeNode key={entry.path} entry={entry} depth={depth} />
      ))}
    </>
  )
}

export default function FileTree() {
  return (
    <aside className="flex w-60 shrink-0 flex-col border-r border-zinc-800/80 bg-zinc-950/50">
      {/* pt-10 clears the hiddenInset titlebar drag region overlay (h-9). */}
      <div className="shrink-0 px-3 pb-1.5 pt-10 text-[10.5px] font-semibold uppercase tracking-wider text-zinc-600">
        Files
      </div>
      <div className="no-drag min-h-0 flex-1 overflow-y-auto pb-2">
        <TreeLevel dir="" depth={0} />
      </div>
    </aside>
  )
}
