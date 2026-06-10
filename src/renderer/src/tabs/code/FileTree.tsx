import { createContext, useContext, useRef, useState, type MouseEvent } from 'react'
import { ChevronRight } from 'lucide-react'
import type { WorkspaceEntry } from '@shared/types'
import { hasClipboard, useCodeStore } from '@/stores/code'
import { pushToast, toastError } from '@/stores/toasts'
import ConfirmDialog from '@/components/ConfirmDialog'
import TreeContextMenu, { type MenuEntry } from './TreeContextMenu'

const INDENT_PX = 12
const BASE_PAD_PX = 8
/** Chevron width + gap — keeps file names aligned with sibling dir names. */
const FILE_EXTRA_PAD_PX = 17

type Editing =
  | { kind: 'create'; entryKind: 'file' | 'dir'; dir: string }
  | { kind: 'rename'; path: string }

interface TreeUi {
  openMenu: (e: MouseEvent, entry: WorkspaceEntry | null) => void
  editing: Editing | null
  commitEditing: (name: string) => Promise<void>
  cancelEditing: () => void
}

const TreeUiContext = createContext<TreeUi>({
  openMenu: () => {},
  editing: null,
  commitEditing: async () => {},
  cancelEditing: () => {}
})

function InlineNameInput({ initial }: { initial: string }) {
  const { commitEditing, cancelEditing } = useContext(TreeUiContext)
  // A successful Enter unmounts the input — the flag keeps the resulting blur
  // from firing a cancel over the commit.
  const committing = useRef(false)

  const commit = (input: HTMLInputElement): void => {
    const name = input.value.trim()
    if (!name) return
    if (name.includes('/')) {
      pushToast('error', 'Names cannot contain "/"')
      return
    }
    committing.current = true
    void commitEditing(name).catch((err) => {
      committing.current = false
      toastError(err) // input stays open for another attempt
    })
  }

  return (
    <input
      autoFocus
      defaultValue={initial}
      onContextMenu={(e) => e.stopPropagation()}
      onFocus={(e) => e.currentTarget.select()}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit(e.currentTarget)
        else if (e.key === 'Escape') cancelEditing()
      }}
      onBlur={() => {
        if (!committing.current) cancelEditing()
      }}
      className="w-full min-w-0 rounded-sm border border-emerald-600/70 bg-zinc-900 px-1 text-[12px] text-zinc-100 outline-none"
    />
  )
}

function TreeNode({ entry, depth }: { entry: WorkspaceEntry; depth: number }) {
  const { openMenu, editing } = useContext(TreeUiContext)
  const expanded = useCodeStore((s) => Boolean(s.expanded[entry.path]))
  const active = useCodeStore((s) => s.activePath === entry.path)
  const cutPending = useCodeStore(
    (s) => s.clipboard?.op === 'cut' && s.clipboard.path === entry.path
  )
  const toggleDir = useCodeStore((s) => s.toggleDir)
  const openFile = useCodeStore((s) => s.openFile)

  const renaming = editing?.kind === 'rename' && editing.path === entry.path
  const cutClass = cutPending ? ' opacity-40' : ''

  if (entry.kind === 'dir') {
    return (
      <>
        {renaming ? (
          <div
            style={{ paddingLeft: BASE_PAD_PX + depth * INDENT_PX }}
            className="flex items-center gap-1 py-[3px] pr-2"
          >
            <ChevronRight
              size={12}
              className={`shrink-0 text-zinc-600 transition-transform ${expanded ? 'rotate-90' : ''}`}
            />
            <InlineNameInput initial={entry.name} />
          </div>
        ) : (
          <button
            onClick={() => toggleDir(entry.path)}
            onContextMenu={(e) => openMenu(e, entry)}
            title={entry.path}
            style={{ paddingLeft: BASE_PAD_PX + depth * INDENT_PX }}
            className={`flex w-full items-center gap-1 py-[3px] pr-2 text-left text-[12px] text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200${cutClass}`}
          >
            <ChevronRight
              size={12}
              className={`shrink-0 text-zinc-600 transition-transform ${expanded ? 'rotate-90' : ''}`}
            />
            <span className="truncate">{entry.name}</span>
          </button>
        )}
        {expanded && <TreeLevel dir={entry.path} depth={depth + 1} />}
      </>
    )
  }
  if (renaming) {
    return (
      <div
        style={{ paddingLeft: BASE_PAD_PX + FILE_EXTRA_PAD_PX + depth * INDENT_PX }}
        className="py-[3px] pr-2"
      >
        <InlineNameInput initial={entry.name} />
      </div>
    )
  }
  return (
    <button
      onClick={() => void openFile(entry.path).catch(toastError)}
      onContextMenu={(e) => openMenu(e, entry)}
      title={entry.path}
      style={{ paddingLeft: BASE_PAD_PX + FILE_EXTRA_PAD_PX + depth * INDENT_PX }}
      className={`flex w-full items-center py-[3px] pr-2 text-left text-[12px] ${
        active ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200'
      }${cutClass}`}
    >
      <span className="truncate">{entry.name}</span>
    </button>
  )
}

