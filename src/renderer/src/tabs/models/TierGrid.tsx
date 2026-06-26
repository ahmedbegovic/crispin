import { useState, type ReactNode } from 'react'
import { AlertTriangle, Check, FlaskConical } from 'lucide-react'
import {
  canonicalRepoId,
  modelDisplayName,
  TIERS,
  TIER_LABELS,
  TIER_ORDER
} from '@shared/model-tiers'

/**
 * Selections are canonicalized on read while candidates surface the INSTALLED
 * (possibly renamed-old) id — compare through the alias map or a pick on an
 * old-id snapshot could never be cleared.
 */
const isPicked = (selection: string | undefined, repoId: string): boolean =>
  selection !== undefined && canonicalRepoId(selection) === canonicalRepoId(repoId)
import type {
  CatalogFamily,
  DownloadInfo,
  EngineModelState,
  ModelFit,
  ModelsOverview,
  Tier,
  TierCandidateInfo
} from '@shared/types'
import { useModelsStore } from '@/stores/models'
import { pushToast, toastError } from '@/stores/toasts'
import ConfirmDialog from '@/components/ConfirmDialog'
import { GoogleLogo, QwenLogo } from './FamilyLogos'

const FAMILY_GROUPS: Array<{ key: CatalogFamily; label: string; logo: ReactNode }> = [
  { key: 'gemma', label: 'Gemma', logo: <GoogleLogo /> },
  { key: 'qwen', label: 'Qwen', logo: <QwenLogo /> },
  { key: 'experimental', label: 'Experimental', logo: <FlaskConical size={13} /> }
]

const FIT_STYLES: Record<ModelFit, { label: string; className: string }> = {
  perfect: { label: 'Perfect', className: 'bg-emerald-500/15 text-emerald-400' },
  good: { label: 'Good', className: 'bg-yellow-500/15 text-yellow-400' },
  risky: { label: 'Risky', className: 'bg-orange-500/15 text-orange-400' },
  unable: { label: "Won't fit", className: 'bg-red-500/15 text-red-400' }
}

function gb(n: number): string {
  return n % 1 === 0 ? String(n) : n.toFixed(1)
}

function FitBadge({ fit }: { fit: ModelFit }) {
  const style = FIT_STYLES[fit]
  return (
    <span
      title="Fit against the memory budget and what's available right now"
      className={`rounded px-1 py-px text-[9.5px] font-medium ${style.className}`}
    >
      {style.label}
    </span>
  )
}

interface CardProps {
  candidate: TierCandidateInfo
  active: boolean
  /** True when this repo is the tier's explicit Settings-backed pick. */
  picked: boolean
  engineState: EngineModelState | null
  download: DownloadInfo | undefined
  partial: DownloadInfo | undefined
  onSelect: () => void
  onLoad: () => void
  onUnload: () => void
  onDownload: () => void
}

