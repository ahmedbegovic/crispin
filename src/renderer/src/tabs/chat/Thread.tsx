import { useEffect, useRef, useState } from 'react'
import { Virtuoso } from 'react-virtuoso'
import { AlertTriangle, Loader2, MessageSquare, X } from 'lucide-react'
import type { ChatMessage } from '@shared/types'
import { useChatStore } from '@/stores/chat'
import { useModelsStore } from '@/stores/models'
import { useUiStore } from '@/stores/ui'
import { toastError } from '@/stores/toasts'
import { friendlyError } from '@/lib/friendlyError'
import MessageBubble from './MessageBubble'
import { chatRunPhase, chatRunPhaseLabel, type ChatRunPhase } from './runStatus'

const SUGGESTIONS = [
  'What kinds of tasks are you good at?',
  'Explain the tradeoffs between RAG and long-context prompting',
  'Write a zsh one-liner that finds the 10 largest files under ~/Desktop'
]

// Stable component refs so Virtuoso doesn't remount header/footer every render.
// Header clears the hiddenInset titlebar band (h-12).
const virtuosoComponents = {
  Header: () => <div className="h-12" />,
  Footer: () => <div className="h-4" />
}

function EmptyThread({ conversationId }: { conversationId: string }) {
  const send = useChatStore((s) => s.send)
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 px-8">
      <MessageSquare size={28} strokeWidth={1.5} className="text-zinc-700" />
      <p className="text-[13px] text-zinc-500">Send a message to get started, or try:</p>
      <div className="flex max-w-md flex-col gap-2">
        {SUGGESTIONS.map((suggestion) => (
          <button
            key={suggestion}
            onClick={() => void send(conversationId, suggestion).catch(toastError)}
            className="rounded-lg border border-zinc-800 bg-zinc-900/40 px-3 py-2 text-left text-[12px] text-zinc-400 hover:border-zinc-600 hover:text-zinc-200"
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
  return (
    <div className="mx-auto w-full max-w-[42rem] px-6 pb-2">
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
    <div className="mx-auto w-full max-w-[42rem] px-6 pb-2">
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
  const streamingId = useChatStore((s) => s.streaming[conversationId])
  const lastError = useChatStore((s) => s.lastError[conversationId])
  const streamingMessage = streamingId
    ? messages?.find((message) => message.id === streamingId)
    : undefined
  const runPhase = chatRunPhase(streamingId, streamingMessage)
  const busy = runPhase !== 'idle'

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

  if (!messages)
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center text-[13px] text-zinc-600">
        Loading…
      </div>
    )

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {messages.length === 0 ? (
        <EmptyThread conversationId={conversationId} />
      ) : (
        <Virtuoso
          style={{ height: '100%' }}
          // overflow-x-hidden: content wraps; the thread scrolls down, never
          // sideways (same guard as the agent Timeline).
          className="min-h-0 flex-1 overflow-x-hidden"
          data={messages}
          computeItemKey={(_, m: ChatMessage) => m.id}
          initialTopMostItemIndex={messages.length - 1}
          followOutput={(isAtBottom) => (isAtBottom ? 'auto' : false)}
          components={virtuosoComponents}
          itemContent={(_, message: ChatMessage) => (
            <div className="mx-auto w-full max-w-[42rem] px-6">
              <MessageBubble
                message={message}
                streaming={message.id === streamingId}
                busy={busy}
              />
            </div>
          )}
        />
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
