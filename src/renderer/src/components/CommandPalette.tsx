import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { usePaletteStore } from '@/stores/palette'
import { useChatStore } from '@/stores/chat'
import { useUiStore } from '@/stores/ui'
import { call } from '@/lib/ipc'
import { pushToast, toastError } from '@/stores/toasts'

interface Command {
  id: string
  label: string
  hint?: string
  run: () => void
}

export default function CommandPalette(): React.JSX.Element | null {
  const open = usePaletteStore((s) => s.open)
  const setOpen = usePaletteStore((s) => s.setOpen)
  const [query, setQuery] = useState('')
  const [highlight, setHighlight] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const activeRef = useRef<HTMLButtonElement>(null)
  const restoreFocus = useRef<HTMLElement | null>(null)

  const conversations = useChatStore((s) => s.conversations)
  const activeId = useChatStore((s) => s.activeId)
  const conversationById = useChatStore((s) => s.conversationById)
  const select = useChatStore((s) => s.select)
  const create = useChatStore((s) => s.create)
  const update = useChatStore((s) => s.update)
  const setActiveTab = useUiStore((s) => s.setActiveTab)

  const close = (): void => {
    setOpen(false)
    setQuery('')
    setHighlight(0)
    restoreFocus.current?.focus?.()
  }

  const commands: Command[] = useMemo(() => {
    const cmds: Command[] = [
      {
        id: 'new',
        label: 'New chat',
        run: () => {
          setActiveTab('chat')
          void create().catch(toastError)
        }
      },
      { id: 'settings', label: 'Open Settings', run: () => setActiveTab('settings') },
      {
        id: 'clearcache',
        label: 'Clear KV cache',
        hint: 'engine',
        run: () => {
          void call('cache.clear')
            .then((r) =>
              pushToast(
                r.ok ? 'info' : 'warn',
                r.ok ? `Freed ${(r.freedBytes / 1e9).toFixed(1)} GB` : (r.reason ?? 'Engine busy')
              )
            )
            .catch(toastError)
        }
      }
    ]
    const conv = activeId ? conversationById[activeId] : undefined
    if (conv) {
      cmds.push({
        id: 'web',
        label: `Web search — turn ${conv.webEnabled ? 'off' : 'on'}`,
        hint: 'chat',
        run: () => void update(conv.id, { webEnabled: !conv.webEnabled }).catch(toastError)
      })
    }
    for (const c of conversations.slice(0, 40)) {
      cmds.push({
        id: `conv-${c.id}`,
        label: c.title || 'New chat',
        hint: 'go to',
        run: () => {
          setActiveTab('chat')
          void select(c.id).catch(toastError)
        }
      })
    }
    return cmds
  }, [conversations, activeId, conversationById, create, update, select, setActiveTab])

  const filtered = useMemo(() => {
    const q = query.toLowerCase().trim()
    return q ? commands.filter((c) => c.label.toLowerCase().includes(q)) : commands
  }, [commands, query])

  useEffect(() => {
    if (open) {
      restoreFocus.current = document.activeElement as HTMLElement | null
      setHighlight(0)
      setTimeout(() => inputRef.current?.focus(), 0)
    }
  }, [open])

  // Keep the arrow-selected row scrolled into view.
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: 'nearest' })
  }, [highlight])

  if (!open) return null

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 pt-[18vh]"
      onMouseDown={close}
    >
      <div
        role="dialog"
        aria-modal="true"
        className="w-[32rem] max-w-[90vw] overflow-hidden rounded-xl border border-zinc-700 bg-zinc-900 shadow-2xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          value={query}
          role="combobox"
          aria-expanded
          aria-controls="cmd-list"
          aria-autocomplete="list"
          aria-activedescendant={filtered[highlight] ? `cmd-${filtered[highlight].id}` : undefined}
          onChange={(e) => {
            setQuery(e.target.value)
            setHighlight(0)
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault()
              setHighlight((h) => Math.min(h + 1, filtered.length - 1))
            } else if (e.key === 'ArrowUp') {
              e.preventDefault()
              setHighlight((h) => Math.max(h - 1, 0))
            } else if (e.key === 'Enter') {
              e.preventDefault()
              const c = filtered[highlight]
              if (c) {
                c.run()
                close()
              }
            } else if (e.key === 'Escape') {
              e.preventDefault()
              close()
            }
          }}
          placeholder="Type a command or search conversations…"
          aria-label="Command palette"
          className="w-full border-b border-zinc-800 bg-transparent px-4 py-3 text-[14px] text-zinc-100 outline-none placeholder:text-zinc-600"
        />
        <div id="cmd-list" role="listbox" className="max-h-80 overflow-y-auto py-1">
          {filtered.length === 0 ? (
            <div className="px-4 py-3 text-[12px] text-zinc-600">No matches</div>
          ) : (
            filtered.map((c, i) => (
              <button
                key={c.id}
                id={`cmd-${c.id}`}
                role="option"
                aria-selected={i === highlight}
                ref={i === highlight ? activeRef : undefined}
                onMouseEnter={() => setHighlight(i)}
                onClick={() => {
                  c.run()
                  close()
                }}
                className={`flex w-full items-center justify-between gap-3 px-4 py-2 text-left text-[13px] ${
                  i === highlight ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-300'
                }`}
              >
                <span className="truncate">{c.label}</span>
                {c.hint && <span className="shrink-0 text-[10.5px] text-zinc-600">{c.hint}</span>}
              </button>
            ))
          )}
        </div>
      </div>
    </div>,
    document.body
  )
}
