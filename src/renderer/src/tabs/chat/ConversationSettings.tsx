import { useEffect, useId, useRef, useState } from 'react'
import { Settings2, X } from 'lucide-react'
import type { PromptPreset } from '@shared/ipc'
import type { Conversation, ModelSampling } from '@shared/types'
import { useChatStore } from '@/stores/chat'
import { useSettingsStore } from '@/stores/settings'
import { useDismissable } from '@/lib/useDismissable'
import { toastError } from '@/stores/toasts'

const inputClass =
  'w-full rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 text-[12px] text-zinc-200 outline-none placeholder:text-zinc-600 focus:border-zinc-600'

/** Blank -> null; otherwise a finite number clamped to the schema's bounds (so a
 *  stray value can't get rejected by chat.update and revert the optimistic patch). */
function num(v: string, min: number, max: number): number | null {
  const t = v.trim()
  if (!t) return null
  const n = Number(t)
  if (!Number.isFinite(n)) return null
  return Math.min(max, Math.max(min, n))
}

/** Build the sampling override; all-blank = null (follow the model's defaults). */
function samplingFrom(temp: string, topP: string, topK: string): ModelSampling | null {
  const t = num(temp, 0, 5)
  const p = num(topP, 0, 1)
  const k = num(topK, 0, Number.MAX_SAFE_INTEGER)
  if (t === null && p === null && k === null) return null
  return { temperature: t, topP: p, topK: k }
}

function sameSampling(a: ModelSampling | null, b: ModelSampling | null): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return a.temperature === b.temperature && a.topP === b.topP && a.topK === b.topK
}

function SamplingInput({
  label,
  value,
  onChange,
  onCommit,
  placeholder
}: {
  label: string
  value: string
  onChange: (v: string) => void
  onCommit: () => void
  placeholder: string
}) {
  return (
    <label className="flex flex-col gap-0.5">
      <span className="px-0.5 text-[9.5px] uppercase tracking-wide text-zinc-600">{label}</span>
      <input
        type="number"
        aria-label={label}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onCommit}
        placeholder={placeholder}
        className={inputClass}
      />
    </label>
  )
}

/** Seeded from the conversation on each open (the panel remounts), committing to
 *  the chat store on blur. Presets are app-global (settings store). */
