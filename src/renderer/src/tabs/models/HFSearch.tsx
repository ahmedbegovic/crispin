import { useEffect, useRef, useState } from 'react'
import { Loader2, Search } from 'lucide-react'
import { estimateGB, fitFor, type ModelFit } from '@shared/model-tiers'
import type { HFSearchResult } from '@shared/types'
import { useModelsStore } from '@/stores/models'
import { toastError } from '@/stores/toasts'
import { relativeTime } from '@/lib/format'
import ConfirmDialog from '@/components/ConfirmDialog'

const compact = new Intl.NumberFormat('en', { notation: 'compact' })

const FIT_STYLES: Record<ModelFit, { label: string; className: string }> = {
  perfect: { label: 'Perfect fit', className: 'bg-emerald-500/15 text-emerald-400' },
  good: { label: 'Good fit', className: 'bg-yellow-500/15 text-yellow-400' },
  risky: { label: 'Risky fit', className: 'bg-orange-500/15 text-orange-400' },
  unable: { label: "Won't fit", className: 'bg-red-500/15 text-red-400' }
}

/** Search MLX repos on Hugging Face; the tools sidecar does the actual fetch. */
export default function HFSearch() {
  const search = useModelsStore((s) => s.search)
  const download = useModelsStore((s) => s.download)
  const results = useModelsStore((s) => s.searchResults)
  const searching = useModelsStore((s) => s.searching)
  const ram = useModelsStore((s) => s.overview?.ram)
  const [query, setQuery] = useState('')
  // Result whose validator warning the user must acknowledge before downloading.
  const [forceTarget, setForceTarget] = useState<HFSearchResult | null>(null)
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(
    () => () => {
      if (debounce.current) clearTimeout(debounce.current)
    },
    []
  )

  const run = (q: string): void => {
    if (debounce.current) clearTimeout(debounce.current)
    debounce.current = null
    if (q.trim()) void search(q.trim()).catch(toastError)
  }

  return (
    <section>
      <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
        Hugging Face
      </h2>
      <div className="relative">
        {searching ? (
          <Loader2
            size={14}
            className="absolute left-2.5 top-1/2 -translate-y-1/2 animate-spin text-zinc-500"
          />
        ) : (
          <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-zinc-600" />
        )}
        <input
          value={query}
          onChange={(e) => {
            const next = e.target.value
            setQuery(next)
            if (debounce.current) clearTimeout(debounce.current)
            debounce.current = setTimeout(() => run(next), 300)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') run(query)
          }}
          placeholder="Search MLX models…"
          spellCheck={false}
          className="w-full rounded-lg border border-zinc-800 bg-zinc-900 py-1.5 pl-8 pr-3 text-[12px] text-zinc-200 outline-none placeholder:text-zinc-600 focus:border-zinc-600"
        />
      </div>

      {results === null ? (
        <p className="mt-2 text-[11px] text-zinc-600">Try &quot;mlx-community gemma 4&quot;.</p>
      ) : results.length === 0 ? (
        <p className="mt-2 text-[11px] text-zinc-600">No results.</p>
      ) : (
        <div className="mt-2 divide-y divide-zinc-800/70 rounded-lg border border-zinc-800 bg-zinc-900/30">
          {results.map((result) => {
            // Params-only estimate (nothing on disk yet); omit when unparseable.
            const estGB = estimateGB(result.repoId)
            const fit = estGB !== null && ram ? FIT_STYLES[fitFor(estGB, ram)] : null
            return (
            <div key={result.repoId} className="px-3 py-2">
              <div className="flex items-center gap-3">
                <span className="flex-1 truncate text-[12px] text-zinc-200" title={result.repoId}>
                  {result.repoId}
                </span>
                {fit && (
                  <span
                    title={`~${estGB?.toFixed(1)} GB estimated`}
                    className={`rounded px-1 py-px text-[9.5px] font-medium ${fit.className}`}
                  >
                    {fit.label}
                  </span>
                )}
                <span className="text-[11px] tabular-nums text-zinc-500">
                  {compact.format(result.downloads)} downloads · {compact.format(result.likes)}{' '}
                  likes
                  {result.updatedAt !== null && ` · ${relativeTime(result.updatedAt)}`}
                </span>
                <button
                  onClick={() =>
                    result.warning !== null
                      ? setForceTarget(result)
                      : void download(result.repoId).catch(toastError)
                  }
                  className="rounded-md border border-zinc-700 px-2 py-0.5 text-[11px] text-zinc-400 hover:border-zinc-500 hover:text-zinc-200"
                >
                  Download
                </button>
              </div>
              {result.warning !== null && (
                <div className="mt-1.5 rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-1 text-[11px] text-amber-300">
                  {result.warning}
                </div>
              )}
            </div>
            )
          })}
        </div>
      )}

      <ConfirmDialog
        open={forceTarget !== null}
        title="Known-broken quant"
        body={`${forceTarget?.warning ?? ''}\n\nDownload ${forceTarget?.repoId ?? ''} anyway?`}
        confirmLabel="Download anyway"
        danger
        onConfirm={() => {
          if (forceTarget) void download(forceTarget.repoId, true).catch(toastError)
          setForceTarget(null)
        }}
        onCancel={() => setForceTarget(null)}
      />
    </section>
  )
}