function TreeLevel({ dir, depth }: { dir: string; depth: number }) {
  const entries = useCodeStore((s) => s.childrenByDir[dir])
  const { editing } = useContext(TreeUiContext)
  const creating = editing?.kind === 'create' && editing.dir === dir
  if (!entries)
    return (
      <div
        style={{ paddingLeft: BASE_PAD_PX + FILE_EXTRA_PAD_PX + depth * INDENT_PX }}
        className="py-[3px] text-[11px] text-zinc-600"
      >
        Loading…
      </div>
    )
  if (entries.length === 0 && depth > 0 && !creating)
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
      {creating && (
        <div
          style={{ paddingLeft: BASE_PAD_PX + FILE_EXTRA_PAD_PX + depth * INDENT_PX }}
          className="py-[3px] pr-2"
        >
          <InlineNameInput initial="" />
        </div>
      )}
      {entries.map((entry) => (
        <TreeNode key={entry.path} entry={entry} depth={depth} />
      ))}
    </>
  )
}

export default function FileTree() {
  const [menu, setMenu] = useState<{ x: number; y: number; entry: WorkspaceEntry | null } | null>(
    null
  )
  const [editing, setEditing] = useState<Editing | null>(null)
  const [trashTarget, setTrashTarget] = useState<WorkspaceEntry | null>(null)

  const openMenu = (e: MouseEvent, entry: WorkspaceEntry | null): void => {
    e.preventDefault()
    e.stopPropagation() // row menus beat the container's root-context handler
    setMenu({ x: e.clientX, y: e.clientY, entry })
  }

  const commitEditing = async (name: string): Promise<void> => {
    if (!editing) return
    const s = useCodeStore.getState()
    if (editing.kind === 'rename') await s.renameEntry(editing.path, name)
    else if (editing.entryKind === 'file') await s.createFile(editing.dir, name)
    else await s.createDir(editing.dir, name)
    setEditing(null)
  }

  const startCreate = (entryKind: 'file' | 'dir', dir: string): void => {
    const s = useCodeStore.getState()
    if (dir && !s.expanded[dir]) s.toggleDir(dir) // the input renders inside the level
    setEditing({ kind: 'create', entryKind, dir })
  }

  const deleteToTrash = (entry: WorkspaceEntry): void => {
    void useCodeStore
      .getState()
      .deleteEntry(entry.path)
      .then(() => pushToast('info', 'Moved to Trash'))
      .catch(toastError)
  }

  const itemsFor = (entry: WorkspaceEntry | null): MenuEntry[] => {
    const s = useCodeStore.getState()
    if (!entry) {
      return [
        { label: 'New File…', onClick: () => startCreate('file', '') },
        { label: 'New Folder…', onClick: () => startCreate('dir', '') },
        {
          label: 'Paste',
          disabled: !hasClipboard(),
          onClick: () => void s.pasteInto('').catch(toastError)
        },
        'separator',
        { label: 'Reveal in Finder', onClick: () => void s.reveal('').catch(toastError) }
      ]
    }
    const isDir = entry.kind === 'dir'
    return [
      ...(isDir
        ? ([
            { label: 'New File…', onClick: () => startCreate('file', entry.path) },
            { label: 'New Folder…', onClick: () => startCreate('dir', entry.path) },
            'separator'
          ] satisfies MenuEntry[])
        : []),
      { label: 'Cut', onClick: () => s.setClipboard(entry.path, 'cut') },
      { label: 'Copy', onClick: () => s.setClipboard(entry.path, 'copy') },
      ...(isDir
        ? ([
            {
              label: 'Paste',
              disabled: !hasClipboard(),
              onClick: () => void s.pasteInto(entry.path).catch(toastError)
            }
          ] satisfies MenuEntry[])
        : []),
      'separator',
      { label: 'Rename…', onClick: () => setEditing({ kind: 'rename', path: entry.path }) },
      { label: 'Duplicate', onClick: () => void s.duplicateEntry(entry.path).catch(toastError) },
      'separator',
      { label: 'Copy Path', onClick: () => void navigator.clipboard.writeText(entry.path) },
      { label: 'Reveal in Finder', onClick: () => void s.reveal(entry.path).catch(toastError) },
      'separator',
      {
        label: 'Delete',
        danger: true,
        onClick: () => (isDir ? setTrashTarget(entry) : deleteToTrash(entry))
      }
    ]
  }

  const ui: TreeUi = { openMenu, editing, commitEditing, cancelEditing: () => setEditing(null) }

  return (
    <aside className="flex w-60 shrink-0 flex-col border-r border-zinc-800/80 bg-zinc-950/50">
      {/* pt-12 clears the hiddenInset titlebar band (h-12, traffic lights centered). */}
      <div className="shrink-0 px-3 pb-1.5 pt-12 text-[10.5px] font-semibold uppercase tracking-wider text-zinc-600">
        Files
      </div>
      <div
        className="no-drag min-h-0 flex-1 overflow-y-auto pb-2"
        onContextMenu={(e) => openMenu(e, null)}
      >
        <TreeUiContext.Provider value={ui}>
          <TreeLevel dir="" depth={0} />
        </TreeUiContext.Provider>
      </div>
      {menu && (
        <TreeContextMenu
          x={menu.x}
          y={menu.y}
          items={itemsFor(menu.entry)}
          onClose={() => setMenu(null)}
        />
      )}
      <ConfirmDialog
        open={trashTarget !== null}
        title="Move to Trash?"
        body={`The folder "${trashTarget?.name ?? ''}" and everything inside it will move to the Trash.`}
        confirmLabel="Move to Trash"
        danger
        onConfirm={() => {
          if (trashTarget) deleteToTrash(trashTarget)
          setTrashTarget(null)
        }}
        onCancel={() => setTrashTarget(null)}
      />
    </aside>
  )
}
