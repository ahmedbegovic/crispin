import { useEffect, useRef, useState } from 'react'
import { SendHorizontal, Square } from 'lucide-react'
import { FEATURE_DEFAULTS, TIER_LABELS, TIER_ORDER } from '@shared/model-tiers'
import type { Tier } from '@shared/types'
import { useAgentStore } from '@/stores/agent'
import { useModelsStore } from '@/stores/models'
import { toastError } from '@/stores/toasts'

const MAX_TEXTAREA_PX = 180

interface Props {
  sessionId: string
}

export default function AgentComposer({ sessionId }: Props) {
  const prompt = useAgentStore((s) => s.prompt)
  const abort = useAgentStore((s) => s.abort)
  const busy = useAgentStore((s) => Boolean(s.busyBySession[sessionId]))

  const [text, setText] = useState('')
  // null = untouched: main then resolves the user's persisted agent default.
  const [tier, setTier] = useState<Tier | null>(null)
  const defaultTier = useModelsStore((s) => s.overview?.defaults.agent) ?? FEATURE_DEFAULTS.agent
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // Autosize after every text commit (covers programmatic clears on send).
  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, MAX_TEXTAREA_PX)}px`
  }, [text])

  const submit = (): void => {
    const trimmed = text.trim()
    if (busy || !trimmed) return
    setText('')
    void prompt(sessionId, trimmed, tier ?? undefined).catch((err) => {
      // A rejected prompt persisted nothing — put the draft back so the user
      // doesn't retype it, unless newer input has been entered meanwhile.
      setText((cur) => cur || trimmed)
      toastError(err)
    })
  }

  return (
    <div className="shrink-0">
      <div className="mx-auto w-full max-w-3xl px-6 pb-4">
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/80">
          <textarea
            ref={textareaRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault()
                submit()
              }
            }}
            rows={1}
            placeholder="Describe a task… (Enter to send, Shift+Enter for newline)"
            spellCheck={false}
            className="block max-h-44 w-full resize-none bg-transparent px-3.5 py-3 text-[13px] leading-relaxed text-zinc-200 outline-none placeholder:text-zinc-600"
          />

          <div className="flex items-center gap-1.5 px-2.5 pb-2.5">
            <select
              value={tier ?? defaultTier}
              onChange={(e) => setTier(e.target.value as Tier)}
              title="Model tier"
              className="rounded-md border border-zinc-800 bg-zinc-900 px-1.5 py-1 text-[11px] text-zinc-400 outline-none hover:text-zinc-200 focus:border-zinc-600"
            >
              {TIER_ORDER.map((t) => (
                <option key={t} value={t}>
                  {TIER_LABELS[t]}
                </option>
              ))}
            </select>

            <div className="ml-auto flex items-center gap-2">
              {busy ? (
                <button
                  onClick={() => void abort(sessionId).catch(toastError)}
                  title="Stop the agent"
                  className="rounded-lg bg-red-600/90 p-2 text-white hover:bg-red-500"
                >
                  <Square size={13} />
                </button>
              ) : (
                <button
                  onClick={submit}
                  disabled={!text.trim()}
                  title="Send"
                  className="rounded-lg bg-emerald-600 p-2 text-white enabled:hover:bg-emerald-500 disabled:opacity-40"
                >
                  <SendHorizontal size={13} />
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
