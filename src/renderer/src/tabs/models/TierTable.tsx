import { useState } from 'react'
import { modelDisplayName, TIER_ORDER, TIERS } from '@shared/model-tiers'
import type {
  DownloadInfo,
  EngineModelState,
  ModelsOverview,
  Tier,
  TierCandidateInfo
} from '@shared/types'
import { useModelsStore } from '@/stores/models'
import { pushToast, toastError } from '@/stores/toasts'
import ConfirmDialog from '@/components/ConfirmDialog'

const TIER_LABELS: Record<Tier, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  extraHigh: 'Extra high',
  ultra: 'Ultra'
}

interface ChipProps {
  candidate: TierCandidateInfo
  active: boolean
  /** Live state from overview.engine; falls back to the overview snapshot. */
  engineState: EngineModelState | null
  download: DownloadInfo | undefined
  onLoad: (repoId: string) => void
  onUnload: (repoId: string) => void
  onDownload: (repoId: string) => void
}

function CandidateChip({
  candidate,
  active,
  engineState,
  download,
  onLoad,
  onUnload,
  onDownload
}: ChipProps) {
  let action: React.ReactNode
  if (!candidate.installed) {
    action = download ? (
      <span className="animate-pulse text-[11px] tabular-nums text-amber-400">
        {download.bytesTotal !== null
          ? `${Math.floor((download.bytesDone / download.bytesTotal) * 100)}%`
          : 'downloading…'}
      </span>
    ) : (
      <button
        onClick={() => onDownload(candidate.repoId)}
        className="rounded-md border border-zinc-700 px-2 py-0.5 text-[11px] text-zinc-400 hover:border-zinc-500 hover:text-zinc-200"
      >
        Download
      </button>
    )
  } else if (engineState === 'loaded') {
    action = (
      <>
        <span className="flex items-center gap-1.5 text-[11px] text-emerald-400">
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-500" />
          Loaded
        </span>
        <button
          onClick={() => onUnload(candidate.repoId)}
          className="rounded-md border border-zinc-700 px-2 py-0.5 text-[11px] text-zinc-400 hover:border-zinc-500 hover:text-zinc-200"
        >
          Unload
        </button>
      </>
    )
  } else if (engineState === 'loading') {
    action = <span className="animate-pulse text-[11px] text-amber-400">Loading…</span>
  } else {
    action = (
      <button
        onClick={() => onLoad(candidate.repoId)}
        className="rounded-md bg-zinc-800 px-2 py-0.5 text-[11px] text-zinc-200 hover:bg-zinc-700"
      >
        Load
      </button>
    )
  }

  return (
    <div
      className={`flex items-center gap-2.5 rounded-lg border border-zinc-800 bg-zinc-900/60 px-2.5 py-1.5 ${
        active ? 'ring-1 ring-zinc-500/50' : ''
      }`}
    >
      <span className="max-w-56 truncate text-[12px] text-zinc-300" title={candidate.repoId}>
        {modelDisplayName(candidate.repoId)}
      </span>
      {action}
    </div>
  )
}

/** One row per quality tier: policy from model-tiers, live state from the overview. */
export default function TierTable({ overview }: { overview: ModelsOverview }) {
  const load = useModelsStore((s) => s.load)
  const unload = useModelsStore((s) => s.unload)
  const download = useModelsStore((s) => s.download)
  const [guard, setGuard] = useState<{ repoId: string; reason: string } | null>(null)

  const liveState = (repoId: string, fallback: EngineModelState | null): EngineModelState | null =>
    overview.engine.models.find((m) => m.id === repoId)?.state ?? fallback

  const activeDownload = (repoId: string): DownloadInfo | undefined =>
    overview.downloads.find(
      (d) => d.repoId === repoId && (d.status === 'queued' || d.status === 'downloading')
    )

  const onLoad = async (repoId: string, force = false): Promise<void> => {
    try {
      const result = await load(repoId, force)
      if (result.ok) return
      // Only a genuine RAM-guard refusal offers "Load anyway"; other failures must not.
      if (force) pushToast('error', result.reason ?? 'Load failed.')
      else setGuard({ repoId, reason: result.reason ?? 'The RAM guard blocked this load.' })
    } catch (err) {
      toastError(err)
    }
  }

  const onUnload = async (repoId: string): Promise<void> => {
    try {
      // The engine frees just this model (per-model unload, others stay
      // loaded); status events update the chips on their own.
      const result = await unload(repoId)
      if (!result.ok) pushToast('error', result.reason ?? 'Unload failed.')
    } catch (err) {
      toastError(err)
    }
  }

  return (
    <section>
      <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
        Tiers
      </h2>
      <div className="divide-y divide-zinc-800/70 rounded-lg border border-zinc-800 bg-zinc-900/30">
        {TIER_ORDER.map((tier) => {
          const spec = TIERS[tier]
          const resolution = overview.tiers.find((t) => t.tier === tier)
          // Real context_length from the active model's config.json beats the spec guess.
          const activeCtx = resolution?.active
            ? (overview.installed.find((m) => m.repoId === resolution.active)?.contextLength ??
              null)
            : null
          return (
            <div key={tier} className="flex items-center gap-4 px-4 py-3">
              <div className="w-44 shrink-0">
                <div className="flex items-center gap-1.5">
                  <span className="text-[13px] font-medium text-zinc-200">{TIER_LABELS[tier]}</span>
                  {spec.caps
                    .filter((cap) => cap !== 'text')
                    .map((cap) => (
                      <span
                        key={cap}
                        className="rounded border border-zinc-700/80 px-1 text-[9px] uppercase tracking-wide text-zinc-500"
                      >
                        {cap}
                      </span>
                    ))}
                </div>
                <div className="mt-0.5 text-[11px] text-zinc-500">
                  ~{spec.approxGB} GB ·{' '}
                  {activeCtx !== null
                    ? `${Math.round(activeCtx / 1024)}k ctx`
                    : `~${Math.round(spec.defaultCtx / 1024)}k ctx`}
                </div>
              </div>
              <div className="flex flex-1 flex-wrap items-center gap-2">
                {(resolution?.candidates ?? []).map((candidate) => (
                  <CandidateChip
                    key={candidate.repoId}
                    candidate={candidate}
                    active={resolution?.active === candidate.repoId}
                    engineState={liveState(candidate.repoId, candidate.engineState)}
                    download={activeDownload(candidate.repoId)}
                    onLoad={(repoId) => void onLoad(repoId)}
                    onUnload={(repoId) => void onUnload(repoId)}
                    onDownload={(repoId) => void download(repoId).catch(toastError)}
                  />
                ))}
              </div>
            </div>
          )
        })}
      </div>
      <ConfirmDialog
        open={guard !== null}
        title="Not enough free RAM"
        body={guard?.reason ?? ''}
        confirmLabel="Load anyway"
        danger
        onConfirm={() => {
          if (guard) void onLoad(guard.repoId, true)
          setGuard(null)
        }}
        onCancel={() => setGuard(null)}
      />
    </section>
  )
}
