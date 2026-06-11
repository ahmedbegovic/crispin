import { useEffect } from 'react'
import { Check, Circle, Loader2, Minus, X } from 'lucide-react'
import type { PipelineStage } from '@shared/types'
import { useAgentStore } from '@/stores/agent'
import { toastError } from '@/stores/toasts'

const STAGE_LABELS: Record<PipelineStage['id'], string> = {
  plan: 'Plan',
  implement: 'Implement',
  verify: 'Verify',
  debug: 'Debug',
  commit: 'Commit',
  document: 'Document'
}

function StageChip({ stage, active }: { stage: PipelineStage; active: boolean }) {
  const icon =
    stage.status === 'done' ? (
      <Check size={10} className="text-emerald-400" />
    ) : stage.status === 'running' ? (
      <Loader2 size={10} className="animate-spin text-amber-400" />
    ) : stage.status === 'failed' ? (
      <X size={10} className="text-red-400" />
    ) : stage.status === 'skipped' ? (
      <Minus size={10} className="text-zinc-700" />
    ) : (
      <Circle size={8} className="text-zinc-700" />
    )
  return (
    <span
      className={`flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10.5px] ${
        active
          ? 'border-zinc-600 bg-zinc-800 text-zinc-200'
          : stage.status === 'skipped'
            ? 'border-zinc-850 text-zinc-700'
            : 'border-zinc-800 text-zinc-400'
      }`}
    >
      {icon}
      {STAGE_LABELS[stage.id]}
    </span>
  )
}

/** Stage chips + status line for the session's staged pipeline run. */
export default function PipelineBar({ sessionId }: { sessionId: string }) {
  const pipeline = useAgentStore((s) => s.pipelineBySession[sessionId])
  const refreshPipeline = useAgentStore((s) => s.refreshPipeline)
  const abortPipeline = useAgentStore((s) => s.abortPipeline)
  const approvePipeline = useAgentStore((s) => s.approvePipeline)
  const dismissPipeline = useAgentStore((s) => s.dismissPipeline)

  // The bar can mount mid-run (tab switch, app restart with main still live).
  useEffect(() => {
    void refreshPipeline(sessionId).catch(() => {})
  }, [sessionId, refreshPipeline])

  if (!pipeline) return null
  const active = pipeline.status === 'running' || pipeline.status === 'waiting_user'

  const statusLine =
    pipeline.status === 'waiting_user'
      ? 'Verification passed — commit the changes?'
      : pipeline.status === 'running'
        ? `Running: ${STAGE_LABELS[pipeline.stages[pipeline.currentIndex]?.id ?? 'plan']}`
        : pipeline.status === 'done'
          ? 'Pipeline complete.'
          : pipeline.status === 'aborted'
            ? 'Pipeline aborted.'
            : (pipeline.error ?? 'Pipeline failed.')

  return (
    <div className="no-drag shrink-0 border-b border-zinc-800/80 bg-zinc-950/40 px-4 py-2">
      <div className="flex flex-wrap items-center gap-1.5">
        {pipeline.stages.map((stage, i) => (
          <StageChip key={stage.id} stage={stage} active={active && i === pipeline.currentIndex} />
        ))}
        <div className="ml-auto flex items-center gap-1.5">
          {pipeline.status === 'waiting_user' && (
            <>
              <button
                onClick={() => void approvePipeline(pipeline.id, true).catch(toastError)}
                className="rounded-md bg-emerald-600 px-2 py-0.5 text-[11px] font-medium text-white hover:bg-emerald-500"
              >
                Commit
              </button>
              <button
                onClick={() => void approvePipeline(pipeline.id, false).catch(toastError)}
                className="rounded-md border border-zinc-700 px-2 py-0.5 text-[11px] text-zinc-400 hover:border-zinc-500 hover:text-zinc-200"
              >
                Skip
              </button>
            </>
          )}
          {active ? (
            <button
              onClick={() => void abortPipeline(pipeline.id).catch(toastError)}
              className="rounded-md border border-red-500/30 px-2 py-0.5 text-[11px] text-red-400 hover:bg-red-500/10"
            >
              Abort
            </button>
          ) : (
            <button
              onClick={() => dismissPipeline(sessionId)}
              title="Dismiss"
              className="rounded p-1 text-zinc-600 hover:bg-zinc-800 hover:text-zinc-300"
            >
              <X size={12} />
            </button>
          )}
        </div>
      </div>
      <p
        className={`mt-1 truncate text-[11px] ${
          pipeline.status === 'failed' ? 'text-red-400' : 'text-zinc-500'
        }`}
        title={pipeline.error ?? undefined}
      >
        {statusLine}
      </p>
    </div>
  )
}
