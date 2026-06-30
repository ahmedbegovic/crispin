import { useEffect, useMemo, useRef, useState } from 'react'
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso'
import { AlertTriangle, ChevronDown, ChevronUp, Loader2, MessageSquare, Search, X } from 'lucide-react'
import { FAMILY_LABELS, FEATURE_DEFAULTS, TIER_LABELS } from '@shared/model-tiers'
import type { ChatMessage, Conversation } from '@shared/types'
import { useChatStore } from '@/stores/chat'
import { useModelsStore } from '@/stores/models'
import { useUiStore } from '@/stores/ui'
import { toastError } from '@/stores/toasts'
import { friendlyError } from '@/lib/friendlyError'
import MessageBubble from './MessageBubble'
import ThreadHeader from './ThreadHeader'
import { chatRunPhase, chatRunPhaseLabel, type ChatRunPhase } from './runStatus'

const SUGGESTIONS = [
  'What kinds of tasks are you good at?',
  'Explain the tradeoffs between RAG and long-context prompting',
  'Write a zsh one-liner that finds the 10 largest files under ~/Desktop'
]

// Stable component refs so Virtuoso doesn't remount header/footer every render.
// The real ThreadHeader now clears the titlebar band, so this top spacer is just
// breathing room above the first message.
const virtuosoComponents = {
  Header: () => <div className="h-3" />,
  Footer: () => <div className="h-4" />
}

function EmptyThread({
  conversationId,
  conversation
}: {
  conversationId: string
  conversation?: Conversation
}) {
  const send = useChatStore((s) => s.send)
  const chatDefaultTier = useModelsStore((s) => s.overview?.defaults.chat) ?? FEATURE_DEFAULTS.chat
  const tier =
    conversation?.tierPinned && conversation.defaultTier ? conversation.defaultTier : chatDefaultTier
  const family = conversation?.family ? FAMILY_LABELS[conversation.family] : 'Default model'
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 px-8">
      <MessageSquare size={28} strokeWidth={1.5} className="text-zinc-700" />
      <div className="text-center">
        <p className="text-[13px] text-zinc-400">
          Talking to <span className="font-semibold text-zinc-100">{family}</span>
          <span className="text-zinc-600"> · {TIER_LABELS[tier]}</span>
        </p>
        <p className="mt-0.5 text-[11px] text-zinc-600">Enter to send · Shift+Enter for a newline</p>
      </div>
      <div className="flex max-w-md flex-col gap-2">
        {SUGGESTIONS.map((suggestion) => (
          <button
            key={suggestion}
            onClick={() => void send(conversationId, suggestion).catch(toastError)}
            className="press rounded-lg border border-zinc-800 bg-zinc-900/40 px-3 py-2 text-left text-[12px] text-zinc-400 hover:border-zinc-600 hover:text-zinc-200"
          >
            {suggestion}
          </button>
        ))}
      </div>
    </div>
  )
}

function ErrorBanner({ conversationId, error }: { conversationId: string; error: string }) {
  const clearError = useChatStore((s) => s.clearError)
  const retryLast = useChatStore((s) => s.retryLast)
  const engineRunning = useModelsStore((s) => s.overview?.engine.running)
  const setActiveTab = useUiStore((s) => s.setActiveTab)
  const [copied, setCopied] = useState(false)
  const copyDiagnostics = (): void => {
    void navigator.clipboard
      .writeText(error)
      .then(() => {
        setCopied(true)
        window.setTimeout(() => setCopied(false), 1500)
      })
      .catch(toastError)
  }
  return (
    <div className="mx-auto w-full max-w-[var(--chat-measure,46rem)] px-6 pb-2">
      <div
        role="alert"
        className="flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-[12px] text-red-300"
      >
        <AlertTriangle size={14} className="mt-0.5 shrink-0" />
        <div className="min-w-0 flex-1">
          <p className="select-text break-words">{friendlyError(error)}</p>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <button
              onClick={() => void retryLast(conversationId).catch(toastError)}
              className="rounded bg-red-500/20 px-2 py-0.5 font-medium text-red-200 hover:bg-red-500/30"
            >
              Retry
            </button>
            <button
              onClick={copyDiagnostics}
              aria-label="Copy diagnostics"
              className="rounded px-2 py-0.5 text-red-300/80 hover:bg-red-500/20 hover:text-red-200"
            >
              {copied ? 'Copied' : 'Copy diagnostics'}
            </button>
            {engineRunning !== true && (
              <button
                onClick={() => setActiveTab('models')}
                className="rounded px-2 py-0.5 text-red-300/80 hover:bg-red-500/20"
              >
                Open Models
              </button>
            )}
          </div>
        </div>
        <button
          onClick={() => clearError(conversationId)}
          aria-label="Dismiss error"
          className="rounded p-0.5 hover:bg-red-500/20"
        >
          <X size={13} />
        </button>
      </div>
    </div>
  )
}

