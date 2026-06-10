import { useState } from 'react'
import { Trash2 } from 'lucide-react'
import type { ResearchRunMeta } from '@shared/types'
import { useResearchStore } from '@/stores/research'
import { toastError } from '@/stores/toasts'
import { relativeTime } from '@/lib/format'
import ConfirmDialog from '@/components/ConfirmDialog'
import NewResearch from './NewResearch'
import StatusPill from './StatusPill'

export default function RunSidebar() {
  const runs = useResearchStore((s) => s.runs)
  const activeId = useResearchStore((s) => s.activeId)
  const select = useResearchStore((s) => s.select)
  const remove = useResearchStore((s) => s.remove)
  const [deleteTarget, setDeleteTarget] = useState<ResearchRunMeta | null>(null)

  return (
    <aside className="flex w-72 shrink-0 flex-col border-r border-zinc-800/80 bg-zinc-950/50">
      {/* pt-12 clears the hiddenInset titlebar band (h-12, traffic lights centered). */}
      <div className="no-drag shrink-0 px-3 pb-3 pt-12">
        <NewResearch />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto border-t border-zinc-800/80 px-2 py-2">
        {runs.length === 0 ? (
          <p className="px-2 py-3 text-[11px] leading-relaxed text-zinc-600">
            No research yet. Ask a question above — the run searches, reads and synthesizes a
            cited report.
          </p>
        ) : (
          runs.map((run) => {
            const active = run.id === activeId
            return (
              <div
                key={run.id}
                className={`group relative mb-0.5 rounded-md ${
                  active ? 'bg-zinc-800' : 'hover:bg-zinc-900'
                }`}
              >
                <button
                  onClick={() => void select(run.id).catch(toastError)}
                  className="w-full px-2.5 py-2 text-left"
                >
                  <span
                    className={`line-clamp-2 text-[12px] leading-snug ${
                      active ? 'text-zinc-100' : 'text-zinc-300'
                    }`}
                  >
                    {run.question}
                  </span>
                  <span className="mt-1 flex items-center gap-1.5">
                    <StatusPill status={run.status} />
                    <span className="text-[10.5px] text-zinc-600">
                      {relativeTime(run.createdAt)}
                    </span>
                  </span>
                </button>
                <div className="absolute right-1.5 top-1.5 hidden group-hover:flex">
                  <button
                    onClick={() => setDeleteTarget(run)}
                    title="Delete"
                    className="rounded bg-zinc-900/80 p-1 text-zinc-500 hover:bg-zinc-700 hover:text-red-400"
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
        title="Delete research run"
        body={`Delete "${deleteTarget?.question ?? ''}" with its steps, sources and report? This cannot be undone.`}
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
