import { useEffect, useState } from 'react'
import {
  Archive,
  ArchiveRestore,
  Download,
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
import { relativeTime } from '@/lib/format'
import ConfirmDialog from '@/components/ConfirmDialog'

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

export default function ConversationSidebar(): React.JSX.Element {
  const conversations = useChatStore((s) => s.conversations)
  const activeId = useChatStore((s) => s.activeId)
  const showArchived = useChatStore((s) => s.showArchived)
  const select = useChatStore((s) => s.select)
  const create = useChatStore((s) => s.create)
  const update = useChatStore((s) => s.update)
  const remove = useChatStore((s) => s.remove)
  const setShowArchived = useChatStore((s) => s.setShowArchived)
  const [deleteTarget, setDeleteTarget] = useState<ConversationMeta | null>(null)
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

  return (
    <aside className="flex w-64 shrink-0 flex-col border-r border-zinc-800/80 bg-zinc-950/50">
      <div className="drag-region flex h-12 shrink-0 items-center px-3">
        <button
          onClick={() => void create().catch(toastError)}
          className="no-drag flex w-full items-center justify-center gap-1.5 rounded-lg border border-zinc-800 bg-zinc-900 py-1.5 text-[12px] font-medium text-zinc-300 hover:border-zinc-600 hover:text-zinc-100"
        >
          <Plus size={13} />
          New chat
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
                <span className="block truncate text-[12.5px] text-zinc-200">
                  {hit.title || 'New chat'}
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
          conversations.map((conversation) => {
            const active = conversation.id === activeId
            return (
              <div
                key={conversation.id}
                className={`group relative mb-0.5 flex items-center rounded-md ${
                  active ? 'bg-zinc-800' : 'hover:bg-zinc-900'
                }`}
              >
                <button
                  onClick={() => void select(conversation.id).catch(toastError)}
                  className="min-w-0 flex-1 px-2.5 py-1.5 text-left"
                >
                  <span className="flex items-center gap-1">
                    {conversation.pinned && <Pin size={9} className="shrink-0 text-amber-500/80" />}
                    <span
                      className={`truncate text-[12.5px] ${
                        active ? 'text-zinc-100' : 'text-zinc-300'
                      }`}
                    >
                      {conversation.title || 'New chat'}
                    </span>
                  </span>
                  <span className="block text-[10.5px] text-zinc-600">
                    {relativeTime(conversation.updatedAt)}
                  </span>
                </button>
                <div className="flex shrink-0 items-center gap-0.5 pr-1.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                  <button
                    onClick={() =>
                      void update(conversation.id, { pinned: !conversation.pinned }).catch(
                        toastError
                      )
                    }
                    aria-label={conversation.pinned ? 'Unpin conversation' : 'Pin conversation'}
                    title={conversation.pinned ? 'Unpin' : 'Pin'}
                    className="rounded p-1 text-zinc-500 hover:bg-zinc-700 hover:text-amber-400"
                  >
                    {conversation.pinned ? <PinOff size={12} /> : <Pin size={12} />}
                  </button>
                  <button
                    onClick={() => exportChat(conversation.id)}
                    aria-label="Export to Markdown"
                    title="Export to Markdown"
                    className="rounded p-1 text-zinc-500 hover:bg-zinc-700 hover:text-zinc-200"
                  >
                    <Download size={12} />
                  </button>
                  <button
                    onClick={() =>
                      void update(conversation.id, { archived: !conversation.archived }).catch(
                        toastError
                      )
                    }
                    aria-label={conversation.archived ? 'Unarchive conversation' : 'Archive conversation'}
                    title={conversation.archived ? 'Unarchive' : 'Archive'}
                    className="rounded p-1 text-zinc-500 hover:bg-zinc-700 hover:text-zinc-200"
                  >
                    {conversation.archived ? <ArchiveRestore size={12} /> : <Archive size={12} />}
                  </button>
                  <button
                    onClick={() => setDeleteTarget(conversation)}
                    aria-label="Delete conversation"
                    title="Delete"
                    className="rounded p-1 text-zinc-500 hover:bg-zinc-700 hover:text-red-400"
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              </div>
            )
          })
        )}
      </div>

      <div className="shrink-0 border-t border-zinc-800/80 px-3 py-2">
        <button
          onClick={() => void setShowArchived(!showArchived).catch(toastError)}
          className={`text-[11px] ${
            showArchived ? 'text-zinc-200' : 'text-zinc-600 hover:text-zinc-400'
          }`}
        >
          {showArchived ? '← Back to chats' : 'Archived'}
        </button>
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
    </aside>
  )
}
