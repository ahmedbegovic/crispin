import { AlertTriangle, Check, ChevronDown, Loader2, Wrench } from 'lucide-react'
import type { MessagePart } from '@shared/types'
import { useChatStore } from '@/stores/chat'

export type ToolCallPart = Extract<MessagePart, { type: 'tool_call' }>
export type ToolResultPart = Extract<MessagePart, { type: 'tool_result' }>

const RESULT_RENDER_LIMIT = 6000

interface Props {
  call?: ToolCallPart
  result?: ToolResultPart
}

function prettyArgs(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2)
  } catch {
    return raw
  }
}

/** "mcp__github__search_issues" -> "github · search_issues". */
function friendlyName(name: string): string {
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name)
  return mcp ? `${mcp[1]} · ${mcp[2]}` : name
}

/** A tool_call paired with its tool_result; spinner phase comes from chat.toolEvent. */
export default function ToolCallCard({ call, result }: Props) {
  const toolCallId = call?.id || result?.toolCallId || ''
  // Guard the empty-id case so a card with no id doesn't subscribe to a shared
  // toolPhases[''] bucket (would mirror another card's spinner/state).
  const phase = useChatStore((s) => (toolCallId ? s.toolPhases[toolCallId] : undefined))
  const name = call?.name ?? result?.name ?? 'tool'

  const failed = phase?.phase === 'error'
  const done = result !== undefined || phase?.phase === 'result'
  const status = failed ? (
    <AlertTriangle size={12} className="text-red-400" />
  ) : done ? (
    <Check size={12} className="text-emerald-400" />
  ) : (
    <Loader2 size={12} className="animate-spin text-amber-400" />
  )

  return (
    <details className="group/tool my-2 rounded-lg border border-zinc-800/80 bg-zinc-900/40">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-1.5 [&::-webkit-details-marker]:hidden">
        <Wrench size={12} className="shrink-0 text-zinc-500" />
        <span className="truncate font-mono text-[11.5px] text-zinc-300">
          {friendlyName(name)}
        </span>
        {status}
        {!done && !failed && phase?.detail && (
          <span className="truncate text-[11px] text-zinc-600">{phase.detail}</span>
        )}
        <ChevronDown
          size={12}
          className="ml-auto shrink-0 text-zinc-600 transition-transform group-open/tool:rotate-180"
        />
      </summary>
      <div className="space-y-2 border-t border-zinc-800/80 px-3 py-2">
        {call && (
          <div>
            <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-zinc-600">
              Arguments
            </div>
            <pre className="select-text overflow-x-auto whitespace-pre-wrap rounded bg-zinc-950/60 p-2 font-mono text-[11px] leading-relaxed text-zinc-400">
              {prettyArgs(call.args)}
            </pre>
          </div>
        )}
        {failed && phase?.detail && (
          <p className="select-text text-[11.5px] text-red-400">{phase.detail}</p>
        )}
        {result && (
          <div>
            <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-zinc-600">
              Result
            </div>
            <pre className="max-h-64 select-text overflow-auto whitespace-pre-wrap rounded bg-zinc-950/60 p-2 font-mono text-[11px] leading-relaxed text-zinc-400">
              {result.result.length > RESULT_RENDER_LIMIT
                ? `${result.result.slice(0, RESULT_RENDER_LIMIT)}\n… (truncated)`
                : result.result}
            </pre>
          </div>
        )}
      </div>
    </details>
  )
}