function Panel({ conversation }: { conversation: Conversation }) {
  const update = useChatStore((s) => s.update)
  const presets = useSettingsStore((s) => s.settings?.promptPresets ?? [])
  const updateSettings = useSettingsStore((s) => s.update)

  const [sys, setSys] = useState(conversation.systemPrompt ?? '')
  const [temp, setTemp] = useState(conversation.sampling?.temperature?.toString() ?? '')
  const [topP, setTopP] = useState(conversation.sampling?.topP?.toString() ?? '')
  const [topK, setTopK] = useState(conversation.sampling?.topK?.toString() ?? '')
  const [presetName, setPresetName] = useState('')
  const sysId = useId()

  const commitSys = (): void => {
    const next = sys.trim() || null
    if (next !== (conversation.systemPrompt ?? null))
      void update(conversation.id, { systemPrompt: next }).catch(toastError)
  }
  const commitSampling = (): void => {
    const next = samplingFrom(temp, topP, topK)
    // Skip a no-op write: chat.update always bumps updated_at, which would jump
    // the conversation to the top of the sidebar on a bare focus + blur.
    if (sameSampling(next, conversation.sampling)) return
    void update(conversation.id, { sampling: next }).catch(toastError)
  }
  const resetSampling = (): void => {
    setTemp('')
    setTopP('')
    setTopK('')
    if (conversation.sampling !== null)
      void update(conversation.id, { sampling: null }).catch(toastError)
  }
  const applyPreset = (p: PromptPreset): void => {
    setSys(p.systemPrompt)
    setTemp(p.sampling?.temperature?.toString() ?? '')
    setTopP(p.sampling?.topP?.toString() ?? '')
    setTopK(p.sampling?.topK?.toString() ?? '')
    // One update() call so the store's post-await re-assert covers both fields.
    void update(conversation.id, {
      systemPrompt: p.systemPrompt.trim() || null,
      sampling: p.sampling
    }).catch(toastError)
  }
  const savePreset = (): void => {
    const name = presetName.trim()
    if (!name) return
    const preset: PromptPreset = {
      id: crypto.randomUUID(),
      name,
      systemPrompt: sys.trim(),
      sampling: samplingFrom(temp, topP, topK)
    }
    void updateSettings({ promptPresets: [...presets, preset] }).catch(toastError)
    setPresetName('')
  }
  const deletePreset = (id: string): void => {
    void updateSettings({ promptPresets: presets.filter((p) => p.id !== id) }).catch(toastError)
  }

  // Fields commit on blur, but Escape / click-outside unmounts the input without
  // firing blur — flush pending edits on close so a typed system prompt isn't lost.
  const flushRef = useRef<() => void>(() => {})
  flushRef.current = () => {
    commitSys()
    commitSampling()
  }
  useEffect(() => () => flushRef.current(), [])

  return (
    <div
      role="dialog"
      aria-label="Conversation settings"
      className="pop-in absolute right-0 top-full z-20 mt-1 w-72 origin-top-right rounded-lg border border-zinc-700 bg-zinc-900 p-2.5 shadow-xl"
    >
      <label
        htmlFor={sysId}
        className="mb-1 block text-[10px] font-medium uppercase tracking-[0.06em] text-zinc-500"
      >
        System prompt
      </label>
      <textarea
        id={sysId}
        value={sys}
        onChange={(e) => setSys(e.target.value)}
        onBlur={commitSys}
        rows={3}
        placeholder="Optional — steer this conversation's persona / rules"
        className={`${inputClass} resize-none`}
      />

      <div className="mt-2.5 flex items-center justify-between">
        <span className="text-[10px] font-medium uppercase tracking-[0.06em] text-zinc-500">
          Sampling
        </span>
        <button onClick={resetSampling} className="text-[10.5px] text-zinc-500 hover:text-zinc-300">
          Reset to default
        </button>
      </div>
      <div className="mt-1 grid grid-cols-3 gap-1.5">
        <SamplingInput label="Temp" value={temp} onChange={setTemp} onCommit={commitSampling} placeholder="0–5" />
        <SamplingInput label="Top-p" value={topP} onChange={setTopP} onCommit={commitSampling} placeholder="0–1" />
        <SamplingInput label="Top-k" value={topK} onChange={setTopK} onCommit={commitSampling} placeholder="auto" />
      </div>
      <p className="mt-1 text-[10px] text-zinc-600">Blank = follow the model's recommended value.</p>

      <div className="mt-2.5 border-t border-zinc-800/80 pt-2">
        <span className="text-[10px] font-medium uppercase tracking-[0.06em] text-zinc-500">
          Presets
        </span>
        {presets.length > 0 && (
          <div className="mt-1 flex flex-col gap-0.5">
            {presets.map((p) => (
              <div
                key={p.id}
                className="group/preset flex items-center gap-1 rounded-md px-1.5 py-1 hover:bg-zinc-800/80"
              >
                <button
                  onClick={() => applyPreset(p)}
                  title="Apply preset"
                  className="min-w-0 flex-1 truncate text-left text-[12px] text-zinc-300"
                >
                  {p.name}
                </button>
                <button
                  onClick={() => deletePreset(p.id)}
                  aria-label={`Delete preset ${p.name}`}
                  className="shrink-0 rounded p-0.5 text-zinc-600 opacity-0 transition-opacity hover:text-red-400 group-hover/preset:opacity-100"
                >
                  <X size={12} />
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="mt-1.5 flex items-center gap-1.5">
          <input
            value={presetName}
            onChange={(e) => setPresetName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                savePreset()
              }
            }}
            placeholder="Save current as…"
            className={inputClass}
          />
          <button
            onClick={savePreset}
            disabled={!presetName.trim()}
            className="shrink-0 rounded-md bg-emerald-600 px-2 py-1 text-[11px] font-medium text-white hover:bg-emerald-500 disabled:opacity-40"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  )
}

export default function ConversationSettings({
  conversation
}: {
  conversation: Conversation
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useDismissable(open, () => setOpen(false), { outsideRef: ref })

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        title="Conversation settings"
        aria-label="Conversation settings"
        aria-haspopup="dialog"
        aria-expanded={open}
        className={`press rounded-md p-1.5 transition-colors ${
          open ? 'bg-zinc-800 text-zinc-200' : 'text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200'
        }`}
      >
        <Settings2 size={14} />
      </button>
      {/* Remounts per open so the inputs re-seed from the latest conversation. */}
      {open && <Panel conversation={conversation} />}
    </div>
  )
}
