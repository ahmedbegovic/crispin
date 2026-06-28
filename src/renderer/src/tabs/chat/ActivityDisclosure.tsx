import type { ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'
import {
  Brain,
  ChevronRight,
  FileText,
  Globe,
  Image as ImageIcon,
  Loader2,
  Package,
  Search,
  Wrench
} from 'lucide-react'
import { useChatStore } from '@/stores/chat'
import type { MessagePart } from '@shared/types'
import { segmentThought } from './thoughtSteps'

export type ProcessPart = Extract<MessagePart, { type: 'thought' | 'tool_call' | 'tool_result' }>
export type ToolCallPart = Extract<MessagePart, { type: 'tool_call' }>
export type ToolResultPart = Extract<MessagePart, { type: 'tool_result' }>

export function isProcessPart(p: MessagePart): p is ProcessPart {
  return p.type === 'thought' || p.type === 'tool_call' || p.type === 'tool_result'
}

interface IndexedPart {
  part: ProcessPart
  /** Original index in message.parts — stable React key. */
  i: number
}

/** Tool calls that count as a "web action" for the icon/label/summary. */
const WEB_TOOLS = new Set(['web_search', 'web_visit', 'web_lookup'])

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

// --- humanizing a tool call into a readable activity line -------------------------

interface Action {
  icon: LucideIcon
  /** Leading word(s), e.g. "Searching" / "Read". */
  verb: string
  /** The object of the action, e.g. the query or "gsmarena.com — iPhone 17". */
  detail: string
}

const PROVIDER_SOURCE: Record<string, string> = {
  pypi: 'PyPI',
  npm: 'npm',
  github_release: 'GitHub',
  arxiv: 'arXiv'
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

function parseArgs(raw: string): Record<string, unknown> {
  try {
    const v = JSON.parse(raw)
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/** First "[n] Title" line of a tool result carries the page/source title. */
function resultTitle(result: ToolResultPart | undefined): string | null {
  if (!result) return null
  const m = /^\s*\[\d+\]\s+(.+)$/m.exec(result.result)
  return m ? m[1].trim() : null
}

/** "mcp__github__search_issues" -> "github · search_issues". */
function friendlyName(name: string): string {
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name)
  return mcp ? `${mcp[1]} · ${mcp[2]}` : name
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '')

/** Turn a tool call into a one-line, human-readable activity entry. */
function describeAction(name: string, args: string, result: ToolResultPart | undefined, running: boolean): Action {
  const a = parseArgs(args)
  switch (name) {
    case 'web_search':
      return { icon: Search, verb: running ? 'Searching' : 'Searched', detail: str(a.query) || 'the web' }
    case 'web_visit': {
      const host = a.url ? hostOf(str(a.url)) : ''
      const title = resultTitle(result)
      return {
        icon: Globe,
        verb: running ? 'Opening' : 'Read',
        detail: [host, title].filter(Boolean).join(' — ') || 'a page'
      }
    }
    case 'web_lookup': {
      const nm = str(a.name) || [str(a.owner), str(a.repo)].filter(Boolean).join('/')
      const src = PROVIDER_SOURCE[str(a.kind)] ?? ''
      return {
        icon: Package,
        verb: running ? 'Looking up' : 'Looked up',
        detail: [nm, src && `on ${src}`].filter(Boolean).join(' ') || 'a source'
      }
    }
    case 'image_search':
      return { icon: ImageIcon, verb: running ? 'Finding images' : 'Found images', detail: str(a.query) }
    case 'rag_search':
      return { icon: FileText, verb: running ? 'Searching documents' : 'Searched documents', detail: str(a.query) }
    default:
      return { icon: Wrench, verb: running ? 'Running' : 'Ran', detail: friendlyName(name) }
  }
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
      // A structured lookup (web_lookup) returns one source, not a page read —
      // count it as a search so a hit reads "Searched the web", not "Used 1 tool".
      if (part.name === 'web_search' || part.name === 'web_lookup') searches++
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
 * web searches, page reads, and reasoning — as a readable activity narrative
 * ("Searching … · Read gsmarena.com — … · Thinking …") rather than raw tool
 * cards. Auto-expands while the work is happening (so progress is visible live)
 * and collapses to a single summary line once the answer starts; a manual toggle
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

  const hasWeb = parts.some(({ part }) => part.type === 'tool_call' && WEB_TOOLS.has(part.name))
  const hasTool = parts.some(({ part }) => part.type === 'tool_call')
  const Icon = hasWeb ? Globe : hasTool ? Wrench : Brain
  const working = streaming && !hasAnswer

  // Live status names what's happening NOW (the last tool_call with no result
  // yet), with its detail — so the header reads "Searching latest flagship
  // phones", Claude-style, rather than a generic "Searching the web…".
  const inFlight = working
    ? [...parts]
        .reverse()
        .map((p) => p.part)
        .find(
          (p): p is ToolCallPart => p.type === 'tool_call' && !resultFor(p.id)
        )
    : undefined
  let label: string
  if (working) {
    if (inFlight) {
      const a = describeAction(inFlight.name, inFlight.args, undefined, true)
      label = a.detail ? `${a.verb} ${a.detail}` : a.verb
    } else {
      label = 'Thinking…'
    }
  } else {
    label = summarize(parts, (id) => {
      const r = resultFor(id)
      return !!r && !r.result.startsWith('Error:')
    })
  }

  return (
    <div className="my-2 overflow-hidden rounded-lg border border-zinc-800/80 bg-zinc-900/40">
      <button
        onClick={() => setActivityOpen(messageId, !open)}
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 px-3 py-1.5 text-left text-[11.5px] text-zinc-500 hover:text-zinc-300"
      >
        {working ? (
          <Loader2 size={12} className="shrink-0 animate-spin text-zinc-400" />
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
        <div className="space-y-1.5 border-t border-zinc-800/80 px-3 py-2">
          <ActivityTimeline parts={parts} working={working} resultFor={resultFor} hasCall={hasCall} />
        </div>
      )}
    </div>
  )
}

/**
 * The expanded activity as a plain temporal narrative: each reasoning step and
 * tool call is one readable line (a muted icon + a sentence), no raw JSON and no
 * coloured rail. Reasoning steps are segmented render-side from the existing
 * 'thought' strings; parts are already in temporal order, so think→tool→think
 * interleaves for free.
 */
function ActivityTimeline({
  parts,
  working,
  resultFor,
  hasCall
}: {
  parts: IndexedPart[]
  working: boolean
  resultFor: (id: string) => ToolResultPart | undefined
  hasCall: (toolCallId: string) => boolean
}) {
  const rows: ReactNode[] = []

  const thoughtRow = (key: string, heading: string | null, body: string): ReactNode => (
    <div key={key} className="flex items-start gap-2">
      <Brain size={13} className="mt-0.5 shrink-0 text-zinc-600" />
      <div className="min-w-0 flex-1">
        <div className="text-[12px] text-zinc-400">{heading ?? 'Thinking'}</div>
        {body && (
          <div className="mt-0.5 max-h-52 select-text overflow-y-auto whitespace-pre-wrap break-words text-[12px] leading-relaxed text-zinc-500">
            {body}
          </div>
        )}
      </div>
    </div>
  )

  const actionRow = (
    key: string,
    a: Action,
    running: boolean,
    failed: boolean
  ): ReactNode => (
    <div key={key} className="flex items-center gap-2 text-[12px]">
      {running ? (
        <Loader2 size={13} className="shrink-0 animate-spin text-zinc-400" />
      ) : (
        <a.icon size={13} className={`shrink-0 ${failed ? 'text-red-400/70' : 'text-zinc-600'}`} />
      )}
      <div className="min-w-0 truncate" title={a.detail}>
        <span className="text-zinc-300">{a.verb}</span>
        {a.detail && <span className="text-zinc-500"> {a.detail}</span>}
        {failed && <span className="text-red-400/70"> · failed</span>}
      </div>
    </div>
  )

  for (const { part, i } of parts) {
    if (part.type === 'thought') {
      segmentThought(part.text).forEach((s, si) => rows.push(thoughtRow(`t${i}-${si}`, s.heading, s.body)))
    } else if (part.type === 'tool_call') {
      const r = resultFor(part.id)
      const running = working && !r
      const failed = !!r && r.result.startsWith('Error:')
      rows.push(actionRow(`c${i}`, describeAction(part.name, part.args, r, running), running, failed))
    } else if (!hasCall(part.toolCallId)) {
      // Orphan tool_result (its call never landed) — describe from the result.
      const failed = part.result.startsWith('Error:')
      rows.push(actionRow(`r${i}`, describeAction(part.name, '{}', part, false), false, failed))
    }
  }

  if (rows.length === 0) return null
  return <>{rows}</>
}
