import { useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import type { AgentSessionMeta } from '@shared/types'
import { useAgentStore } from '@/stores/agent'
import { toastError } from '@/stores/toasts'
import { relativeTime } from '@/lib/format'
import ConfirmDialog from '@/components/ConfirmDialog'

function dirName(directory: string): string {
  return directory.split('/').filter(Boolean).pop() ?? directory
}

export default function SessionSidebar() {
  // Code-panel sessions live in the same store; this sidebar lists only its own.
  const sessions = useAgentStore((s) => s.sessions).filter((x) => x.tab === 'agent')
  const activeId = useAgentStore((s) => s.activeId)
  const busyBySession = useAgentStore((s) => s.busyBySession)
  const select = useAgentStore((s) => s.select)
  const create = useAgentStore((s) => s.create)
  const remove = useAgentStore((s) => s.remove)
  const [deleteTarget, setDeleteTarget] = useState<AgentSessionMeta | null>(null)

  return (
    <aside className="flex w-64 shrink-0 flex-col border-r border-zinc-800/80 bg-zinc-950/50">
      {/* pt-10 clears the hiddenInset titlebar drag region overlay (h-9). */}
      <div className="shrink-0 px-3 pb-2 pt-10">
        <button
          onClick={() => void create().catch(toastError)}
          className="no-drag flex w-full items-center justify-center gap-1.5 rounded-lg border border-zinc-800 bg-zinc-900 py-1.5 text-[12px] font-medium text-zinc-300 hover:border-zinc-600 hover:text-zinc-100"
        >
          <Plus size={13} />
          New session
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {sessions.length === 0 ? (
          <p className="px-2 py-3 text-[11px] leading-relaxed text-zinc-600">
            No sessions yet. Pick a folder to start one — the agent works inside it.
          </p>
        ) : (
          sessions.map((session) => {
            const active = session.id === activeId
            return (
              <div
                key={session.id}
                className={`group relative mb-0.5 flex items-center rounded-md ${
                  active ? 'bg-zinc-800' : 'hover:bg-zinc-900'
                }`}
              >
                <button
                  onClick={() => void select(session.id).catch(toastError)}
                  className="min-w-0 flex-1 px-2.5 py-1.5 text-left"
                >
                  <span className="flex items-center gap-1.5">
                    {busyBySession[session.id] && (
                      <span
                        title="The agent is working"
                        className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-amber-400"
                      />
                    )}
                    <span
                      className={`block truncate text-[12.5px] ${
                        active ? 'text-zinc-100' : 'text-zinc-300'
                      }`}
                    >
                      {session.title || dirName(session.directory)}
                    </span>
                  </span>
                  <span
                    title={session.directory}
                    className="block truncate text-[10.5px] text-zinc-600"
                  >
                    {session.directory} · {relativeTime(session.lastUsedAt ?? session.createdAt)}
                  </span>
                </button>
                <div className="hidden shrink-0 items-center pr-1.5 group-hover:flex">
                  <button
                    onClick={() => setDeleteTarget(session)}
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

      <ConfirmDialog
        open={deleteTarget !== null}
        title="Delete session"
        body={`Delete "${
          deleteTarget ? deleteTarget.title || dirName(deleteTarget.directory) : ''
        }" and its history? Files in the folder are not touched.`}
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
