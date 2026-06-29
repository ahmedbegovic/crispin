import { useMemo, useState } from 'react'
import {
  Check,
  ChevronDown,
  Copy,
  FileText,
  Image as ImageIcon,
  Loader2,
  Pencil,
  RefreshCw,
  Shrink,
  Trash2
} from 'lucide-react'
import {
  TIER_LABELS,
  TIER_ORDER,
  modelDisplayName,
  selectionFamilyOf,
  tierOfRepo
} from '@shared/model-tiers'
import type { ChatMessage, MessagePart, SourceRef, Tier } from '@shared/types'
import { useChatStore, type RegenerateOptions } from '@/stores/chat'
import DropdownMenu, { type MenuItem } from '@/components/DropdownMenu'
import { formatDuration, formatTokensPerSec } from '@/lib/format'
import { pushToast, toastError } from '@/stores/toasts'
import MarkdownPart from './MarkdownPart'
import ActivityDisclosure, {
  isProcessPart,
  type ProcessPart,
  type ToolResultPart
} from './ActivityDisclosure'
import SourcesStrip from './SourcesStrip'
import BranchSwitcher from './BranchSwitcher'
import ConfirmDialog from '@/components/ConfirmDialog'
import { basename, fileUrl } from './attachments'
import { chatRunPhase, chatRunPhaseLabel } from './runStatus'

/** Delete this message + its descendant subtree, behind a confirm. */
function DeleteMessageButton({ message, disabled }: { message: ChatMessage; disabled: boolean }) {
  const deleteMessage = useChatStore((s) => s.deleteMessage)
  const [confirm, setConfirm] = useState(false)
  const [pending, setPending] = useState(false)
  const doDelete = (): void => {
    setConfirm(false)
    setPending(true)
    void deleteMessage(message.conversationId, message.id)
      .catch(toastError)
      .finally(() => setPending(false))
  }
  return (
    <>
      <button
        onClick={() => setConfirm(true)}
        disabled={disabled || pending}
        title="Delete message"
        aria-label="Delete message"
        className="rounded p-0.5 text-zinc-500 hover:bg-zinc-800 hover:text-red-400 disabled:opacity-30"
      >
        <Trash2 size={12} />
      </button>
      <ConfirmDialog
        open={confirm}
        title="Delete message?"
        body="This message and every reply below it will be permanently removed."
        danger
        confirmLabel="Delete"
        onConfirm={doDelete}
        onCancel={() => setConfirm(false)}
      />
    </>
  )
}

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

/** The synthetic Compact summary renders as a divider, not a user bubble. */
function CompactionDivider({ summary }: { summary: string }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="my-4 w-full">
      <div className="flex items-center gap-2 text-[11px] text-zinc-500">
        <div className="h-px flex-1 bg-zinc-800" />
        <button
          onClick={() => setOpen((o) => !o)}
          className="flex items-center gap-1 rounded px-1.5 py-0.5 hover:text-zinc-300"
        >
          <Shrink size={11} />
          Compacted — earlier turns summarized
          <ChevronDown size={11} className={`transition-transform ${open ? 'rotate-180' : ''}`} />
        </button>
        <div className="h-px flex-1 bg-zinc-800" />
      </div>
      {open && (
        <div className="mx-auto mt-2 max-w-[80%] select-text whitespace-pre-wrap break-words rounded-lg border border-zinc-800 bg-zinc-900/40 px-3 py-2 text-[12px] leading-relaxed text-zinc-400">
          {summary}
        </div>
      )}
    </div>
  )
}

