import { ExternalLink } from 'lucide-react'
import type { SourceRef } from '@shared/types'

function hostname(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

/** Numbered chips behind the [n] citations in the answer text. */
export default function SourcesStrip({ sources }: { sources: SourceRef[] }) {
  if (sources.length === 0) return null
  return (
    <div className="my-2 flex flex-wrap gap-1.5">
      {sources.map((source) => (
        <a
          key={source.id}
          href={source.url}
          target="_blank"
          rel="noreferrer"
          title={source.url}
          className="flex max-w-64 items-center gap-1 rounded-full border border-zinc-800 bg-zinc-900/60 px-2 py-0.5 text-[11px] text-zinc-400 hover:border-zinc-600 hover:text-zinc-200"
        >
          <span className="tabular-nums text-zinc-500">[{source.id}]</span>
          <span className="truncate">{source.title ?? hostname(source.url)}</span>
          <ExternalLink size={10} className="shrink-0 text-zinc-600" />
        </a>
      ))}
    </div>
  )
}
