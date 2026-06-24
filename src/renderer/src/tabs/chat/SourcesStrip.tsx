import { BookText, ChevronRight, ExternalLink } from 'lucide-react'
import type { SourceRef } from '@shared/types'

function hostname(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

function SourceChip({ source }: { source: SourceRef }) {
  const label = source.title ?? hostname(source.url)
  // library:// sources aren't web URLs — opening them as external links is
  // broken (mirrors Citation's guard). Render a non-navigating chip.
  if (source.url.startsWith('library://')) {
    return (
      <span
        title="Library document"
        className="flex max-w-64 items-center gap-1 rounded-full border border-zinc-800 bg-zinc-900/60 px-2 py-0.5 text-[11px] text-zinc-400"
      >
        <span className="tabular-nums text-zinc-500">[{source.id}]</span>
        <span className="truncate">{label}</span>
        <BookText size={10} className="shrink-0 text-zinc-600" />
      </span>
    )
  }
  return (
    <a
      href={source.url}
      target="_blank"
      rel="noreferrer"
      title={source.url}
      className="flex max-w-64 items-center gap-1 rounded-full border border-zinc-800 bg-zinc-900/60 px-2 py-0.5 text-[11px] text-zinc-400 hover:border-zinc-600 hover:text-zinc-200"
    >
      <span className="tabular-nums text-zinc-500">[{source.id}]</span>
      <span className="truncate">{label}</span>
      <ExternalLink size={10} className="shrink-0 text-zinc-600" />
    </a>
  )
}

/**
 * Numbered chips behind the [n] citations. Collapsed into a "N sources"
 * disclosure so a web turn that read many pages doesn't bury the answer under a
 * wall of chips; expanded by default only when the list is short.
 */
export default function SourcesStrip({ sources }: { sources: SourceRef[] }) {
  if (sources.length === 0) return null
  return (
    <details open={sources.length <= 6} className="group/src my-2">
      <summary className="flex w-fit cursor-pointer list-none items-center gap-1.5 text-[11px] text-zinc-500 hover:text-zinc-300 [&::-webkit-details-marker]:hidden">
        <BookText size={12} className="text-zinc-600" />
        {sources.length} source{sources.length === 1 ? '' : 's'}
        <ChevronRight
          size={12}
          className="text-zinc-600 transition-transform group-open/src:rotate-90"
        />
      </summary>
      <div className="mt-1.5 flex flex-wrap gap-1.5">
        {sources.map((source) => (
          <SourceChip key={source.id} source={source} />
        ))}
      </div>
    </details>
  )
}
