import { useState } from 'react'
import { Check, Copy, FileText, Image as ImageIcon, Loader2, Pencil, RefreshCw } from 'lucide-react'
import type { ChatMessage, MessagePart } from '@shared/types'
import { useChatStore } from '@/stores/chat'
import { pushToast, toastError } from '@/stores/toasts'
import MarkdownPart from './MarkdownPart'
import ThoughtBlock from './ThoughtBlock'
import ToolCallCard, { type ToolResultPart } from './ToolCallCard'
import SourcesStrip from './SourcesStrip'
import BranchSwitcher from './BranchSwitcher'
import { basename, fileUrl } from './attachments'

function ImageThumb({ path }: { path: string }) {
  // file:// is blocked by webSecurity while the renderer runs off the dev
  // server; fall back to a labeled chip instead of a broken image.
  const [failed, setFailed] = useState(false)
  if (failed)
    return (
      <span className="flex items-center gap-1.5 rounded-lg border border-zinc-800 bg-zinc-900/60 px-2 py-1 text-[11px] text-zinc-400">
        <ImageIcon size={12} className="text-zinc-500" />
        <span className="max-w-44 truncate">{basename(path)}</span>
      </span>
    )
  return (
    <img
      src={fileUrl(path)}
      onError={() => setFailed(true)}
      alt={basename(path)}
      className="h-24 max-w-44 rounded-lg border border-zinc-800 object-cover"
    />
  )
}

/** Non-leading text parts of a user message are extracted document contents. */
function DocumentChip({ text }: { text: string }) {
  const label = text.split('\n', 1)[0].slice(0, 80) || 'Attached document'
  return (
    <details className="max-w-full rounded-lg border border-zinc-800 bg-zinc-900/60">
      <summary className="flex cursor-pointer list-none items-center gap-1.5 px-2 py-1 text-[11px] text-zinc-400 hover:text-zinc-200 [&::-webkit-details-marker]:hidden">
        <FileText size={12} className="shrink-0 text-zinc-500" />
        <span className="truncate">{label}</span>
      </summary>
      <pre className="max-h-48 select-text overflow-auto whitespace-pre-wrap border-t border-zinc-800 px-2 py-1.5 text-[11px] leading-relaxed text-zinc-500">
        {text}
      </pre>
    </details>
  )
}

function copyText(message: ChatMessage): string {
  return message.parts
    .filter((p): p is Extract<MessagePart, { type: 'text' }> => p.type === 'text')
    .map((p) => p.text)
    .join('\n\n')
}

function UserMessage({ message, streaming }: { message: ChatMessage; streaming: boolean }) {
  const editResend = useChatStore((s) => s.editResend)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')

  const textParts = message.parts.filter(
    (p): p is Extract<MessagePart, { type: 'text' }> => p.type === 'text'
  )
  const text = textParts[0]?.text ?? ''
  const docParts = textParts.slice(1)
  const images = message.parts.filter(
    (p): p is Extract<MessagePart, { type: 'image' }> => p.type === 'image'
  )

  const saveEdit = (): void => {
    // An already-open edit box outlives the busy gate on the pencil button — a
    // generation may have started since. Keep the box (and draft) open.
    if (streaming) {
      pushToast('warn', 'A generation is already running in this conversation.')
      return
    }
    const trimmed = draft.trim()
    setEditing(false)
    if (!trimmed || trimmed === text) return
    void editResend(message.conversationId, message.id, trimmed).catch(toastError)
  }

  return (
    <div className="group flex flex-col items-end py-2">
      {editing ? (
        <div className="w-full max-w-[80%]">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault()
                saveEdit()
              }
              if (e.key === 'Escape') setEditing(false)
            }}
            autoFocus
            rows={Math.min(8, Math.max(2, draft.split('\n').length))}
            className="w-full resize-none rounded-xl border border-zinc-700 bg-zinc-900 px-3 py-2 text-[13px] text-zinc-200 outline-none focus:border-zinc-500"
          />
          <div className="mt-1 flex justify-end gap-2 text-[11px]">
            <button
              onClick={() => setEditing(false)}
              className="rounded px-2 py-0.5 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
            >
              Cancel
            </button>
            <button
              onClick={saveEdit}
              className="rounded bg-emerald-600 px-2 py-0.5 font-medium text-white hover:bg-emerald-500"
            >
              Send
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className="max-w-[80%] select-text whitespace-pre-wrap rounded-2xl rounded-br-md bg-zinc-800 px-3.5 py-2 text-[13.5px] leading-relaxed text-zinc-100">
            {text}
          </div>
          {images.length > 0 && (
            <div className="mt-1.5 flex max-w-[80%] flex-wrap justify-end gap-1.5">
              {images.map((part, i) => (
                <ImageThumb key={i} path={part.path} />
              ))}
            </div>
          )}
          {docParts.length > 0 && (
            <div className="mt-1.5 flex max-w-[80%] flex-col items-end gap-1.5">
              {docParts.map((part, i) => (
                <DocumentChip key={i} text={part.text} />
              ))}
            </div>
          )}
          <div className="mt-1 flex h-5 items-center gap-1.5 opacity-0 transition-opacity group-hover:opacity-100">
            <BranchSwitcher message={message} disabled={streaming} />
            <button
              onClick={() => {
                setDraft(text)
                setEditing(true)
              }}
              disabled={streaming}
              title="Edit & resend"
              className="rounded p-0.5 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200 disabled:opacity-30"
            >
              <Pencil size={12} />
            </button>
          </div>
        </>
      )}
    </div>
  )
}

