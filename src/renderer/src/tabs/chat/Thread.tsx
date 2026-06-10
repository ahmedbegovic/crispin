import { Virtuoso } from 'react-virtuoso'
import { AlertTriangle, MessageSquare, X } from 'lucide-react'
import type { ChatMessage } from '@shared/types'
import { useChatStore } from '@/stores/chat'
import { useModelsStore } from '@/stores/models'
import { toastError } from '@/stores/toasts'
import MessageBubble from './MessageBubble'

const SUGGESTIONS = [
  'What kinds of tasks are you good at?',
  'Explain the tradeoffs between RAG and long-context prompting',
  'Write a zsh one-liner that finds the 10 largest files under ~/Desktop'
]

// Stable component refs so Virtuoso doesn't remount header/footer every render.
// Header clears the hiddenInset titlebar drag overlay (h-9).
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
  const engineRunning = useModelsStore((s) => s.overview?.engine.running)
  return (
    <div className="mx-auto w-full max-w-3xl px-6 pb-2">
      <div className="flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-[12px] text-red-300">
        <AlertTriangle size={14} className="mt-0.5 shrink-0" />
        <div className="min-w-0 flex-1">
          <p className="select-text break-words">{error}</p>
          {engineRunning !== true && (
            <p className="mt-0.5 text-red-300/70">
              The engine may not be running — check the Models tab.
            </p>
          )}
        </div>
        <button
          onClick={() => clearError(conversationId)}
          className="rounded p-0.5 hover:bg-red-500/20"
        >
          <X size={13} />
        </button>
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
  const busy = streamingId !== undefined

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
          className="min-h-0 flex-1"
          data={messages}
          computeItemKey={(_, m: ChatMessage) => m.id}
          initialTopMostItemIndex={messages.length - 1}
          followOutput={(isAtBottom) => (isAtBottom ? 'auto' : false)}
          components={virtuosoComponents}
          itemContent={(_, message: ChatMessage) => (
            <div className="mx-auto w-full max-w-3xl px-6">
              <MessageBubble
                message={message}
                streaming={message.id === streamingId}
                busy={busy}
              />
            </div>
          )}
        />
      )}
      {lastError && <ErrorBanner conversationId={conversationId} error={lastError} />}
    </div>
  )
}
