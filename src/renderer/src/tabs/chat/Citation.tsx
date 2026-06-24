import { Children, createContext, useContext, type ReactNode } from 'react'
import { ExternalLink } from 'lucide-react'
import type { SourceRef } from '@shared/types'
import HoverCard from '@/components/HoverCard'

/** Per-message [n] → source map; provided by MarkdownPart, read by Citation. */
export const SourcesContext = createContext<Record<number, SourceRef>>({})

function hostname(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

/** Flatten the rehype-injected children (a `[n]` text node) to its string. */
function childText(children: ReactNode): string {
  return Children.toArray(children)
    .map((c) => (typeof c === 'string' || typeof c === 'number' ? String(c) : ''))
    .join('')
}

/**
 * Renders a `[n]` citation marker the rehypeCitations plugin wrapped in <cite>.
 * Resolves the source from context: a known source becomes a hover-card pill;
 * an unknown/mid-stream one falls back to the literal text.
 */
export default function Citation({ children }: { children?: ReactNode }): React.JSX.Element {
  const sources = useContext(SourcesContext)
  const text = childText(children)
  const id = Number(/\[(\d+)\]/.exec(text)?.[1])
  const source = Number.isFinite(id) ? sources[id] : undefined
  if (!source) return <>{text}</>

  const isLibrary = source.url.startsWith('library://')
  const open = (): void => {
    if (!isLibrary) window.open(source.url, '_blank', 'noopener,noreferrer')
  }

  return (
    <HoverCard
      trigger={
        <span
          role="button"
          tabIndex={0}
          onClick={open}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              open()
            }
          }}
          aria-label={`Source ${id}: ${source.title ?? hostname(source.url)}`}
          // align-middle (not superscript): the pill sits centered on the text
          // line — level with it, not floating above — and stays a tight inline
          // chip that doesn't inflate the line height.
          className={`mx-px inline-block cursor-pointer rounded bg-sky-500/15 px-1 align-middle text-[10px] font-medium leading-none text-sky-400 hover:bg-sky-500/25 ${
            source.grounded === false ? 'opacity-60' : ''
          }`}
        >
          {id}
        </span>
      }
    >
      <div className="space-y-1">
        <div className="font-medium text-zinc-200">{source.title ?? hostname(source.url)}</div>
        <div className="text-[11px] text-zinc-500">
          {isLibrary ? 'Library document' : hostname(source.url)}
          {source.grounded === false && ' · unverified'}
        </div>
        {source.snippet && (
          <div className="line-clamp-4 text-zinc-400">{source.snippet}</div>
        )}
        {!isLibrary && (
          <button
            onClick={open}
            className="flex items-center gap-1 text-sky-400 hover:underline"
          >
            Open <ExternalLink size={11} />
          </button>
        )}
      </div>
    </HoverCard>
  )
}
