import { useState } from 'react'
import { Pause, Play, X } from 'lucide-react'
import { modelDisplayName } from '@shared/model-tiers'
import type { DownloadInfo, ModelsOverview } from '@shared/types'
import { useModelsStore } from '@/stores/models'
import { toastError } from '@/stores/toasts'
import { formatBytes } from '@/lib/format'
import ConfirmDialog from '@/components/ConfirmDialog'

/** Keep finished/failed rows visible (dimmed) for a few minutes. */
const RECENT_MS = 5 * 60_000

function isActive(d: DownloadInfo): boolean {
  return d.status === 'queued' || d.status === 'downloading'
}

/** Live (downloading) or parked-but-resumable (paused) — gets controls, no dimming. */
function isLive(d: DownloadInfo): boolean {
  return isActive(d) || d.status === 'paused'
}

function StatusLabel({ download }: { download: DownloadInfo }) {
  switch (download.status) {
    case 'queued':
      return <span className="text-[11px] text-amber-400">queued</span>
    case 'paused':
      return <span className="text-[11px] text-orange-400">paused</span>
    case 'done':
      return <span className="text-[11px] text-emerald-400">done</span>
    case 'failed':
      return <span className="text-[11px] text-red-400">failed</span>
    case 'cancelled':
      return <span className="text-[11px] text-zinc-500">cancelled</span>
    default:
      return null
  }
}

const iconBtn =
  'rounded p-0.5 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200'

/** Active HF downloads, paused (resumable) ones, plus recently finished; hidden when empty. */
export default function DownloadsPanel({ overview }: { overview: ModelsOverview }) {
  const cancelDownload = useModelsStore((s) => s.cancelDownload)
  const download = useModelsStore((s) => s.download)
  // The X discards the partial — confirm first so a misclick can't toss a big one.
  const [confirmDelete, setConfirmDelete] = useState<DownloadInfo | null>(null)

  const now = Date.now()
  const visible = overview.downloads
    .filter((d) => isLive(d) || (d.finishedAt !== null && now - d.finishedAt < RECENT_MS))
    .sort((a, b) => b.startedAt - a.startedAt)
  if (visible.length === 0) return null

  return (
    <section>
      <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
        Downloads
      </h2>
      <div className="divide-y divide-zinc-800/70 rounded-lg border border-zinc-800 bg-zinc-900/30">
        {visible.map((d) => (
          <div key={d.id} className={`px-3 py-2 ${isLive(d) ? '' : 'opacity-50'}`}>
            <div className="flex items-center gap-3">
              <span className="flex-1 truncate text-[12px] text-zinc-200" title={d.repoId}>
                {modelDisplayName(d.repoId)}
              </span>
              <span className="text-[11px] tabular-nums text-zinc-500">
                {formatBytes(d.bytesDone)}
                {d.bytesTotal !== null && ` / ${formatBytes(d.bytesTotal)}`}
              </span>
              <StatusLabel download={d} />
              {isActive(d) && (
                <button
                  onClick={() => void cancelDownload(d.id, false).catch(toastError)}
                  title="Pause (keep the partial — resumable)"
                  className={iconBtn}
                >
                  <Pause size={13} />
                </button>
              )}
              {d.status === 'paused' && (
                <button
                  onClick={() => void download(d.repoId).catch(toastError)}
                  title="Resume"
                  className={iconBtn}
                >
                  <Play size={13} />
                </button>
              )}
              {isLive(d) && (
                <button
                  onClick={() => setConfirmDelete(d)}
                  title="Cancel and delete the partial download"
                  className={iconBtn}
                >
                  <X size={13} />
                </button>
              )}
            </div>
            {d.status === 'downloading' && (
              <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-zinc-800">
                {d.bytesTotal !== null ? (
                  <div
                    className="h-full rounded-full bg-emerald-500 transition-[width]"
                    style={{ width: `${Math.min(100, (d.bytesDone / d.bytesTotal) * 100)}%` }}
                  />
                ) : (
                  // Total size unknown yet — indeterminate stripe.
                  <div className="h-full w-1/3 animate-pulse rounded-full bg-emerald-500/70" />
                )}
              </div>
            )}
            {d.error !== null && <p className="mt-1 text-[11px] text-red-400">{d.error}</p>}
          </div>
        ))}
      </div>
      <ConfirmDialog
        open={confirmDelete !== null}
        title="Discard partial download?"
        body={
          confirmDelete
            ? `Delete the ${formatBytes(confirmDelete.bytesDone)} already downloaded for ${modelDisplayName(confirmDelete.repoId)}? You'll have to start over to get this model.`
            : ''
        }
        confirmLabel="Discard"
        danger
        onConfirm={() => {
          if (confirmDelete) void cancelDownload(confirmDelete.id, true).catch(toastError)
          setConfirmDelete(null)
        }}
        onCancel={() => setConfirmDelete(null)}
      />
    </section>
  )
}
