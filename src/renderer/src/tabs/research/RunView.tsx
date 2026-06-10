import { useEffect, useState } from 'react'
import { AlertTriangle, FileDown, Loader2, Play } from 'lucide-react'
import type { ResearchRunMeta } from '@shared/types'
import { useResearchStore } from '@/stores/research'
import { pushToast, toastError } from '@/stores/toasts'
import { stepError } from './cast'
import StatusPill, { isActiveStatus } from './StatusPill'
import StepTimeline from './StepTimeline'
import ReportView from './ReportView'

// Mirrors the orchestrator's MAX_ROUNDS — display only.
const MAX_ROUNDS = 4

interface Props {
  run: ResearchRunMeta
}

export default function RunView({ run }: Props) {
  const steps = useResearchStore((s) => s.stepsByRun[run.id])
  const cancel = useResearchStore((s) => s.cancel)
  const resume = useResearchStore((s) => s.resume)
  const exportPdf = useResearchStore((s) => s.exportPdf)

  const [view, setView] = useState<'timeline' | 'report'>(
    run.status === 'done' ? 'report' : 'timeline'
  )
  const [exporting, setExporting] = useState(false)
  const [resuming, setResuming] = useState(false)

  // Jump to the report when a watched run finishes; manual toggling sticks
  // afterwards because the effect only refires on a status change.
  useEffect(() => {
    if (run.status === 'done') setView('report')
  }, [run.status])

  // Resume resolves immediately while the model cold load runs for up to
  // minutes — keep the pending state until main reports a status transition.
  useEffect(() => {
    setResuming(false)
  }, [run.id, run.status])

  const active = isActiveStatus(run.status)
  // Failed visit/note steps are non-fatal skips the loop carries past, so only
  // blame the last failed step when it is the run's most recent step activity;
  // otherwise the run-level failure left no step and the generic line shows.
  const lastFailedStep =
    run.status === 'failed'
      ? [...(steps ?? [])].reverse().find((s) => s.status === 'failed')
      : undefined
  const newestFinish = Math.max(0, ...(steps ?? []).map((s) => s.finishedAt ?? 0))
  const failedStep =
    lastFailedStep?.finishedAt != null && lastFailedStep.finishedAt >= newestFinish
      ? lastFailedStep
      : undefined

  const onExport = (): void => {
    if (exporting) return
    setExporting(true)
    void exportPdf(run.id)
      .then((path) => {
        if (!path) pushToast('warn', 'No report file to export.')
      })
      .catch(toastError)
      .finally(() => setExporting(false))
  }

  const onResume = (): void => {
    if (resuming) return
    setResuming(true)
    void resume(run.id).catch((err: unknown) => {
      setResuming(false)
      toastError(err)
    })
  }

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      {/* pt-12 clears the hiddenInset titlebar band (h-12, traffic lights centered). */}
      <header className="flex shrink-0 items-center gap-2.5 border-b border-zinc-800/80 px-6 pb-2.5 pt-12">
        <span title={run.question} className="min-w-0 truncate text-[13px] font-medium text-zinc-200">
          {run.question}
        </span>
        <StatusPill status={run.status} />
        {run.status === 'rounds' && (
          <span className="shrink-0 text-[11px] tabular-nums text-zinc-500">
            Round {run.round}/{MAX_ROUNDS}
          </span>
        )}

        <div className="no-drag ml-auto flex shrink-0 items-center gap-1.5">
          {run.status === 'done' && (
            <div className="flex rounded-md border border-zinc-800 bg-zinc-900 p-0.5 text-[11px]">
              {(['timeline', 'report'] as const).map((v) => (
                <button
                  key={v}
                  onClick={() => setView(v)}
                  className={`rounded px-2 py-0.5 capitalize ${
                    view === v ? 'bg-zinc-700 text-zinc-100' : 'text-zinc-500 hover:text-zinc-300'
                  }`}
                >
                  {v}
                </button>
              ))}
            </div>
          )}
          {active && (
            <button
              onClick={() => void cancel(run.id).catch(toastError)}
              className="rounded-md border border-red-500/30 px-2 py-1 text-[11px] text-red-400 hover:bg-red-500/10"
            >
              Cancel
            </button>
          )}
          {(run.status === 'paused' || run.status === 'failed') && (
            <button
              onClick={onResume}
              disabled={resuming}
              className="flex items-center gap-1 rounded-md bg-emerald-600 px-2 py-1 text-[11px] font-medium text-white enabled:hover:bg-emerald-500 disabled:opacity-40"
            >
              {resuming ? <Loader2 size={11} className="animate-spin" /> : <Play size={11} />}
              {run.status === 'failed' ? 'Retry' : 'Resume'}
            </button>
          )}
          {run.status === 'done' && run.reportPath && (
            <button
              onClick={onExport}
              disabled={exporting}
              className="flex items-center gap-1 rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 text-[11px] text-zinc-300 enabled:hover:border-zinc-600 disabled:opacity-40"
            >
              {exporting ? (
                <Loader2 size={11} className="animate-spin" />
              ) : (
                <FileDown size={11} />
              )}
              Export PDF
            </button>
          )}
        </div>
      </header>

      {run.status === 'failed' && (
        <div className="mx-6 mt-3 flex shrink-0 items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-[12px] text-red-300">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" />
          <p className="min-w-0 select-text break-words">
            {failedStep
              ? `Failed at ${failedStep.type}: ${stepError(failedStep)}`
              : 'The run failed without a recorded step error.'}
          </p>
        </div>
      )}

      {view === 'report' && run.status === 'done' ? (
        <ReportView run={run} />
      ) : (
        <StepTimeline run={run} steps={steps} />
      )}
    </div>
  )
}
