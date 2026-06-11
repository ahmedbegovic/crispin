import { useEffect, useRef, useState } from 'react'
import { SendHorizontal, Square, Workflow } from 'lucide-react'
import { FEATURE_DEFAULTS, TIER_LABELS, TIER_ORDER } from '@shared/model-tiers'
import type { PermissionMode, Tier } from '@shared/types'
import { useAgentStore } from '@/stores/agent'
import { useModelsStore } from '@/stores/models'
import { toastError } from '@/stores/toasts'
import SkillPicker from './SkillPicker'
import { useSlashSkills } from './useSlashSkills'

const MAX_TEXTAREA_PX = 180

export const MODE_LABELS: Record<PermissionMode, string> = {
  normal: 'Normal',
  plan: 'Plan',
  acceptEdits: 'Accept Edits',
  auto: 'Auto'
}
export const MODE_ORDER: PermissionMode[] = ['normal', 'plan', 'acceptEdits', 'auto']

interface Props {
  sessionId: string
}

export default function AgentComposer({ sessionId }: Props) {
  const prompt = useAgentStore((s) => s.prompt)
  const abort = useAgentStore((s) => s.abort)
  const busy = useAgentStore((s) => Boolean(s.busyBySession[sessionId]))
  const mode = useAgentStore((s) => s.modeBySession[sessionId] ?? 'normal')
  const setMode = useAgentStore((s) => s.setMode)
  const startPipeline = useAgentStore((s) => s.startPipeline)
  const pipelineActive = useAgentStore((s) => {
    const p = s.pipelineBySession[sessionId]
    return p !== undefined && (p.status === 'running' || p.status === 'waiting_user')
  })
  const [pipelineMode, setPipelineMode] = useState(false)
  const [pipelineCommit, setPipelineCommit] = useState(true)
  const [pipelineDocs, setPipelineDocs] = useState(false)

  const [text, setText] = useState('')
  // null = untouched: main then resolves the user's persisted agent default.
  const [tier, setTier] = useState<Tier | null>(null)
  const defaultTier = useModelsStore((s) => s.overview?.defaults.agent) ?? FEATURE_DEFAULTS.agent
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const slash = useSlashSkills(text, setText)

  // Autosize after every text commit (covers programmatic clears on send).
  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, MAX_TEXTAREA_PX)}px`
  }, [text])

  const submit = (): void => {
    const trimmed = text.trim()
    if (busy || pipelineActive || !trimmed) return
    setText('')
    const restore = (err: unknown): void => {
      // A rejected prompt persisted nothing — put the draft back so the user
      // doesn't retype it, unless newer input has been entered meanwhile.
      setText((cur) => cur || trimmed)
      toastError(err)
    }
    if (pipelineMode) {
      void startPipeline(sessionId, trimmed, {
        commit: pipelineCommit,
        docs: pipelineDocs
      }).catch(restore)
      return
    }
    void prompt(sessionId, slash.transformForSubmit(trimmed), tier ?? undefined).catch(restore)
  }

  return (
    <div className="shrink-0">
      <div className="mx-auto w-full max-w-3xl px-6 pb-4">
        <div className="relative rounded-xl border border-zinc-800 bg-zinc-900/80">
          {slash.open && (
            <SkillPicker
              skills={slash.skills}
              highlight={slash.highlight}
              onHover={slash.setHighlight}
              onPick={slash.pick}
            />
          )}
          <textarea
            ref={textareaRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (slash.onKeyDown(e)) return
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

            <select
              value={mode}
              onChange={(e) => setMode(sessionId, e.target.value as PermissionMode)}
              title="Permission mode"
              className={`rounded-md border px-1.5 py-1 text-[11px] outline-none focus:border-zinc-600 ${
                mode === 'auto'
                  ? 'border-amber-500/50 bg-amber-500/10 text-amber-300'
                  : 'border-zinc-800 bg-zinc-900 text-zinc-400 hover:text-zinc-200'
              }`}
            >
              {MODE_ORDER.map((m) => (
                <option key={m} value={m}>
                  {MODE_LABELS[m]}
                </option>
              ))}
            </select>

            <button
              onClick={() => setPipelineMode((v) => !v)}
              title="Pipeline mode: Plan → Implement → Verify → Commit → Document"
              className={`rounded-md border p-1.5 ${
                pipelineMode
                  ? 'border-emerald-500/50 bg-emerald-500/10 text-emerald-400'
                  : 'border-transparent text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200'
              }`}
            >
              <Workflow size={14} />
            </button>
            {pipelineMode && (
              <span className="flex items-center gap-2 text-[10.5px] text-zinc-500">
                <label className="flex items-center gap-1">
                  <input
                    type="checkbox"
                    checked={pipelineCommit}
                    onChange={(e) => setPipelineCommit(e.target.checked)}
                  />
                  commit
                </label>
                <label className="flex items-center gap-1">
                  <input
                    type="checkbox"
                    checked={pipelineDocs}
                    onChange={(e) => setPipelineDocs(e.target.checked)}
                  />
                  docs
                </label>
              </span>
            )}

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
                  disabled={!text.trim() || pipelineActive}
                  title={pipelineActive ? 'A pipeline is running' : 'Send'}
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
