import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  Archive,
  ArchiveRestore,
  ClipboardCopy,
  Copy,
  Download,
  MoreHorizontal,
  Pin,
  PinOff,
  Plus,
  Search,
  Trash2,
  X
} from 'lucide-react'
import type { ChatSearchHit, ConversationMeta } from '@shared/types'
import { useChatStore } from '@/stores/chat'
import { call } from '@/lib/ipc'
import { pushToast, toastError } from '@/stores/toasts'
import { dateBucket, relativeTime, type DateBucket } from '@/lib/format'
import ConfirmDialog from '@/components/ConfirmDialog'

const BUCKET_ORDER: DateBucket[] = [
  'Today',
  'Yesterday',
  'Previous 7 Days',
  'Previous 30 Days',
  'Older'
]

interface ConversationGroup {
  label: string
  pinned: boolean
  items: ConversationMeta[]
}

/**
 * Break the flat list into a Pinned section (any pinned, kept in store order)
 * followed by date buckets — so the sidebar reads as dated groups instead of a
 * wall of near-identical titles. Pure/render-time: no store or schema change.
 * `allowPinned` is off in the archived view, where a Pinned section would hoist
 * pinned-and-archived rows out of their date bucket.
 */
export function groupConversations(
  list: ConversationMeta[],
  allowPinned: boolean
): ConversationGroup[] {
  const groups: ConversationGroup[] = []
  if (allowPinned) {
    const pinned = list.filter((c) => c.pinned)
    if (pinned.length) groups.push({ label: 'Pinned', pinned: true, items: pinned })
  }
  const byBucket = new Map<DateBucket, ConversationMeta[]>()
  for (const c of list) {
    if (allowPinned && c.pinned) continue
    const bucket = dateBucket(c.updatedAt)
    const arr = byBucket.get(bucket)
    if (arr) arr.push(c)
    else byBucket.set(bucket, [c])
  }
  for (const label of BUCKET_ORDER) {
    const items = byBucket.get(label)
    if (items?.length) groups.push({ label, pinned: false, items })
  }
  return groups
}

/** Render an fts5 snippet() string, bolding the <b>…</b> match marks (no HTML injection). */
function Snippet({ text }: { text: string }): React.JSX.Element {
  const out: React.JSX.Element[] = []
  let bold = false
  text.split(/(<b>|<\/b>)/).forEach((piece, i) => {
    if (piece === '<b>') bold = true
    else if (piece === '</b>') bold = false
    else if (piece)
      out.push(
        <span key={i} className={bold ? 'text-zinc-300' : undefined}>
          {piece}
        </span>
      )
  })
  return <>{out}</>
}

interface RowMenuState {
  conversation: ConversationMeta
  x: number
  y: number
}

const MENU_W = 176
const MENU_H = 196

/**
 * A conversation's row actions (pin / export / archive / delete), opened by the
 * kebab button or a right-click. Portalled to <body> with fixed positioning so
 * the sidebar's overflow-y-auto can't clip it; clamped to the viewport.
 */
