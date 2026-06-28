import { useEffect, useRef, useState } from 'react'
import { Pencil, Search, Type } from 'lucide-react'
import type { Conversation } from '@shared/types'
import { useChatStore } from '@/stores/chat'
import {
  useChatPrefs,
  type ChatTextSize,
  type ChatWidth
} from '@/stores/chatPrefs'
import { useDismissable } from '@/lib/useDismissable'
import { toastError } from '@/stores/toasts'

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
        <DisplayMenu />
      </div>
    </div>
  )
}
