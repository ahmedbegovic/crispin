import { useEffect, useRef, useState } from 'react'
import { Check, Copy, Loader2, Pencil, Search, Shrink, Sparkles, Type } from 'lucide-react'
import type { Conversation } from '@shared/types'
import { useChatStore } from '@/stores/chat'
import {
  useChatPrefs,
  type ChatTextSize,
  type ChatWidth
} from '@/stores/chatPrefs'
import { useDismissable } from '@/lib/useDismissable'
import { call } from '@/lib/ipc'
import { pushToast, toastError } from '@/stores/toasts'
import ConfirmDialog from '@/components/ConfirmDialog'
import ConversationSettings from './ConversationSettings'

/** Compact the conversation — summarize older turns to reclaim context. */
function CompactButton({ conversationId }: { conversationId: string }) {
  const compact = useChatStore((s) => s.compact)
  const streaming = useChatStore((s) => conversationId in s.streaming)
  const [confirm, setConfirm] = useState(false)
  const [pending, setPending] = useState(false)
  const run = (): void => {
    setConfirm(false)
    setPending(true)
    void compact(conversationId)
      .then(() => pushToast('info', 'Compacted — older turns summarized.'))
      .catch(toastError)
      .finally(() => setPending(false))
  }
  return (
    <>
      <button
        onClick={() => setConfirm(true)}
        disabled={pending || streaming}
        title="Compact conversation"
        aria-label="Compact conversation"
        className="rounded-md p-1.5 text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-200 disabled:opacity-40"
      >
        {pending ? <Loader2 size={14} className="animate-spin" /> : <Shrink size={14} />}
      </button>
      <ConfirmDialog
        open={confirm}
        title="Compact conversation?"
        body="The older turns are summarized into one note to reclaim context. The recent messages stay verbatim, and the original turns are preserved off the active path."
        confirmLabel="Compact"
        onConfirm={run}
        onCancel={() => setConfirm(false)}
      />
    </>
  )
}