function RowActionsMenu({
  conversation,
  x,
  y,
  onClose,
  onPin,
  onDuplicate,
  onCopy,
  onExport,
  onArchive,
  onDelete
}: RowMenuState & {
  onClose: () => void
  onPin: () => void
  onDuplicate: () => void
  onCopy: () => void
  onExport: () => void
  onArchive: () => void
  onDelete: () => void
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  const left = Math.max(8, Math.min(x, window.innerWidth - MENU_W - 8))
  const top = Math.max(8, Math.min(y, window.innerHeight - MENU_H))
  const row =
    'flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[12px] text-zinc-300 hover:bg-zinc-800'

  return createPortal(
    <div
      ref={ref}
      role="menu"
      style={{ position: 'fixed', left, top, width: MENU_W }}
      className="z-50 rounded-lg border border-zinc-700 bg-zinc-900 py-1 shadow-xl"
    >
      <button role="menuitem" onClick={() => { onClose(); onPin() }} className={row}>
        {conversation.pinned ? (
          <PinOff size={13} className="text-zinc-500" />
        ) : (
          <Pin size={13} className="text-zinc-500" />
        )}
        {conversation.pinned ? 'Unpin' : 'Pin'}
      </button>
      <button role="menuitem" onClick={() => { onClose(); onDuplicate() }} className={row}>
        <Copy size={13} className="text-zinc-500" />
        Duplicate
      </button>
      <button role="menuitem" onClick={() => { onClose(); onCopy() }} className={row}>
        <ClipboardCopy size={13} className="text-zinc-500" />
        Copy conversation
      </button>
      <button role="menuitem" onClick={() => { onClose(); onExport() }} className={row}>
        <Download size={13} className="text-zinc-500" />
        Export to Markdown
      </button>
      <button role="menuitem" onClick={() => { onClose(); onArchive() }} className={row}>
        {conversation.archived ? (
          <ArchiveRestore size={13} className="text-zinc-500" />
        ) : (
          <Archive size={13} className="text-zinc-500" />
        )}
        {conversation.archived ? 'Unarchive' : 'Archive'}
      </button>
      <div className="my-1 border-t border-zinc-800/80" />
      <button
        role="menuitem"
        onClick={() => { onClose(); onDelete() }}
        className={`${row} text-red-400 hover:bg-red-500/10`}
      >
        <Trash2 size={13} />
        Delete
      </button>
    </div>,
    document.body
  )
}

export default function ConversationSidebar(): React.JSX.Element {
  const conversations = useChatStore((s) => s.conversations)
  const activeId = useChatStore((s) => s.activeId)
  const streaming = useChatStore((s) => s.streaming)
  const showArchived = useChatStore((s) => s.showArchived)
  const select = useChatStore((s) => s.select)
  const create = useChatStore((s) => s.create)
  const update = useChatStore((s) => s.update)
  const remove = useChatStore((s) => s.remove)
  const duplicate = useChatStore((s) => s.duplicate)
  const setShowArchived = useChatStore((s) => s.setShowArchived)
  const [deleteTarget, setDeleteTarget] = useState<ConversationMeta | null>(null)
  const [menu, setMenu] = useState<RowMenuState | null>(null)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<ChatSearchHit[] | null>(null)

  // Debounced full-text search; empty query clears results (back to the list).
  useEffect(() => {
    const q = query.trim()
    if (!q) {
      setResults(null)
      return
    }
    let alive = true
    const t = setTimeout(() => {
      void call('chat.search', { query: q, limit: 30 })
        .then((r) => {
          if (alive) setResults(r.results)
        })
        .catch(() => {
          if (alive) setResults([])
        })
    }, 180)
    // alive guard: a slower earlier response must not clobber a newer query's.
    return () => {
      alive = false
      clearTimeout(t)
    }
  }, [query])

  const exportChat = (id: string): void => {
    void call('chat.export', { conversationId: id })
      .then((r) => pushToast('info', `Exported to ${r.path}`))
      .catch(toastError)
  }

  const copyChat = (id: string): void => {
    void call('chat.exportMarkdown', { conversationId: id })
      .then(async ({ markdown }) => {
        await navigator.clipboard.writeText(markdown)
        pushToast('info', 'Conversation copied')
      })
      .catch(toastError)
  }

  const isRunning = (id: string): boolean => id in streaming

  return (
    <aside className="flex w-72 shrink-0 flex-col border-r border-zinc-800/70 bg-[#0f0f12]">
      <div className="drag-region flex h-12 shrink-0 items-center gap-1.5 px-3">
        <button
          onClick={() => void create().catch(toastError)}
          className="no-drag flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-zinc-800 bg-zinc-900 py-1.5 text-[12px] font-medium text-zinc-300 hover:border-zinc-600 hover:text-zinc-100"
        >
          <Plus size={13} />
          New chat
        </button>
        {/* Archived lives here as a quiet toggle — no boxed footer rule. */}
        <button
          onClick={() => void setShowArchived(!showArchived).catch(toastError)}
          title={showArchived ? 'Back to active chats' : 'Show archived'}
          aria-label={showArchived ? 'Back to active chats' : 'Show archived'}
          aria-pressed={showArchived}
          className={`no-drag flex shrink-0 items-center justify-center rounded-lg border p-[7px] transition-colors ${
            showArchived
              ? 'border-zinc-700 bg-zinc-800 text-zinc-200'
              : 'border-zinc-800 bg-zinc-900 text-zinc-500 hover:border-zinc-600 hover:text-zinc-300'
          }`}
        >
          {showArchived ? <ArchiveRestore size={14} /> : <Archive size={14} />}
        </button>
      </div>

      <div className="no-drag px-2 pb-1.5">
        <div className="flex items-center gap-1.5 rounded-md border border-zinc-800 bg-zinc-900/60 px-2">
          <Search size={12} className="shrink-0 text-zinc-600" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search conversations…"
            aria-label="Search conversations"
            className="w-full bg-transparent py-1.5 text-[12px] text-zinc-200 outline-none placeholder:text-zinc-600"
          />
          {query && (
            <button
              onClick={() => setQuery('')}
              aria-label="Clear search"
              className="shrink-0 text-zinc-600 hover:text-zinc-300"
            >
              <X size={12} />
            </button>
          )}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {results !== null ? (
          results.length === 0 ? (
            <p className="px-2 py-3 text-[11px] text-zinc-600">No matches.</p>
          ) : (
            results.map((hit) => (
              <button
                key={hit.conversationId}
                onClick={() => void select(hit.conversationId).catch(toastError)}
                className={`mb-0.5 block w-full rounded-md px-2.5 py-1.5 text-left ${
                  hit.conversationId === activeId ? 'bg-zinc-800' : 'hover:bg-zinc-900'
                }`}
              >
                <span className="flex items-center gap-1.5 text-[12.5px] text-zinc-200">
                  {isRunning(hit.conversationId) && (
                    <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-emerald-500" />
                  )}
                  <span className="fade-edge-r min-w-0 flex-1">{hit.title || 'New chat'}</span>
                </span>
                {hit.snippet && (
                  <span className="mt-0.5 block truncate text-[10.5px] text-zinc-500">
                    <Snippet text={hit.snippet} />
                  </span>
                )}
              </button>
            ))
          )
        ) : conversations.length === 0 ? (
          <p className="px-2 py-3 text-[11px] text-zinc-600">
            {showArchived ? 'No archived conversations.' : 'No conversations yet.'}
          </p>
        ) : (
          groupConversations(conversations, !showArchived).map((group) => (
            <div key={group.label}>
              {/* Sticky quiet section label — the date group carries "when" so rows don't have to. */}
              <div
                className={`sticky top-0 z-[1] bg-[#0f0f12]/95 px-2.5 pb-1 pt-3 text-[10.5px] font-medium uppercase tracking-[0.08em] backdrop-blur-sm ${
                  group.pinned ? 'text-amber-500/70' : 'text-zinc-500'
                }`}
              >
                {group.label}
              </div>
              {group.items.map((conversation) => {
                const active = conversation.id === activeId
                return (
                  <div
                    key={conversation.id}
                    // Left spine carries state: emerald (breathing) = a run is alive,
                    // sky = you are here, transparent = idle (reserved 2px so nothing
                    // shifts). The pulse replaces the old per-row spinner.
                    className={`group relative mb-0.5 rounded-md border-l-2 ${
                      isRunning(conversation.id)
                        ? 'spine-pulse border-emerald-500 bg-emerald-500/[0.06]'
                        : active
                          ? 'border-sky-500/80 bg-sky-500/[0.06]'
                          : 'border-transparent hover:bg-zinc-900/70'
                    }`}
                    onContextMenu={(e) => {
                      e.preventDefault()
                      setMenu({ conversation, x: e.clientX, y: e.clientY })
                    }}
                  >
                    {/* Single-line title; relative time lives in the tooltip now. Actions
                        float over the scrim so nothing is reserved for them. */}
                    <button
                      onClick={() => void select(conversation.id).catch(toastError)}
                      title={relativeTime(conversation.updatedAt)}
                      aria-label={`${conversation.title || 'New chat'}, updated ${relativeTime(
                        conversation.updatedAt
                      )}`}
                      className="flex w-full items-center gap-1 px-2.5 py-1.5 text-left"
                    >
                      {conversation.pinned && <Pin size={9} className="shrink-0 text-amber-500/80" />}
                      {/* Non-color shape cue for the running state — survives reduced
                          motion (animate-pulse settles to a steady dot), so "generating"
                          isn't conveyed by spine hue alone. */}
                      {isRunning(conversation.id) && (
                        <span
                          aria-hidden
                          className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-emerald-500"
                        />
                      )}
                      {/* Edge-fade instead of an ellipsis; flex-1 so short titles don't fade. */}
                      <span
                        className={`fade-edge-r min-w-0 flex-1 text-[13px] leading-snug ${
                          active ? 'text-zinc-100' : 'text-zinc-400'
                        }`}
                      >
                        {conversation.title || 'New chat'}
                      </span>
                    </button>
                    {/* Scrim: fades the row over the title's right edge so revealed icons
                        never collide with the text. */}
                    <div
                      aria-hidden
                      className="pointer-events-none absolute inset-y-0 right-0 w-28 rounded-r-md bg-gradient-to-l from-[#0f0f12] via-[#0f0f12] to-transparent opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
                    />
                    {/* One kebab opens the actions menu (same menu as right-click);
                        stays visible while its menu is open. */}
                    <div
                      className={`absolute right-1 top-1/2 flex -translate-y-1/2 items-center transition-opacity ${
                        menu?.conversation.id === conversation.id
                          ? 'opacity-100'
                          : 'opacity-0 group-hover:opacity-100 focus-within:opacity-100'
                      }`}
                    >
                      <button
                        onClick={(e) => {
                          const r = e.currentTarget.getBoundingClientRect()
                          setMenu({ conversation, x: r.right - MENU_W, y: r.bottom + 4 })
                        }}
                        aria-label="Conversation actions"
                        aria-haspopup="menu"
                        title="Actions"
                        className="rounded p-1 text-zinc-500 hover:bg-zinc-700 hover:text-zinc-200"
                      >
                        <MoreHorizontal size={14} />
                      </button>
                    </div>
                  </div>
                )
              })}
            </div>
          ))
        )}
      </div>

      <ConfirmDialog
        open={deleteTarget !== null}
        title="Delete conversation"
        body={`Delete "${deleteTarget?.title || 'New chat'}" and all of its messages? This cannot be undone.`}
        confirmLabel="Delete"
        danger
        onConfirm={() => {
          if (deleteTarget) void remove(deleteTarget.id).catch(toastError)
          setDeleteTarget(null)
        }}
        onCancel={() => setDeleteTarget(null)}
      />

      {menu && (
        <RowActionsMenu
          conversation={menu.conversation}
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          onPin={() =>
            void update(menu.conversation.id, { pinned: !menu.conversation.pinned }).catch(toastError)
          }
          onDuplicate={() => void duplicate(menu.conversation.id).catch(toastError)}
          onCopy={() => copyChat(menu.conversation.id)}
          onExport={() => exportChat(menu.conversation.id)}
          onArchive={() =>
            void update(menu.conversation.id, { archived: !menu.conversation.archived }).catch(
              toastError
            )
          }
          onDelete={() => setDeleteTarget(menu.conversation)}
        />
      )}
    </aside>
  )
}
