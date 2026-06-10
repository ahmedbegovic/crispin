import { useEffect, useState, type ReactNode } from 'react'
import { CheckCheck, Loader2, Newspaper, RefreshCw, Rss } from 'lucide-react'
import { useNewsStore } from '@/stores/news'
import { toastError } from '@/stores/toasts'
import SourcesPanel from './SourcesPanel'
import CardGrid from './CardGrid'
import ReaderView from './ReaderView'

export default function NewsTab() {
  const init = useNewsStore((s) => s.init)
  const sources = useNewsStore((s) => s.sources)
  const items = useNewsStore((s) => s.items)
  const paused = useNewsStore((s) => s.paused)
  const refreshing = useNewsStore((s) => s.refreshing)
  const refreshFeeds = useNewsStore((s) => s.refreshFeeds)
  const markAllRead = useNewsStore((s) => s.markAllRead)
  const selectedItem = useNewsStore((s) => s.selectedItem)
  const [showSources, setShowSources] = useState(false)

  useEffect(() => {
    void init().catch(toastError)
  }, [init])

  const unread = items.filter((i) => i.readAt === null).length

  const onRefresh = (): void => {
    void refreshFeeds().catch(toastError)
  }

  return (
    <div className="flex h-full flex-col">
      {/* pt-12 clears the hiddenInset titlebar band (h-12, traffic lights centered). */}
      <header className="flex shrink-0 items-center gap-2.5 border-b border-zinc-800/80 px-6 pb-2.5 pt-12">
        <h1 className="text-[13px] font-semibold text-zinc-100">News</h1>
        {unread > 0 && (
          <span className="rounded-full bg-zinc-800 px-2 py-0.5 text-[10.5px] font-medium tabular-nums text-zinc-300">
            {unread} unread
          </span>
        )}
        {paused && (
          <span className="min-w-0 truncate rounded-full bg-amber-500/15 px-2 py-0.5 text-[10.5px] font-medium text-amber-400">
            summaries paused while the large model is loaded
          </span>
        )}

        <div className="no-drag ml-auto flex shrink-0 items-center gap-1.5">
          <button
            onClick={onRefresh}
            disabled={refreshing || sources.length === 0}
            className="flex items-center gap-1 rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 text-[11px] text-zinc-300 enabled:hover:border-zinc-600 disabled:opacity-40"
          >
            {refreshing ? (
              <Loader2 size={11} className="animate-spin" />
            ) : (
              <RefreshCw size={11} />
            )}
            Refresh
          </button>
          <button
            onClick={() => void markAllRead().catch(toastError)}
            disabled={unread === 0}
            className="flex items-center gap-1 rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 text-[11px] text-zinc-300 enabled:hover:border-zinc-600 disabled:opacity-40"
          >
            <CheckCheck size={11} />
            Mark all read
          </button>
          <button
            onClick={() => setShowSources((v) => !v)}
            className={`flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] ${
              showSources
                ? 'border-zinc-600 bg-zinc-800 text-zinc-100'
                : 'border-zinc-800 bg-zinc-900 text-zinc-300 hover:border-zinc-600'
            }`}
          >
            <Rss size={11} />
            Manage sources
          </button>
        </div>
      </header>

      {showSources && <SourcesPanel />}

      {selectedItem ? (
        <ReaderView item={selectedItem} />
      ) : sources.length === 0 ? (
        <EmptyState
          title="No sources yet"
          body="Add an RSS or Atom feed — new items are fetched, extracted and summarized locally."
        >
          <button
            onClick={() => setShowSources(true)}
            className="rounded-md bg-emerald-600 px-2.5 py-1 text-[12px] font-medium text-white hover:bg-emerald-500"
          >
            Add a source
          </button>
        </EmptyState>
      ) : items.length === 0 ? (
        <EmptyState
          title="No items yet"
          body="Enabled feeds are fetched every 30 minutes — or pull them right now."
        >
          <button
            onClick={onRefresh}
            disabled={refreshing}
            className="flex items-center gap-1 rounded-md border border-zinc-800 bg-zinc-900 px-2.5 py-1 text-[12px] text-zinc-300 enabled:hover:border-zinc-600 disabled:opacity-40"
          >
            {refreshing ? (
              <Loader2 size={12} className="animate-spin" />
            ) : (
              <RefreshCw size={12} />
            )}
            Refresh
          </button>
        </EmptyState>
      ) : (
        <CardGrid items={items} />
      )}
    </div>
  )
}

function EmptyState({
  title,
  body,
  children
}: {
  title: string
  body: string
  children: ReactNode
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4">
      <Newspaper size={32} strokeWidth={1.5} className="text-zinc-700" />
      <div className="text-center">
        <h2 className="text-[14px] font-medium text-zinc-300">{title}</h2>
        <p className="mt-1 max-w-sm text-[12px] leading-relaxed text-zinc-600">{body}</p>
      </div>
      {children}
    </div>
  )
}