function UserMessage({ message, streaming }: { message: ChatMessage; streaming: boolean }) {
  const editResend = useChatStore((s) => s.editResend)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [copied, setCopied] = useState(false)
  const copy = (): void => {
    void navigator.clipboard.writeText(copyText(message)).catch(toastError)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  // A compaction summary is a synthetic user message — show it as a divider.
  const compaction = message.parts.find(
    (p): p is Extract<MessagePart, { type: 'compaction' }> => p.type === 'compaction'
  )
  if (compaction) {
    return <CompactionDivider summary={compaction.text.trim()} />
  }

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
    <div className="group flex flex-col items-end pb-2 pt-6">
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
          <div className="max-w-[80%] select-text whitespace-pre-wrap break-words rounded-2xl rounded-br-md border border-white/[0.05] bg-[#26262c] px-3.5 py-2 text-[length:var(--chat-fs,13.5px)] leading-[var(--chat-lh,1.7)] text-zinc-100">
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
          <div className="mt-1 flex h-5 items-center gap-1.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
            <BranchSwitcher message={message} disabled={streaming} />
            <button
              onClick={copy}
              title="Copy message"
              aria-label="Copy message"
              className="rounded p-0.5 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
            >
              {copied ? <Check size={12} className="text-emerald-400" /> : <Copy size={12} />}
            </button>
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
            <DeleteMessageButton message={message} disabled={streaming} />
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
  const stopped = useChatStore((s) => s.stoppedIds[message.id])
  const [copied, setCopied] = useState(false)

  // Stable [n] → source map for inline citations; empty until the sources part
  // lands, so MarkdownPart's memo isn't churned during streaming.
  const sourcesPart = message.parts.find(
    (p): p is Extract<MessagePart, { type: 'sources' }> => p.type === 'sources'
  )
  const sourcesMap = useMemo(() => {
    const map: Record<number, SourceRef> = {}
    for (const s of sourcesPart?.sources ?? []) map[s.id] = s
    return map
  }, [sourcesPart])

  const copy = (): void => {
    void navigator.clipboard.writeText(copyText(message)).catch(toastError)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  // Per-message generation stats (persisted on the message — survive reload +
  // branch switch). tok/s = tokensOut / decode wall-time.
  const tps =
    message.genMs !== null && message.tokensOut !== null
      ? formatTokensPerSec(message.tokensOut, message.genMs)
      : null
  const stats = [
    message.tokensOut !== null ? `${message.tokensOut} tok` : null,
    tps,
    message.ttftMs !== null ? `TTFT ${formatDuration(message.ttftMs)}` : null
  ]
    .filter(Boolean)
    .join(' · ')

  const doRegen = (options?: RegenerateOptions): void => {
    void regenerate(message.conversationId, message.id, options).catch(toastError)
  }
  // Escalate = one step up from the tier that generated THIS message, staying in
  // the same family so "Try Ultra" on a Qwen reply gives the Qwen Ultra.
  const curTier = message.modelId ? tierOfRepo(message.modelId) : null
  const curFamily = message.modelId ? (selectionFamilyOf(message.modelId) ?? undefined) : undefined
  const curIdx = curTier ? TIER_ORDER.indexOf(curTier) : -1
  const nextTier: Tier | undefined =
    curIdx >= 0 && curIdx < TIER_ORDER.length - 1 ? TIER_ORDER[curIdx + 1] : undefined
  const regenItems: MenuItem[] = [
    nextTier
      ? {
          label: `Try ${TIER_LABELS[nextTier]}`,
          hint: 'escalate',
          onSelect: () => doRegen({ tier: nextTier, family: curFamily })
        }
      : { label: 'Already at top tier', disabled: true, onSelect: () => {} },
    { label: 'Shorter', onSelect: () => doRegen({ lengthHint: 'shorter' }) },
    { label: 'Longer', onSelect: () => doRegen({ lengthHint: 'longer' }) },
    { label: 'More formal', onSelect: () => doRegen({ toneHint: 'formal' }) },
    { label: 'More casual', onSelect: () => doRegen({ toneHint: 'casual' }) }
  ]

  const hasCall = (toolCallId: string): boolean =>
    message.parts.some((p) => p.type === 'tool_call' && p.id === toolCallId)
  const resultFor = (id: string): ToolResultPart | undefined =>
    message.parts.find(
      (p): p is ToolResultPart => p.type === 'tool_result' && p.toolCallId === id
    )

  // Fold the process (reasoning + web searches/reads) into one activity bubble;
  // the answer (text/sources/images) renders below it.
  const processParts: { part: ProcessPart; i: number }[] = []
  const bodyParts: { part: MessagePart; i: number }[] = []
  message.parts.forEach((part, i) => {
    if (isProcessPart(part)) processParts.push({ part, i })
    else bodyParts.push({ part, i })
  })
  const hasAnswer = bodyParts.some((x) => x.part.type === 'text' && x.part.text.trim().length > 0)
  // Show the bubble for any tool use or non-empty reasoning; while streaming,
  // show it the moment a process part exists (live "Thinking…"). A settled
  // message whose only process is a whitespace thought gets no bubble.
  const showActivity =
    processParts.some((x) => x.part.type !== 'thought' || x.part.text.trim().length > 0) ||
    (streaming && processParts.length > 0)
  const runPhase = chatRunPhase(streaming ? message.id : undefined, message)

  return (
    // Reserved left indent (pl-4 always present, so settling the stream never
    // shifts content). No coloured spine — liveness is shown by the activity
    // narrative and the caret, not a green bar down the message.
    <div className="group border-l-2 border-transparent pb-4 pl-4 pt-1">
      {runPhase === 'waitingFirstToken' && (
        <div className="flex items-center gap-2 py-1 text-[12px] text-zinc-500">
          <Loader2 size={13} className="animate-spin" />
          {chatRunPhaseLabel(runPhase)}
        </div>
      )}
      {showActivity && (
        <ActivityDisclosure
          messageId={message.id}
          parts={processParts}
          streaming={streaming}
          hasAnswer={hasAnswer}
          resultFor={resultFor}
          hasCall={hasCall}
        />
      )}
      {bodyParts.map(({ part, i }) => {
        switch (part.type) {
          case 'text':
            return <MarkdownPart key={i} text={part.text} sources={sourcesMap} />
          case 'sources':
            return <SourcesStrip key={i} sources={part.sources} />
          case 'image':
            return <ImageThumb key={i} path={part.path} />
          default:
            return null
        }
      })}
      {/* Live "still generating" tick — a sibling AFTER the markdown (never inside
          it, which would break MarkdownPart's per-delta memo), so it sits just
          below the streamed text as a liveness cue rather than inline at the tail. */}
      {streaming && runPhase === 'generating' && hasAnswer && (
        <span
          aria-hidden
          className="caret-blink mt-0.5 inline-block h-4 w-[2px] rounded-full bg-zinc-400/80"
        />
      )}
      <div className="mt-1 flex h-5 items-center gap-1.5">
        {streaming ? (
          // Mid-stream: spinner first, then copy-so-far once there is content.
          <div className="flex items-center gap-1.5 text-zinc-600">
            <Loader2 size={12} className="animate-spin" />
            {runPhase === 'generating' && (
              <button
                onClick={copy}
                title="Copy response so far"
                aria-label="Copy response so far"
                className="rounded p-0.5 hover:bg-zinc-800 hover:text-zinc-200"
              >
                {copied ? <Check size={12} className="text-emerald-400" /> : <Copy size={12} />}
              </button>
            )}
          </div>
        ) : (
          <div className="flex items-center gap-1.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
            <button
              onClick={copy}
              title="Copy response"
              aria-label="Copy response"
              className="rounded p-0.5 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
            >
              {copied ? <Check size={12} className="text-emerald-400" /> : <Copy size={12} />}
            </button>
            <button
              onClick={() => doRegen()}
              disabled={busy}
              title="Regenerate"
              aria-label="Regenerate response"
              className="rounded p-0.5 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200 disabled:opacity-30"
            >
              <RefreshCw size={12} />
            </button>
            <DropdownMenu
              items={regenItems}
              trigger={(open, toggle) => (
                <button
                  onClick={toggle}
                  disabled={busy}
                  title="Regenerate options"
                  aria-label="Regenerate options"
                  aria-haspopup="menu"
                  aria-expanded={open}
                  className={`-ml-1 rounded p-0.5 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200 disabled:opacity-30 ${
                    open ? 'bg-zinc-800 text-zinc-200' : ''
                  }`}
                >
                  <ChevronDown size={11} />
                </button>
              )}
            />
            <BranchSwitcher message={message} disabled={busy} />
            {message.modelId && (
              <span className="text-[10.5px] text-zinc-600" title={message.modelId}>
                {modelDisplayName(message.modelId)}
              </span>
            )}
            {stats && <span className="text-[10.5px] tabular-nums text-zinc-600">{stats}</span>}
            {stopped && <span className="text-[10.5px] text-amber-500/70">· stopped</span>}
            <DeleteMessageButton message={message} disabled={busy} />
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