function ModelCard({
  candidate,
  active,
  picked,
  engineState,
  download,
  partial,
  onSelect,
  onLoad,
  onUnload,
  onDownload
}: CardProps) {
  const stop = (fn: () => void) => (e: React.MouseEvent) => {
    e.stopPropagation()
    fn()
  }

  let action: ReactNode
  if (!candidate.installed) {
    action = download ? (
      <span className="animate-pulse text-[11px] tabular-nums text-amber-400">
        {download.bytesTotal !== null
          ? `${Math.floor((download.bytesDone / download.bytesTotal) * 100)}%`
          : 'downloading…'}
      </span>
    ) : (
      <button
        onClick={stop(onDownload)}
        title={
          partial
            ? `${(partial.bytesDone / 1e9).toFixed(1)} GB already fetched — resumes where it left off`
            : undefined
        }
        className="rounded-md border border-zinc-700 px-2 py-0.5 text-[11px] text-zinc-400 hover:border-zinc-500 hover:text-zinc-200"
      >
        {partial ? 'Resume' : 'Download'}
      </button>
    )
  } else if (engineState === 'loaded') {
    action = (
      <span className="flex items-center gap-1.5">
        <span className="flex items-center gap-1 text-[11px] text-emerald-400">
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-500" />
          Loaded
        </span>
        <button
          onClick={stop(onUnload)}
          className="rounded-md border border-zinc-700 px-1.5 py-0.5 text-[10.5px] text-zinc-400 hover:border-zinc-500 hover:text-zinc-200"
        >
          Unload
        </button>
      </span>
    )
  } else if (engineState === 'loading') {
    action = <span className="animate-pulse text-[11px] text-amber-400">Loading…</span>
  } else {
    action = (
      <button
        onClick={stop(onLoad)}
        className="rounded-md bg-zinc-800 px-2 py-0.5 text-[11px] text-zinc-200 hover:bg-zinc-700"
      >
        Load
      </button>
    )
  }

  return (
    <div
      role={candidate.installed ? 'button' : undefined}
      onClick={candidate.installed ? onSelect : undefined}
      title={`${candidate.repoId}${candidate.installed ? (picked ? '\nClick to clear the pick' : '\nClick to use for this tier') : ''}`}
      className={`w-44 shrink-0 rounded-lg border bg-zinc-900/60 px-2.5 py-2 ${
        active ? 'border-emerald-600/60 ring-1 ring-emerald-600/40' : 'border-zinc-800'
      } ${candidate.installed ? 'cursor-pointer hover:border-zinc-600' : ''}`}
    >
      <div className="flex items-center gap-1">
        <span className="min-w-0 flex-1 truncate text-[12px] text-zinc-200">
          {modelDisplayName(candidate.repoId)}
        </span>
        {candidate.warning !== null && (
          <span title={candidate.warning} className="shrink-0">
            <AlertTriangle size={11} className="text-amber-400" />
          </span>
        )}
        {active && <Check size={12} className="shrink-0 text-emerald-400" />}
      </div>
      <div className="mt-1 flex items-center gap-1.5">
        <span className="text-[10.5px] tabular-nums text-zinc-500">~{gb(candidate.estGB)} GB</span>
        <FitBadge fit={candidate.fit} />
      </div>
      <div className="mt-1.5 flex items-center">{action}</div>
    </div>
  )
}

/**
 * Tier × family grid: one row per tier, Gemma | Qwen | Experimental card
 * strips. Click an installed card to make it the tier's model.
 */
