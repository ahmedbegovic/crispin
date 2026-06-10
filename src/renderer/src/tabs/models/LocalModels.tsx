import { useState } from 'react'
import { Trash2 } from 'lucide-react'
import { modelDisplayName } from '@shared/model-tiers'
import type { InstalledModel, ModelsOverview } from '@shared/types'
import { useModelsStore } from '@/stores/models'
import { toastError } from '@/stores/toasts'
import { formatBytes } from '@/lib/format'
import ConfirmDialog from '@/components/ConfirmDialog'

/** Model snapshots in the shared HF cache, with delete + unload-all controls. */
export default function LocalModels({ overview }: { overview: ModelsOverview }) {
  const deleteModel = useModelsStore((s) => s.deleteModel)
  const unloadAll = useModelsStore((s) => s.unloadAll)
  const [pendingDelete, setPendingDelete] = useState<InstalledModel | null>(null)

  const registryIds = new Set(overview.engine.models.map((m) => m.id))
  const anyLoaded = overview.engine.models.some((m) => m.state === 'loaded')
  const totalBytes = overview.installed.reduce((sum, m) => sum + m.sizeBytes, 0)

  return (
    <section>
      <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
        On disk
      </h2>
      <div className="divide-y divide-zinc-800/70 rounded-lg border border-zinc-800 bg-zinc-900/30">
        {overview.installed.length === 0 && (
          <p className="px-3 py-2 text-[12px] text-zinc-600">Nothing downloaded yet.</p>
        )}
        {overview.installed.map((model) => (
          <div key={model.repoId} className="flex items-center gap-3 px-3 py-2">
            {registryIds.has(model.repoId) && (
              <span
                className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500"
                title="In the engine registry"
              />
            )}
            <span className="flex-1 truncate text-[12px] text-zinc-200" title={model.repoId}>
              {modelDisplayName(model.repoId)}
            </span>
            <span className="text-[11px] tabular-nums text-zinc-500">
              {formatBytes(model.sizeBytes)}
            </span>
            <button
              onClick={() => setPendingDelete(model)}
              title="Delete from disk"
              className="rounded p-0.5 text-zinc-500 hover:bg-zinc-800 hover:text-red-400"
            >
              <Trash2 size={13} />
            </button>
          </div>
        ))}
        <div className="flex items-center justify-between px-3 py-2 text-[11px] text-zinc-500">
          <span>
            {overview.installed.length} model{overview.installed.length === 1 ? '' : 's'} ·{' '}
            {formatBytes(totalBytes)} on disk
          </span>
          {anyLoaded && (
            <button
              onClick={() => void unloadAll().catch(toastError)}
              className="rounded-md border border-zinc-700 px-2 py-0.5 text-[11px] text-zinc-400 hover:border-zinc-500 hover:text-zinc-200"
            >
              Unload all
            </button>
          )}
        </div>
      </div>
      <ConfirmDialog
        open={pendingDelete !== null}
        title="Delete model"
        body={`This removes ${pendingDelete?.repoId ?? ''} (${formatBytes(
          pendingDelete?.sizeBytes ?? 0
        )}) from the Hugging Face cache.`}
        confirmLabel="Delete"
        danger
        onConfirm={() => {
          // Surfaces the sidecar's 409 when the repo is still downloading ("cancel it first").
          if (pendingDelete) void deleteModel(pendingDelete.repoId).catch(toastError)
          setPendingDelete(null)
        }}
        onCancel={() => setPendingDelete(null)}
      />
    </section>
  )
}