function ThreadRunStatus({ phase }: { phase: ChatRunPhase }) {
  if (phase !== 'starting') return null
  return (
    <div className="mx-auto w-full max-w-[var(--chat-measure,46rem)] px-6 pb-2">
      <div className="flex items-center gap-2 text-[12px] text-zinc-500">
        <Loader2 size={13} className="animate-spin" />
        {chatRunPhaseLabel(phase)}
      </div>
    </div>
  )
}

interface Props {
  conversationId: string
}

export default function Thread({ conversationId }: Props) {
  const messages = useChatStore((s) => s.messagesById[conversationId])
  const conversation = useChatStore((s) => s.conversationById[conversationId])
  const streamingId = useChatStore((s) => s.streaming[conversationId])
  const modelLoad = useChatStore((s) => s.modelLoad)
  const stopping = useChatStore((s) => s.stopping)
  const lastError = useChatStore((s) => s.lastError[conversationId])
  const activeModelLoad = modelLoad[conversationId]
  const isStopping = !!stopping[conversationId]
  const streamingMessage = streamingId
    ? messages?.find((message) => message.id === streamingId)
    : undefined
  const runPhase = chatRunPhase(streamingId, streamingMessage, {
    modelLoad: !!activeModelLoad,
    stopping: isStopping
  })
  const busy = runPhase !== 'idle'

  const rootRef = useRef<HTMLDivElement>(null)
  const virtuosoRef = useRef<VirtuosoHandle>(null)
  const [atBottom, setAtBottom] = useState(true)

  // Find-in-conversation: matches over the active path's text parts (this branch
  // only). Cross-conversation search lives in the sidebar.
  const [findOpen, setFindOpen] = useState(false)
  const [findQuery, setFindQuery] = useState('')
  const [activeMatch, setActiveMatch] = useState(0)

  const matches = useMemo(() => {
    const q = findQuery.trim().toLowerCase()
    if (!q || !messages) return []
    const out: number[] = []
    messages.forEach((m, idx) => {
      const hay = m.parts
        .map((p) => (p.type === 'text' ? p.text : ''))
        .join('\n')
        .toLowerCase()
      if (hay.includes(q)) out.push(idx)
    })
    return out
  }, [messages, findQuery])

  // Inline-clamped target row. Deriving a PRIMITIVE index (not the `matches`
  // array, which is a fresh reference on every streamed token) keeps the scroll
  // effect from re-firing per token, and never indexes out of range mid-narrow.
  const targetIndex =
    matches.length > 0 ? matches[Math.min(activeMatch, matches.length - 1)] : -1

  // Keep the active-match state in range for the "i/m" counter + stepMatch math.
  useEffect(() => {
    setActiveMatch((a) => (matches.length === 0 ? 0 : Math.min(a, matches.length - 1)))
  }, [matches.length])

  // Scroll only when the resolved target actually changes (open / step / query) —
  // not on every token (targetIndex is stable while a matched message streams).
  useEffect(() => {
    if (!findOpen || targetIndex < 0) return
    virtuosoRef.current?.scrollToIndex({ index: targetIndex, align: 'center', behavior: 'smooth' })
  }, [findOpen, targetIndex])

  // ⌘F / Ctrl-F opens find, but only while this thread is the visible tab
  // (hidden tabs stay mounted — offsetParent is null when display:none).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f') {
        if (!rootRef.current || rootRef.current.offsetParent === null) return
        if ((e.target as HTMLElement | null)?.closest('.monaco-editor, .xterm')) return
        if (document.querySelector('[role="dialog"][aria-modal="true"]')) return
        e.preventDefault()
        setFindOpen(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const closeFind = (): void => {
    setFindOpen(false)
    setFindQuery('')
    setActiveMatch(0)
  }
  const stepMatch = (dir: 1 | -1): void => {
    if (matches.length === 0) return
    setActiveMatch((a) => (a + dir + matches.length) % matches.length)
  }
  const scrollToLatest = (): void => {
    if (!messages || messages.length === 0) return
    virtuosoRef.current?.scrollToIndex({
      index: messages.length - 1,
      align: 'end',
      behavior: 'smooth'
    })
  }

  // Announce on the busy edges: a screen reader never hears a region being
  // cleared, so "stopped/cleared to ''" left completion silent. Announce the
  // falling edge ("Response ready") too.
  const [announce, setAnnounce] = useState('')
  const prevPhase = useRef<ChatRunPhase>('idle')
  useEffect(() => {
    if (prevPhase.current !== 'idle' && runPhase === 'idle') setAnnounce('Response ready')
    else if (runPhase !== 'idle') setAnnounce(chatRunPhaseLabel(runPhase))
    prevPhase.current = runPhase
  }, [runPhase])

  const highlightId =
    findOpen && targetIndex >= 0 ? (messages?.[targetIndex]?.id ?? null) : null

  return (
    <div ref={rootRef} className="flex min-h-0 flex-1 flex-col">
      {conversation && (
        <ThreadHeader
          conversation={conversation}
          findOpen={findOpen}
          onToggleFind={() => (findOpen ? closeFind() : setFindOpen(true))}
        />
      )}
      {findOpen && (
        <div className="flex items-center gap-2 border-b border-zinc-800/60 px-4 py-1.5">
          <Search size={13} className="shrink-0 text-zinc-600" />
          <input
            autoFocus
            value={findQuery}
            onChange={(e) => setFindQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                stepMatch(e.shiftKey ? -1 : 1)
              } else if (e.key === 'Escape') {
                e.preventDefault()
                closeFind()
              }
            }}
            placeholder="Find in conversation…"
            aria-label="Find in conversation"
            className="min-w-0 flex-1 bg-transparent text-[12.5px] text-zinc-200 outline-none placeholder:text-zinc-600"
          />
          <span className="shrink-0 tabular-nums text-[11px] text-zinc-500">
            {matches.length ? `${activeMatch + 1}/${matches.length}` : findQuery.trim() ? 'No matches' : ''}
          </span>
          <button
            onClick={() => stepMatch(-1)}
            disabled={matches.length === 0}
            aria-label="Previous match"
            className="rounded p-0.5 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200 disabled:opacity-30"
          >
            <ChevronUp size={14} />
          </button>
          <button
            onClick={() => stepMatch(1)}
            disabled={matches.length === 0}
            aria-label="Next match"
            className="rounded p-0.5 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200 disabled:opacity-30"
          >
            <ChevronDown size={14} />
          </button>
          <button
            onClick={closeFind}
            aria-label="Close find"
            className="rounded p-0.5 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
          >
            <X size={14} />
          </button>
        </div>
      )}

      {!messages ? (
        <div className="flex min-h-0 flex-1 items-center justify-center text-[13px] text-zinc-600">
          Loading…
        </div>
      ) : messages.length === 0 ? (
        <EmptyThread conversationId={conversationId} conversation={conversation} />
      ) : (
        <div className="relative min-h-0 flex-1">
          <Virtuoso
            ref={virtuosoRef}
            style={{ height: '100%' }}
            // overflow-x-hidden: content wraps; the thread scrolls down, never
            // sideways (same guard as the agent Timeline).
            className="min-h-0 flex-1 overflow-x-hidden"
            data={messages}
            computeItemKey={(_, m: ChatMessage) => m.id}
            initialTopMostItemIndex={messages.length - 1}
            followOutput={(isAtBottom) => (isAtBottom ? 'auto' : false)}
            atBottomStateChange={setAtBottom}
            atBottomThreshold={120}
            components={virtuosoComponents}
            itemContent={(_, message: ChatMessage) => (
              <div
                className={`mx-auto w-full max-w-[var(--chat-measure,46rem)] rounded-lg px-6 ${
                  message.id === highlightId ? 'bg-sky-500/[0.07]' : ''
                }`}
              >
                <MessageBubble
                  message={message}
                  streaming={message.id === streamingId}
                  busy={busy}
                  isLatest={message.id === messages[messages.length - 1]?.id}
                />
              </div>
            )}
          />
          {/* Jump back to the live tail after scrolling up — emerald dot while a
              run is streaming new content out of view. */}
          {!atBottom && (
            <button
              onClick={scrollToLatest}
              className="absolute bottom-3 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-zinc-700 bg-zinc-800/95 px-3 py-1 text-[11px] text-zinc-200 shadow-lg backdrop-blur hover:bg-zinc-700"
            >
              {busy && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-500" />}
              <ChevronDown size={13} />
              {busy ? 'New content' : 'Latest'}
            </button>
          )}
        </div>
      )}
      {/* Announce generation state on its edges (not per token) for screen readers. */}
      <div role="status" aria-live="polite" aria-busy={busy} className="sr-only">
        {announce}
      </div>
      <ThreadRunStatus phase={runPhase} />
      {lastError && <ErrorBanner conversationId={conversationId} error={lastError} />}
    </div>
  )
}
