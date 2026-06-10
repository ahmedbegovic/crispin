import { useState } from 'react'
import { ShieldQuestion } from 'lucide-react'
import {
  asRecord,
  asString,
  permissionIdOf,
  useAgentStore,
  type PermissionReplyKind
} from '@/stores/agent'
import { toastError } from '@/stores/toasts'

const RENDER_LIMIT = 6000

function clip(text: string): string {
  return text.length > RENDER_LIMIT ? `${text.slice(0, RENDER_LIMIT)}\n… (truncated)` : text
}

/** Edit asks carry the pending change as a diff in metadata; fall back to raw JSON. */
function detailOf(metadata: Record<string, unknown>): string | undefined {
  const patch = asString(metadata.diff) ?? asString(metadata.patch)
  if (patch) return patch
  if (Object.keys(metadata).length === 0) return undefined
  try {
    return JSON.stringify(metadata, null, 2)
  } catch {
    return undefined
  }
}

/**
 * Surfaces the FIRST queued Agent-tab permission ask; replies pop the queue and
 * reveal the next one. No backdrop dismiss — an ask demands a decision.
 * Code-panel asks render inline in the Code tab's DiffPermission instead.
 */
export default function PermissionModal() {
  const ask = useAgentStore((s) => s.permissionQueue.find((p) => p.tab === 'agent'))
  const queueLength = useAgentStore(
    (s) => s.permissionQueue.filter((p) => p.tab === 'agent').length
  )
  const session = useAgentStore((s) =>
    ask ? s.sessions.find((x) => x.id === ask.sessionId) : undefined
  )
  const permissionReply = useAgentStore((s) => s.permissionReply)
  const dismissPermission = useAgentStore((s) => s.dismissPermission)
  // Guards double-fired replies (the second would 404, or hit the NEXT ask).
  const [pending, setPending] = useState(false)

  if (!ask) return null
  const request = asRecord(ask.request)
  const permissionId = permissionIdOf(ask.request)
  const title = asString(request.title) ?? 'The agent wants to run a tool'
  const type = asString(request.type)
  const rawPattern = request.pattern
  const patterns = Array.isArray(rawPattern)
    ? rawPattern.filter((p): p is string => typeof p === 'string')
    : typeof rawPattern === 'string'
      ? [rawPattern]
      : []
  const detail = detailOf(asRecord(request.metadata))

  const reply = (response: PermissionReplyKind): void => {
    if (pending) return
    if (!permissionId) {
      // Malformed ask with nothing to reply to — drop it so the queue moves on.
      dismissPermission(ask)
      return
    }
    setPending(true)
    void permissionReply(ask.sessionId, permissionId, response)
      .catch(toastError)
      .finally(() => setPending(false))
  }

  return (
    <div className="no-drag fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="flex max-h-[80vh] w-full max-w-xl flex-col rounded-lg border border-zinc-800 bg-zinc-900 shadow-2xl">
        <div className="flex items-center gap-2 border-b border-zinc-800 px-4 py-3">
          <ShieldQuestion size={15} className="shrink-0 text-amber-400" />
          <h3 className="text-[13px] font-semibold text-zinc-100">Permission required</h3>
          {queueLength > 1 && (
            <span className="ml-auto text-[11px] text-zinc-600">1 of {queueLength}</span>
          )}
        </div>

        <div className="min-h-0 flex-1 space-y-2.5 overflow-y-auto p-4">
          <p className="select-text break-words text-[13px] leading-relaxed text-zinc-200">
            {title}
          </p>
          <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-zinc-500">
            {type && (
              <span className="rounded bg-zinc-800 px-1.5 py-0.5 font-mono text-zinc-300">
                {type}
              </span>
            )}
            {patterns.map((pattern) => (
              <span key={pattern} className="rounded bg-zinc-800/60 px-1.5 py-0.5 font-mono">
                {pattern}
              </span>
            ))}
            {session && (
              <span className="min-w-0 truncate" title={session.directory}>
                in {session.directory}
              </span>
            )}
          </div>
          {detail && (
            <pre className="max-h-72 select-text overflow-auto whitespace-pre-wrap rounded bg-zinc-950/60 p-2 font-mono text-[11px] leading-relaxed text-zinc-400">
              {clip(detail)}
            </pre>
          )}
        </div>

        <div className="flex justify-end gap-2 border-t border-zinc-800 px-4 py-3">
          <button
            onClick={() => reply('reject')}
            disabled={pending}
            className="rounded-md px-2.5 py-1 text-[12px] font-medium text-red-400 enabled:hover:bg-red-500/10 disabled:opacity-40"
          >
            Deny
          </button>
          <button
            onClick={() => reply('always')}
            disabled={pending}
            className="rounded-md border border-zinc-700 px-2.5 py-1 text-[12px] text-zinc-300 enabled:hover:bg-zinc-800 disabled:opacity-40"
          >
            Always allow
          </button>
          <button
            onClick={() => reply('once')}
            disabled={pending}
            className="rounded-md bg-emerald-600 px-2.5 py-1 text-[12px] font-medium text-white enabled:hover:bg-emerald-500 disabled:opacity-40"
          >
            Allow once
          </button>
        </div>
      </div>
    </div>
  )
}
