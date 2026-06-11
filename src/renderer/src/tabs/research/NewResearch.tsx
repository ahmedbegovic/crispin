import { useEffect, useRef, useState } from 'react'
import { Loader2, Telescope } from 'lucide-react'
import { FEATURE_DEFAULTS, TIER_LABELS, TIER_ORDER } from '@shared/model-tiers'
import type { ResearchMode, Tier } from '@shared/types'
import { useLibraryStore } from '@/stores/library'
import { useModelsStore } from '@/stores/models'
import { useResearchStore } from '@/stores/research'
import { toastError } from '@/stores/toasts'
import LibraryDialog from '../chat/LibraryDialog'

const MODE_EXPLAINERS: Record<ResearchMode, string> = {
  standard: 'Search rounds accumulate raw notes — fast, fits most questions.',
  heavy: 'Each round is compressed into a mini-report — slower, for broad questions.'
}

const MAX_TEXTAREA_PX = 120

const MANAGE_SENTINEL = '__manage__'

const selectClass =
  'min-w-0 flex-1 rounded-md border border-zinc-800 bg-zinc-900 px-1.5 py-1 text-[11px] text-zinc-400 outline-none hover:text-zinc-200 focus:border-zinc-600'

export default function NewResearch() {
  const start = useResearchStore((s) => s.start)
  const collections = useLibraryStore((s) => s.collections)
  // null = untouched: main then resolves the user's persisted research default.
  const [tier, setTier] = useState<Tier | null>(null)
  const defaultTier =
    useModelsStore((s) => s.overview?.defaults.research) ?? FEATURE_DEFAULTS.research

  const [question, setQuestion] = useState('')
  const [mode, setMode] = useState<ResearchMode>('standard')
  const [collectionId, setCollectionId] = useState('')
  const [starting, setStarting] = useState(false)
  const [libraryOpen, setLibraryOpen] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // The selected collection can be deleted via the Manage library dialog —
  // self-heals on the re-render triggered by the collections store update.
  const validCollectionId = collections.some((c) => c.id === collectionId) ? collectionId : ''

  // Autosize after every text commit (covers programmatic clears on start).
  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, MAX_TEXTAREA_PX)}px`
  }, [question])

  const submit = (): void => {
    const trimmed = question.trim()
    if (starting || !trimmed) return
    setStarting(true)
    void start(trimmed, {
      mode,
      tier: tier ?? undefined,
      collectionId: validCollectionId || undefined
    })
      .then(() => setQuestion(''))
      .catch(toastError)
      .finally(() => setStarting(false))
  }

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/80">
      <textarea
        ref={textareaRef}
        value={question}
        onChange={(e) => setQuestion(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault()
            submit()
          }
        }}
        rows={2}
        placeholder="What should be researched?"
        spellCheck={false}
        className="block max-h-32 w-full resize-none bg-transparent px-3 py-2.5 text-[12.5px] leading-relaxed text-zinc-200 outline-none placeholder:text-zinc-600"
      />

      <div className="space-y-2 px-2.5 pb-2.5">
        <div className="flex rounded-md border border-zinc-800 bg-zinc-950/60 p-0.5">
          {(['standard', 'heavy'] as const).map((m) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              className={`flex-1 rounded px-2 py-0.5 text-[11px] capitalize ${
                mode === m ? 'bg-zinc-700 text-zinc-100' : 'text-zinc-500 hover:text-zinc-300'
              }`}
            >
              {m}
            </button>
          ))}
        </div>
        <p className="text-[10.5px] leading-snug text-zinc-600">{MODE_EXPLAINERS[mode]}</p>

        <div className="flex items-center gap-1.5">
          <select
            value={tier ?? defaultTier}
            onChange={(e) => setTier(e.target.value as Tier)}
            title="Model tier"
            className={selectClass}
          >
            {TIER_ORDER.map((t) => (
              <option key={t} value={t}>
                {TIER_LABELS[t]}
              </option>
            ))}
          </select>

          <select
            value={validCollectionId}
            onChange={(e) => {
              // The select is controlled, so picking "Manage…" snaps back on re-render.
              if (e.target.value === MANAGE_SENTINEL) {
                setLibraryOpen(true)
                return
              }
              setCollectionId(e.target.value)
            }}
            title="Save visited sources into a RAG collection"
            className={selectClass}
          >
            <option value="">No collection</option>
            {collections.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} ({c.docCount})
              </option>
            ))}
            <option value={MANAGE_SENTINEL}>Manage library…</option>
          </select>
        </div>

        <button
          onClick={submit}
          disabled={starting || !question.trim()}
          className="flex w-full items-center justify-center gap-1.5 rounded-lg bg-emerald-600 py-1.5 text-[12px] font-medium text-white enabled:hover:bg-emerald-500 disabled:opacity-40"
        >
          {starting ? (
            <Loader2 size={13} className="animate-spin" />
          ) : (
            <Telescope size={13} />
          )}
          Start research
        </button>
      </div>

      <LibraryDialog
        open={libraryOpen}
        onClose={() => setLibraryOpen(false)}
        initialCollectionId={validCollectionId || null}
      />
    </div>
  )
}
