import { useState } from 'react'
import { ShieldQuestion } from 'lucide-react'
import {
  asRecord,
  asString,
  permissionIdOf,
  useAgentStore,
  type PermissionAsk,
  type PermissionReplyKind
} from '@/stores/agent'
import { toastError } from '@/stores/toasts'

const RENDER_LIMIT = 6000

function clip(text: string): string {
  return text.length > RENDER_LIMIT ? `${text.slice(0, RENDER_LIMIT)}\n… (truncated)` : text
}

// Probed @opencode-ai/sdk/dist/gen/types.gen.d.ts: Permission.metadata is
// untyped ({ [key: string]: unknown }) — no original/modified content pair
// exists on permissions (FileDiff {before, after} appears only on session
// summaries and session.diff events). Edit asks carry a unified diff string
// at metadata.diff (M3-verified), so render colored diff lines, not a Monaco
// DiffEditor.
function diffLineClass(line: string): string {
  if (line.startsWith('+++') || line.startsWith('---')) return 'text-zinc-500'
  if (line.startsWith('@@')) return 'text-sky-500'
  if (line.startsWith('+')) return 'bg-emerald-500/10 text-emerald-300'
  if (line.startsWith('-')) return 'bg-red-500/10 text-red-300'
  return 'text-zinc-400'
}

function UnifiedDiff({ diff }: { diff: string }) {
  return (
    <pre className="max-h-56 select-text overflow-auto rounded bg-zinc-950/80 p-2 font-mono text-[11px] leading-relaxed">
      {clip(diff)
        .split('\n')
        .map((line, i) => (
          <div key={i} className={diffLineClass(line)}>
            {line === '' ? ' ' : line}
          </div>
        ))}
    </pre>
  )
}

interface Props {
  ask: PermissionAsk
  /** Attribution when the ask isn't from the visible timeline — the owning
   *  session's title, or its workspace directory when from another root. */
  sessionLabel?: string
}

/** One Code-panel permission ask, rendered inline above the composer. */
export default function DiffPermission({ ask, sessionLabel }: Props) {
  const permissionReply = useAgentStore((s) => s.permissionReply)
  const dismissPermission = useAgentStore((s) => s.dismissPermission)
  // Guards double-fired replies (the second would 404, or hit the NEXT ask).
  const [pending, setPending] = useState(false)

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
  const metadata = asRecord(request.metadata)
  const diff = asString(metadata.diff) ?? asString(metadata.patch)
  let fallback: string | undefined
  if (!diff && Object.keys(metadata).length > 0) {
    try {
      fallback = JSON.stringify(metadata, null, 2)
    } catch {
      fallback = undefined
    }
  }

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
    <div className="no-drag mx-3 mb-2 shrink-0 rounded-lg border border-amber-500/30 bg-zinc-900/90">
      <div className="space-y-2 p-3">
        <div className="flex items-start gap-2">
          <ShieldQuestion size={14} className="mt-0.5 shrink-0 text-amber-400" />
          <p className="min-w-0 select-text break-words text-[12.5px] leading-relaxed text-zinc-200">
            {title}
          </p>
        </div>
        {(type || patterns.length > 0 || sessionLabel) && (
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
            {sessionLabel && (
              <span className="min-w-0 truncate" title={sessionLabel}>
                in {sessionLabel}
              </span>
            )}
          </div>
        )}
        {diff ? (
          <UnifiedDiff diff={diff} />
        ) : fallback ? (
          <pre className="max-h-56 select-text overflow-auto whitespace-pre-wrap rounded bg-zinc-950/80 p-2 font-mono text-[11px] leading-relaxed text-zinc-400">
            {clip(fallback)}
          </pre>
        ) : null}
      </div>
      <div className="flex justify-end gap-2 border-t border-zinc-800 px-3 py-2">
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
          Always
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
  )
}
