import { useEffect, useMemo, useRef, useState } from 'react'
import { Bot, ChevronsLeft, ChevronsRight, Plus, SendHorizontal, Square } from 'lucide-react'
import 'highlight.js/styles/github-dark.css'
import { FEATURE_DEFAULTS, TIER_LABELS, TIER_ORDER } from '@shared/model-tiers'
import type { Tier } from '@shared/types'
import { useAgentStore } from '@/stores/agent'
import { useModelsStore } from '@/stores/models'
import { toastError } from '@/stores/toasts'
import { relativeTime } from '@/lib/format'
import Timeline from '../agent/Timeline'
import DiffPermission from './DiffPermission'

const MAX_TEXTAREA_PX = 140

// Mirrors AgentComposer, but defaults to the Code feature tier and fits the
// narrow panel — the Agent tab's composer is bound to the agent default.
function PanelComposer({ sessionId }: { sessionId: string }) {
  const prompt = useAgentStore((s) => s.prompt)
  const abort = useAgentStore((s) => s.abort)
  const busy = useAgentStore((s) => Boolean(s.busyBySession[sessionId]))

  const [text, setText] = useState('')
  // null = untouched: main then resolves the user's persisted code default.
  const [tier, setTier] = useState<Tier | null>(null)
  const defaultTier = useModelsStore((s) => s.overview?.defaults.code) ?? FEATURE_DEFAULTS.code
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
    <div className="shrink-0 px-3 pb-3">
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
          placeholder="Describe a task… (Enter to send)"
          spellCheck={false}
          className="block max-h-36 w-full resize-none bg-transparent px-3 py-2.5 text-[12.5px] leading-relaxed text-zinc-200 outline-none placeholder:text-zinc-600"
        />

        <div className="flex items-center gap-1.5 px-2 pb-2">
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
                className="rounded-lg bg-red-600/90 p-1.5 text-white hover:bg-red-500"
              >
                <Square size={13} />
              </button>
            ) : (
              <button
                onClick={submit}
                disabled={!text.trim()}
                title="Send"
                className="rounded-lg bg-emerald-600 p-1.5 text-white enabled:hover:bg-emerald-500 disabled:opacity-40"
              >
                <SendHorizontal size={13} />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

interface Props {
  root: string
}

/** Collapsible opencode panel for the Code tab; sessions are scoped to the workspace root. */
export default function AgentPanel({ root }: Props) {
  const init = useAgentStore((s) => s.init)
  const allSessions = useAgentStore((s) => s.sessions)
  const permissionQueue = useAgentStore((s) => s.permissionQueue)
  const createIn = useAgentStore((s) => s.createIn)
  const load = useAgentStore((s) => s.load)

  const [collapsed, setCollapsed] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)

  useEffect(() => {
    void init().catch(toastError)
  }, [init])

  const sessions = useMemo(
    () =>
      allSessions
        .filter((x) => x.tab === 'code' && x.directory === root)
        .sort((a, b) => (b.lastUsedAt ?? b.createdAt) - (a.lastUsedAt ?? a.createdAt)),
    [allSessions, root]
  )

  // Explicit pick wins while it exists; otherwise fall back to the newest.
  const session = sessions.find((x) => x.id === selectedId) ?? sessions[0]
  const sessionId = session?.id ?? null

  useEffect(() => {
    if (sessionId) void load(sessionId).catch(toastError)
  }, [sessionId, load])

  // First queued code ask for this workspace — any session of this root, so a
  // background session's ask never sits invisible behind the selected one. Fall
  // back to ANY code ask: one from another workspace's still-running session
  // would otherwise render nowhere and block that session indefinitely.
  const ask =
    permissionQueue.find((p) => p.tab === 'code' && sessions.some((x) => x.id === p.sessionId)) ??
    permissionQueue.find((p) => p.tab === 'code')
  const askSession = ask ? allSessions.find((x) => x.id === ask.sessionId) : undefined
  // Attribution when the ask isn't from the visible timeline: a foreign
  // workspace's ask names its directory, a sibling session's ask its title.
  const askLabel = !askSession
    ? undefined
    : askSession.directory !== root
      ? askSession.directory
      : askSession.id !== session?.id
        ? askSession.title || 'New session'
        : undefined

  const handleCreate = (): void => {
    if (creating) return
    setCreating(true)
    void createIn(root, 'code')
      .then((created) => setSelectedId(created.id))
      .catch(toastError)
      .finally(() => setCreating(false))
  }

  if (collapsed) {
    return (
      // The expand button sits inside the h-12 drag band so it lines up with
      // the in-band headers; no-drag keeps it clickable.
      <aside className="flex w-9 shrink-0 flex-col items-center gap-2 border-l border-zinc-800/80 bg-zinc-950/50 pb-2">
        <div className="drag-region flex h-12 w-full shrink-0 items-center justify-center">
          <button
            onClick={() => setCollapsed(false)}
            title="Show agent panel"
            className="no-drag rounded-md p-1.5 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
          >
            <ChevronsLeft size={14} />
          </button>
        </div>
        {ask && (
          <span
            title="The agent is waiting for permission"
            className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-amber-400"
          />
        )}
      </aside>
    )
  }

  return (
    <aside className="flex w-96 shrink-0 flex-col border-l border-zinc-800/80 bg-zinc-950/50">
      {/* In-band header: h-12 row shares the hiddenInset titlebar band and drags the window. */}
      <header className="drag-region flex h-12 shrink-0 items-center gap-1 border-b border-zinc-800/80 px-2">
        <button
          onClick={() => setCollapsed(true)}
          title="Hide agent panel"
          className="no-drag shrink-0 rounded-md p-1.5 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
        >
          <ChevronsRight size={14} />
        </button>
        {sessions.length > 0 && session && (
          <select
            value={session.id}
            onChange={(e) => setSelectedId(e.target.value)}
            title="Session"
            className="no-drag min-w-0 flex-1 truncate rounded-md border border-zinc-800 bg-zinc-900 px-1.5 py-1 text-[11.5px] text-zinc-300 outline-none focus:border-zinc-600"
          >
            {sessions.map((x) => (
              <option key={x.id} value={x.id}>
                {(x.title || 'New session') +
                  ' — ' +
                  relativeTime(x.lastUsedAt ?? x.createdAt)}
              </option>
            ))}
          </select>
        )}
        <button
          onClick={handleCreate}
          disabled={creating}
          title="New session"
          className="no-drag ml-auto shrink-0 rounded-md p-1.5 text-zinc-500 enabled:hover:bg-zinc-800 enabled:hover:text-zinc-200 disabled:opacity-40"
        >
          <Plus size={14} />
        </button>
      </header>

      {session ? (
        <>
          <Timeline key={session.id} sessionId={session.id} />
          {ask && <DiffPermission ask={ask} sessionLabel={askLabel} />}
          <PanelComposer key={`composer-${session.id}`} sessionId={session.id} />
        </>
      ) : (
        <>
          <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
            <Bot size={26} strokeWidth={1.5} className="text-zinc-700" />
            <div>
              <h3 className="text-[13px] font-medium text-zinc-300">No coding session</h3>
              <p className="mt-1 text-[11.5px] leading-relaxed text-zinc-600">
                The agent works inside this workspace — it asks for review before editing files.
              </p>
            </div>
            <button
              onClick={handleCreate}
              disabled={creating}
              className="no-drag flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-1.5 text-[12px] font-medium text-white enabled:hover:bg-emerald-500 disabled:opacity-40"
            >
              <Plus size={13} />
              New session
            </button>
          </div>
          {/* A foreign workspace's ask must stay answerable even with no local session. */}
          {ask && <DiffPermission ask={ask} sessionLabel={askLabel} />}
        </>
      )}
    </aside>
  )
}