function AssistantMessage({
  message,
  streaming,
  busy
}: {
  message: ChatMessage
  streaming: boolean
  busy: boolean
}) {
  const regenerate = useChatStore((s) => s.regenerate)
  const [copied, setCopied] = useState(false)

  const copy = (): void => {
    void navigator.clipboard.writeText(copyText(message)).catch(toastError)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  const hasCall = (toolCallId: string): boolean =>
    message.parts.some((p) => p.type === 'tool_call' && p.id === toolCallId)
  const resultFor = (id: string): ToolResultPart | undefined =>
    message.parts.find(
      (p): p is ToolResultPart => p.type === 'tool_result' && p.toolCallId === id
    )

  const lastIndex = message.parts.length - 1
  return (
    <div className="group py-2">
      {message.parts.length === 0 && streaming && (
        <div className="flex items-center gap-2 py-1 text-[12px] text-zinc-500">
          <Loader2 size={13} className="animate-spin" />
          Generating…
        </div>
      )}
      {message.parts.map((part, i) => {
        switch (part.type) {
          case 'text':
            return <MarkdownPart key={i} text={part.text} />
          case 'thought':
            return <ThoughtBlock key={i} text={part.text} active={streaming && i === lastIndex} />
          case 'tool_call':
            return <ToolCallCard key={part.id} call={part} result={resultFor(part.id)} />
          case 'tool_result':
            // Rendered with its paired call; orphans (call lost mid-persist) standalone.
            return hasCall(part.toolCallId) ? null : <ToolCallCard key={i} result={part} />
          case 'sources':
            return <SourcesStrip key={i} sources={part.sources} />
          case 'image':
            return <ImageThumb key={i} path={part.path} />
          default:
            return null
        }
      })}
      <div className="mt-1 flex h-5 items-center gap-1.5">
        {streaming ? (
          <Loader2 size={12} className="animate-spin text-zinc-600" />
        ) : (
          <div className="flex items-center gap-1.5 opacity-0 transition-opacity group-hover:opacity-100">
            <button
              onClick={copy}
              title="Copy response"
              className="rounded p-0.5 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
            >
              {copied ? <Check size={12} className="text-emerald-400" /> : <Copy size={12} />}
            </button>
            <button
              onClick={() =>
                void regenerate(message.conversationId, message.id).catch(toastError)
              }
              disabled={busy}
              title="Regenerate"
              className="rounded p-0.5 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200 disabled:opacity-30"
            >
              <RefreshCw size={12} />
            </button>
            <BranchSwitcher message={message} disabled={busy} />
            {message.modelId && (
              <span className="text-[10.5px] text-zinc-600" title={message.modelId}>
                {message.modelId.split('/').pop()}
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

interface Props {
  message: ChatMessage
  /** True while this exact message is receiving stream deltas. */
  streaming: boolean
  /** True while any generation runs in this conversation (gates branching/edit). */
  busy: boolean
}

export default function MessageBubble({ message, streaming, busy }: Props) {
  if (message.role === 'user') return <UserMessage message={message} streaming={busy} />
  if (message.role === 'assistant')
    return <AssistantMessage message={message} streaming={streaming} busy={busy} />
  return null // system/tool rows are folded into assistant parts
}