export default function TierGrid({ overview }: { overview: ModelsOverview }) {
  const load = useModelsStore((s) => s.load)
  const unload = useModelsStore((s) => s.unload)
  const download = useModelsStore((s) => s.download)
  const setTierSelection = useModelsStore((s) => s.setTierSelection)
  const [guard, setGuard] = useState<{
    repoId: string
    title: string
    reason: string
    retry: { allowBroken?: boolean; force?: boolean }
  } | null>(null)

  const liveState = (repoId: string, fallback: EngineModelState | null): EngineModelState | null =>
    overview.engine.models.find((m) => m.id === repoId)?.state ?? fallback

  const activeDownload = (repoId: string): DownloadInfo | undefined =>
    overview.downloads.find(
      (d) => d.repoId === repoId && (d.status === 'queued' || d.status === 'downloading')
    )

  // HF downloads keep their fetched files on cancel/failure and resume where
  // they left off — label the button honestly. downloads is newest-first.
  const partialDownload = (repoId: string): DownloadInfo | undefined =>
    overview.downloads.find(
      (d) =>
        d.repoId === repoId &&
        (d.status === 'cancelled' || d.status === 'failed') &&
        d.bytesDone > 0
    )

  const onLoad = async (
    repoId: string,
    opts: { warning?: string | null; allowBroken?: boolean; force?: boolean } = {}
  ): Promise<void> => {
    // QAT consent comes first and is independent of the RAM force: a warned
    // (known-broken) candidate must be acknowledged before we even try to load.
    if (!opts.allowBroken && opts.warning) {
      setGuard({
        repoId,
        title: 'Known-broken quant',
        reason: opts.warning,
        retry: { allowBroken: true }
      })
      return
    }
    try {
      const result = await load(repoId, { allowBroken: opts.allowBroken, force: opts.force })
      if (result.ok) return
      // A RAM-guard refusal offers its own "Load anyway" (force), carrying any
      // prior known-broken consent forward so the quant is never re-prompted.
      if (opts.force) pushToast('error', result.reason ?? 'Load failed.')
      else
        setGuard({
          repoId,
          title: 'Not enough free RAM',
          reason: result.reason ?? 'The RAM guard blocked this load.',
          retry: { allowBroken: opts.allowBroken, force: true }
        })
    } catch (err) {
      toastError(err)
    }
  }

  const onUnload = async (repoId: string): Promise<void> => {
    try {
      const result = await unload(repoId)
      if (!result.ok) pushToast('error', result.reason ?? 'Unload failed.')
    } catch (err) {
      toastError(err)
    }
  }

  const onSelect = (tier: Tier, repoId: string): void => {
    const picked = isPicked(overview.tierSelections[tier], repoId)
    // Clicking the explicit pick clears it (back to the curated default).
    void setTierSelection(tier, picked ? null : repoId).catch(toastError)
  }

  return (
    <section>
      <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
        Tiers
      </h2>
      <div className="rounded-lg border border-zinc-800 bg-zinc-900/30">
        {/* Column headers, aligned with the rows' grid below. */}
        <div className="flex gap-4 px-4 pt-3">
          <div className="w-40 shrink-0" />
          <div className="grid min-w-0 flex-1 grid-cols-3 gap-4">
            {FAMILY_GROUPS.map((g) => (
              <div
                key={g.key}
                className="flex items-center gap-1.5 text-[11px] font-medium text-zinc-400"
              >
                {g.logo}
                {g.label}
              </div>
            ))}
          </div>
        </div>

        <div className="divide-y divide-zinc-800/70">
          {TIER_ORDER.map((tier) => {
            const spec = TIERS[tier]
            const resolution = overview.tiers.find((t) => t.tier === tier)
            const candidates = resolution?.candidates ?? []
            // Real context_length from the active model's config.json beats the spec guess.
            const activeCtx = resolution?.active
              ? (overview.installed.find((m) => m.repoId === resolution.active)?.contextLength ??
                null)
              : null
            return (
              <div key={tier} className="flex gap-4 px-4 py-3">
                <div className="w-40 shrink-0">
                  <div className="flex items-center gap-1.5">
                    <span className="text-[13px] font-medium text-zinc-200">
                      {TIER_LABELS[tier]}
                    </span>
                  </div>
                  <div className="mt-0.5 text-[11px] text-zinc-500">
                    ~{spec.approxGB} GB ·{' '}
                    {activeCtx !== null
                      ? `${Math.round(activeCtx / 1024)}k ctx`
                      : `~${Math.round(spec.defaultCtx / 1024)}k ctx`}
                  </div>
                  <div className="mt-1 flex flex-wrap gap-1">
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
                </div>
                <div className="grid min-w-0 flex-1 grid-cols-3 gap-4">
                  {FAMILY_GROUPS.map((g) => {
                    const cards = candidates.filter((c) => c.family === g.key)
                    return (
                      <div
                        key={g.key}
                        className="scrollbar-none flex min-w-0 gap-2 overflow-x-auto"
                      >
                        {cards.length === 0 ? (
                          <span className="self-center text-[11px] text-zinc-700">—</span>
                        ) : (
                          cards.map((candidate) => (
                            <ModelCard
                              key={candidate.repoId}
                              candidate={candidate}
                              active={resolution?.active === candidate.repoId}
                              picked={isPicked(overview.tierSelections[tier], candidate.repoId)}
                              engineState={liveState(candidate.repoId, candidate.engineState)}
                              download={activeDownload(candidate.repoId)}
                              partial={partialDownload(candidate.repoId)}
                              onSelect={() => onSelect(tier, candidate.repoId)}
                              onLoad={() => void onLoad(candidate.repoId, { warning: candidate.warning })}
                              onUnload={() => void onUnload(candidate.repoId)}
                              onDownload={() =>
                                void download(candidate.repoId).catch(toastError)
                              }
                            />
                          ))
                        )}
                      </div>
                    )
                  })}
                </div>
              </div>
            )
          })}
        </div>
      </div>
      <ConfirmDialog
        open={guard !== null}
        title={guard?.title ?? ''}
        body={guard?.reason ?? ''}
        confirmLabel="Load anyway"
        danger
        onConfirm={() => {
          if (guard) void onLoad(guard.repoId, guard.retry)
          setGuard(null)
        }}
        onCancel={() => setGuard(null)}
      />
    </section>
  )
}
