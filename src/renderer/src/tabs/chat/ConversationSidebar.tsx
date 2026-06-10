import { useState } from 'react'
import { Archive, ArchiveRestore, Plus, Trash2 } from 'lucide-react'
import type { ConversationMeta } from '@shared/types'
import { useChatStore } from '@/stores/chat'
import { toastError } from '@/stores/toasts'
import { relativeTime } from '@/lib/format'
import ConfirmDialog from '@/components/ConfirmDialog'

export default function ConversationSidebar() {
  const conversations = useChatStore((s) => s.conversations)
  const activeId = useChatStore((s) => s.activeId)
  const showArchived = useChatStore((s) => s.showArchived)
  const select = useChatStore((s) => s.select)
  const create = useChatStore((s) => s.create)
  const update = useChatStore((s) => s.update)
  const remove = useChatStore((s) => s.remove)
  const setShowArchived = useChatStore((s) => s.setShowArchived)
  const [deleteTarget, setDeleteTarget] = useState<ConversationMeta | null>(null)

  return (
    <aside className="flex w-64 shrink-0 flex-col border-r border-zinc-800/80 bg-zinc-950/50">
      {/* pt-10 clears the hiddenInset titlebar drag region overlay (h-9). */}
      <div className="shrink-0 px-3 pb-2 pt-10">
        <button
          onClick={() => void create().catch(toastError)}
          className="no-drag flex w-full items-center justify-center gap-1.5 rounded-lg border border-zinc-800 bg-zinc-900 py-1.5 text-[12px] font-medium text-zinc-300 hover:border-zinc-600 hover:text-zinc-100"
        >
          <Plus size={13} />
          New chat
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {conversations.length === 0 ? (
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
                  <span
                    className={`block truncate text-[12.5px] ${
                      active ? 'text-zinc-100' : 'text-zinc-300'
                    }`}
                  >
                    {conversation.title || 'New chat'}
                  </span>
                  <span className="block text-[10.5px] text-zinc-600">
                    {relativeTime(conversation.updatedAt)}
                  </span>
                </button>
                <div className="hidden shrink-0 items-center gap-0.5 pr-1.5 group-hover:flex">
                  <button
                    onClick={() =>
                      void update(conversation.id, { archived: !conversation.archived }).catch(
                        toastError
                      )
                    }
                    title={conversation.archived ? 'Unarchive' : 'Archive'}
                    className="rounded p-1 text-zinc-500 hover:bg-zinc-700 hover:text-zinc-200"
                  >
                    {conversation.archived ? <ArchiveRestore size={12} /> : <Archive size={12} />}
                  </button>
                  <button
                    onClick={() => setDeleteTarget(conversation)}
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
