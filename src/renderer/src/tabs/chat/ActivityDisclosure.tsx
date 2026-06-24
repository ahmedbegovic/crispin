import { Brain, ChevronRight, Globe, Loader2, Wrench } from 'lucide-react'
import { useChatStore } from '@/stores/chat'
import type { MessagePart } from '@shared/types'
import ToolCallCard, { type ToolResultPart } from './ToolCallCard'

export type ProcessPart = Extract<MessagePart, { type: 'thought' | 'tool_call' | 'tool_result' }>

export function isProcessPart(p: MessagePart): p is ProcessPart {
  return p.type === 'thought' || p.type === 'tool_call' || p.type === 'tool_result'
}

interface IndexedPart {
  part: ProcessPart
  /** Original index in message.parts — stable React key. */
  i: number
}

interface Props {
  /** Owning assistant message id — keys the persisted manual expand state. */
  messageId: string
  parts: IndexedPart[]
  /** True while this message is receiving deltas. */
  streaming: boolean
  /** True once visible answer text has started — drives the auto-collapse. */
  hasAnswer: boolean
  resultFor: (id: string) => ToolResultPart | undefined
  hasCall: (toolCallId: string) => boolean
}

/**
 * Settled one-line summary, e.g. "Searched the web · read 4 pages". `succeeded`
 * gates the page count to visits that actually returned content — a failed or
 * interrupted fetch shouldn't inflate "read N pages".
 */
function summarize(parts: IndexedPart[], succeeded: (id: string) => boolean): string {
  let searches = 0
  let visits = 0
  let other = 0
  let thinking = false
  for (const { part } of parts) {
    if (part.type === 'thought') {
      if (part.text.trim()) thinking = true
    } else if (part.type === 'tool_call') {
      if (part.name === 'web_search') searches++
      else if (part.name === 'web_visit') {
        if (succeeded(part.id)) visits++
      } else other++
    }
  }
  const segs: string[] = []
  if (searches > 0 || visits > 0) {
    segs.push('Searched the web')
    if (visits > 0) segs.push(`read ${visits} page${visits === 1 ? '' : 's'}`)
  } else if (other > 0) {
    segs.push(`Used ${other} tool${other === 1 ? '' : 's'}`)
  }
  if (thinking && segs.length === 0) segs.push('Thought it through')
  return segs.length > 0 ? segs.join(' · ') : 'Worked on it'
}

/**
 * One collapsible bubble holding everything the model did before answering —
 * web searches, page reads, and reasoning — instead of a tall stack of cards.
 * Auto-expands while the work is happening (so progress is visible live) and
 * collapses to a single summary line once the answer starts; a manual toggle
 * sticks and is never overridden afterward.
 */
export default function ActivityDisclosure({
  messageId,
  parts,
  streaming,
  hasAnswer,
  resultFor,
  hasCall
}: Props) {
  const storedOpen = useChatStore((s) => s.activityOpen[messageId])
  const setActivityOpen = useChatStore((s) => s.setActivityOpen)
  const auto = streaming && !hasAnswer
  // A manual toggle is persisted in the store so it survives the Virtuoso
  // unmount when this message scrolls out and back; until the user touches it,
  // follow the auto behavior (expanded while working, collapsed once answered).
  const open = storedOpen ?? auto

  const hasWeb = parts.some(
    ({ part }) =>
      part.type === 'tool_call' && (part.name === 'web_search' || part.name === 'web_visit')
  )
  const hasTool = parts.some(({ part }) => part.type === 'tool_call')
  const Icon = hasWeb ? Globe : hasTool ? Wrench : Brain
  const working = streaming && !hasAnswer
  const succeeded = (id: string): boolean => {
    const r = resultFor(id)
    return !!r && !r.result.startsWith('Error:')
  }
  // Live status names the tool actually running now (last tool_call with no
  // result yet), so the label doesn't get stuck on "Searching the web…" while
  // the model spends a while reading/reasoning after the search finished.
  const inFlightCall = working
    ? [...parts]
        .reverse()
        .map((p) => p.part)
        .find(
          (p): p is Extract<ProcessPart, { type: 'tool_call' }> =>
            p.type === 'tool_call' && !resultFor(p.id)
        )
    : undefined
  const label = working
    ? inFlightCall
      ? inFlightCall.name === 'web_search' || inFlightCall.name === 'web_visit'
        ? 'Searching the web…'
        : `Running ${inFlightCall.name}…`
      : 'Thinking…'
    : summarize(parts, succeeded)

  return (
    <div className="my-2 overflow-hidden rounded-lg border border-zinc-800/80 bg-zinc-900/40">
      <button
        onClick={() => setActivityOpen(messageId, !open)}
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 px-3 py-1.5 text-left text-[11.5px] text-zinc-500 hover:text-zinc-300"
      >
        {working ? (
          <Loader2 size={12} className="shrink-0 animate-spin text-amber-400" />
        ) : (
          <Icon size={12} className="shrink-0" />
        )}
        <span className="truncate">{label}</span>
        <ChevronRight
          size={12}
          className={`ml-auto shrink-0 text-zinc-600 transition-transform ${open ? 'rotate-90' : ''}`}
        />
      </button>
      {open && (
        <div className="space-y-1 border-t border-zinc-800/80 px-2 py-1.5">
          {parts.map(({ part, i }) => {
            if (part.type === 'thought') {
              if (!part.text.trim()) return null
              return (
                <div
                  key={i}
                  className="max-h-60 select-text overflow-y-auto whitespace-pre-wrap break-words px-1 py-1 text-[12px] leading-relaxed text-zinc-500"
                >
                  {part.text}
                </div>
              )
            }
            if (part.type === 'tool_call') {
              // Key by the stable original index, not part.id (the engine's
              // call id, which z.string() permits to be '' or collide).
              return <ToolCallCard key={i} call={part} result={resultFor(part.id)} />
            }
            // tool_result: render only orphans (the paired call renders it otherwise).
            return hasCall(part.toolCallId) ? null : <ToolCallCard key={i} result={part} />
          })}
        </div>
      )}
    </div>
  )
}