/** Summarize the conversation on demand; result shown in an ephemeral popover. */
function SummaryMenu({ conversationId }: { conversationId: string }) {
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [summary, setSummary] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const streaming = useChatStore((s) => conversationId in s.streaming)
  const ref = useRef<HTMLDivElement>(null)
  useDismissable(open, () => setOpen(false), { outsideRef: ref })

  const run = (): void => {
    if (loading || streaming) return
    setOpen(true)
    setSummary(null)
    setLoading(true)
    void call('chat.summarize', { conversationId })
      .then((r) => setSummary(r.summary.trim() || 'Nothing to summarize yet.'))
      .catch((e) => {
        toastError(e)
        setOpen(false)
      })
      .finally(() => setLoading(false))
  }
  const copy = (): void => {
    if (!summary) return
    void navigator.clipboard.writeText(summary)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div ref={ref} className="relative">
      <button
        onClick={run}
        disabled={streaming}
        title="Summarize conversation"
        aria-label="Summarize conversation"
        className={`rounded-md p-1.5 transition-colors disabled:opacity-40 ${
          open ? 'bg-zinc-800 text-zinc-200' : 'text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200'
        }`}
      >
        <Sparkles size={14} />
      </button>
      {open && (
        <div
          role="dialog"
          aria-label="Conversation summary"
          className="absolute right-0 top-full z-20 mt-1 w-80 rounded-lg border border-zinc-700 bg-zinc-900 p-3 shadow-xl"
        >
          <div className="mb-1.5 flex items-center justify-between">
            <span className="text-[10px] font-medium uppercase tracking-[0.06em] text-zinc-500">
              Summary
            </span>
            {summary && (
              <button
                onClick={copy}
                className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
              >
                {copied ? <Check size={11} className="text-emerald-400" /> : <Copy size={11} />}
                {copied ? 'Copied' : 'Copy'}
              </button>
            )}
          </div>
          {loading ? (
            <div className="flex items-center gap-2 py-4 text-[12px] text-zinc-500">
              <Loader2 size={14} className="animate-spin" />
              Summarizing…
            </div>
          ) : (
            <div className="max-h-80 select-text overflow-y-auto whitespace-pre-wrap break-words text-[12.5px] leading-relaxed text-zinc-300">
              {summary}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/** A two-option/three-option segmented control for the display menu. */
function Segmented<T extends string>({
  label,
  value,
  options,
  onChange
}: {
  label: string
  value: T
  options: { v: T; label: string }[]
  onChange: (v: T) => void
}) {
  return (
    <div className="px-1 py-1">
      <div className="mb-1 px-1 text-[10px] font-medium uppercase tracking-[0.06em] text-zinc-500">
        {label}
      </div>
      <div className="flex gap-1 rounded-md bg-zinc-950/60 p-0.5">
        {options.map((o) => (
          <button
            key={o.v}
            onClick={() => onChange(o.v)}
            aria-pressed={value === o.v}
            className={`flex-1 rounded px-2 py-1 text-[11px] transition-colors ${
              value === o.v ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-400 hover:text-zinc-200'
            }`}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  )
}

/** Reading comfort knobs (text size / measure / code wrap). App-global, persisted. */
function DisplayMenu() {
  const textSize = useChatPrefs((s) => s.textSize)
  const width = useChatPrefs((s) => s.width)
  const codeWrap = useChatPrefs((s) => s.codeWrap)
  const setTextSize = useChatPrefs((s) => s.setTextSize)
  const setWidth = useChatPrefs((s) => s.setWidth)
  const setCodeWrap = useChatPrefs((s) => s.setCodeWrap)
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useDismissable(open, () => setOpen(false), { outsideRef: ref })

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        title="Display"
        aria-label="Display settings"
        aria-haspopup="dialog"
        aria-expanded={open}
        className={`rounded-md p-1.5 transition-colors ${
          open ? 'bg-zinc-800 text-zinc-200' : 'text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200'
        }`}
      >
        <Type size={14} />
      </button>
      {open && (
        <div
          role="dialog"
          aria-label="Display settings"
          className="absolute right-0 top-full z-20 mt-1 w-56 rounded-lg border border-zinc-700 bg-zinc-900 p-1.5 shadow-xl"
        >
          <Segmented<ChatTextSize>
            label="Text size"
            value={textSize}
            onChange={setTextSize}
            options={[
              { v: 'small', label: 'Small' },
              { v: 'default', label: 'Default' },
              { v: 'large', label: 'Large' }
            ]}
          />
          <Segmented<ChatWidth>
            label="Width"
            value={width}
            onChange={setWidth}
            options={[
              { v: 'standard', label: 'Standard' },
              { v: 'wide', label: 'Wide' }
            ]}
          />
          <button
            role="switch"
            aria-checked={codeWrap}
            onClick={() => setCodeWrap(!codeWrap)}
            className="mt-0.5 flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-[12px] text-zinc-300 hover:bg-zinc-800/80"
          >
            Wrap code blocks
            <span
              aria-hidden
              className={`relative h-4 w-7 shrink-0 rounded-full transition-colors ${
                codeWrap ? 'bg-emerald-500' : 'bg-zinc-700'
              }`}
            >
              <span
                className={`absolute top-0.5 h-3 w-3 rounded-full bg-white transition-transform ${
                  codeWrap ? 'translate-x-3.5' : 'translate-x-0.5'
                }`}
              />
            </span>
          </button>
        </div>
      )}
    </div>
  )
}

interface Props {
  conversation: Conversation
  findOpen: boolean
  onToggleFind: () => void
}

/**
 * The thread's top bar — the draggable titlebar band, now carrying the
 * conversation name (inline-editable → chat.update) and reading/find controls.
 * Summarize / compact / settings actions land here as their backing arrives.
 */
export default function ThreadHeader({ conversation, findOpen, onToggleFind }: Props) {
  const update = useChatStore((s) => s.update)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  // Escape cancels; without this the unmount's onBlur would still commit.
  const cancelRef = useRef(false)

  const title = conversation.title || 'New chat'

  const startEdit = (): void => {
    setDraft(conversation.title || '')
    setEditing(true)
  }
  const commit = (): void => {
    // Always close first so the input unmounts even on cancel. Both Enter and
    // Escape blur the input, so this single onBlur path is the only commit —
    // no duplicate update, and Escape (cancelRef) genuinely discards.
    setEditing(false)
    if (cancelRef.current) {
      cancelRef.current = false
      return
    }
    const next = draft.trim()
    if (!next || next === conversation.title) return
    void update(conversation.id, { title: next }).catch(toastError)
  }

  useEffect(() => {
    if (editing) inputRef.current?.select()
  }, [editing])

  return (
    <div className="drag-region relative z-10 flex h-12 shrink-0 items-center gap-2 border-b border-zinc-800/60 px-4">
      {editing ? (
        <input
          ref={inputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              inputRef.current?.blur()
            } else if (e.key === 'Escape') {
              e.preventDefault()
              cancelRef.current = true
              inputRef.current?.blur()
            }
          }}
          onBlur={commit}
          maxLength={120}
          className="no-drag min-w-0 flex-1 rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 text-[13px] font-medium text-zinc-100 outline-none focus:border-zinc-500"
        />
      ) : (
        // A plain label that stays part of the drag region, so clicking /
        // double-clicking the titlebar moves / zooms the window. Rename is the
        // explicit pencil button on the right — not a click on the title.
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-zinc-200">
          {title}
        </span>
      )}
      <div className="no-drag flex shrink-0 items-center gap-0.5">
        {!editing && (
          <button
            onClick={startEdit}
            title="Rename conversation"
            aria-label="Rename conversation"
            className="rounded-md p-1.5 text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-200"
          >
            <Pencil size={14} />
          </button>
        )}
        <button
          onClick={onToggleFind}
          title="Find in conversation"
          aria-label="Find in conversation"
          aria-pressed={findOpen}
          className={`rounded-md p-1.5 transition-colors ${
            findOpen ? 'bg-zinc-800 text-zinc-200' : 'text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200'
          }`}
        >
          <Search size={14} />
        </button>
        <SummaryMenu conversationId={conversation.id} />
        <CompactButton conversationId={conversation.id} />
        <DisplayMenu />
        <ConversationSettings conversation={conversation} />
      </div>
    </div>
  )
}
