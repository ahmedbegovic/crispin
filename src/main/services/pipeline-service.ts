import { execFileSync } from 'node:child_process'
import type { CrispinEvent } from '@shared/ipc'
import type { Family, PermissionMode, PipelineSnapshot, PipelineStageId, Tier } from '@shared/types'
import type { AgentService } from './agent-service'
import { scopedLogger } from './logger'

/** A stage that produces no completed assistant turn for this long has hung. */
const STAGE_TIMEOUT_MS = 90 * 60_000
const MAX_DEBUG_ROUNDS = 2
/** How much of the verifier's reply survives into the failure message. */
const ISSUES_CLIP = 1500

export interface PipelineOptions {
  commit: boolean
  docs: boolean
  permissionMode?: PermissionMode
  /** Model tier for every stage; undefined follows the session/feature default. */
  tier?: Tier
  /** Model family for every stage; undefined follows the session/global default. */
  family?: Family
}

interface PipelineRun {
  snapshot: PipelineSnapshot
  options: PipelineOptions
  /** implement/debug run under this; plan uses opencode's plan agent. */
  permissionMode: PermissionMode
  /** ≥1 assistant message completed since the stage started (guards spurious idles). */
  sawCompletedAssistant: boolean
  timeout: NodeJS.Timeout | null
  debugRounds: number
  /** Anti-loop: a missing verdict counts as ISSUES once, then PASS. */
  verdictMissingOnce: boolean
  /** The verifier's issues text — feeds the debug prompt and the failure error. */
  lastIssues: string | null
}

export interface PipelineServiceDeps {
  agentService: AgentService
  broadcast: (event: CrispinEvent) => void
}

/**
 * Programmatic pipeline over ONE opencode session:
 * Plan → Implement → Verify → (Debug ≤2 → re-Verify) → Commit (user-gated) → Document.
 * In-memory by design — an app restart drops the pipeline; the underlying
 * opencode session (and any work already done) persists on disk.
 */
export class PipelineService {
  private readonly log = scopedLogger('pipeline')
  /** One active pipeline per session. */
  private readonly bySession = new Map<string, PipelineRun>()

  constructor(private readonly deps: PipelineServiceDeps) {
    deps.agentService.onSessionEvent((sessionId, event) => this.onSessionEvent(sessionId, event))
  }

  start(sessionId: string, task: string, options: PipelineOptions): { pipelineId: string } {
    const existing = this.bySession.get(sessionId)
    if (existing && this.isActive(existing)) {
      throw new Error('A pipeline is already running in this session')
    }
    const directory = this.deps.agentService.sessionDirectory(sessionId)
    // rev-parse walks up parent dirs — a session rooted BELOW the repo top
    // level is still committable (a bare .git check would skip the gate).
    const repo = isInsideWorkTree(directory)
    const stages: PipelineSnapshot['stages'] = [
      { id: 'plan', status: 'pending' },
      { id: 'implement', status: 'pending' },
      { id: 'verify', status: 'pending' },
      { id: 'debug', status: 'pending' },
      { id: 'commit', status: options.commit && repo ? 'pending' : 'skipped' },
      { id: 'document', status: options.docs ? 'pending' : 'skipped' }
    ]
    const run: PipelineRun = {
      snapshot: {
        id: crypto.randomUUID(),
        sessionId,
        task,
        stages,
        currentIndex: 0,
        status: 'running',
        error: null
      },
      options,
      permissionMode: options.permissionMode ?? 'acceptEdits',
      sawCompletedAssistant: false,
      timeout: null,
      debugRounds: 0,
      verdictMissingOnce: false,
      lastIssues: null
    }
    this.bySession.set(sessionId, run)
    void this.startStage(run, 'plan').catch((err) => this.fail(run, errMessage(err)))
    return { pipelineId: run.snapshot.id }
  }

  get(sessionId: string): PipelineSnapshot | null {
    return this.bySession.get(sessionId)?.snapshot ?? null
  }

  async abort(pipelineId: string): Promise<void> {
    const run = this.byId(pipelineId)
    if (!run || !this.isActive(run)) return
    // Status flips BEFORE the abort POST: the abort itself produces a
    // completed assistant message + session.idle on the SSE stream, and those
    // events racing the fetch would otherwise advance the pipeline and fire
    // the next stage's prompt into opencode.
    this.clearTimer(run)
    const current = run.snapshot.stages[run.snapshot.currentIndex]
    if (current && current.status === 'running') current.status = 'failed'
    run.snapshot.status = 'aborted'
    this.publish(run)
    try {
      await this.deps.agentService.abort(run.snapshot.sessionId)
    } catch (err) {
      this.log.warn(`abort: ${errMessage(err)}`)
    }
    // Belt and braces: an event handled between the flip and here cannot have
    // armed a timer (onSessionEvent gates on status), but clear regardless.
    this.clearTimer(run)
  }

  /** The commit gate's Approve/Skip. */
  approve(pipelineId: string, approve: boolean): void {
    const run = this.byId(pipelineId)
    if (!run || run.snapshot.status !== 'waiting_user') {
      throw new Error('This pipeline is not waiting for approval')
    }
    run.snapshot.status = 'running'
    if (approve) {
      void this.startStage(run, 'commit').catch((err) => this.fail(run, errMessage(err)))
    } else {
      this.setStage(run, 'commit', 'skipped')
      this.advancePast(run, 'commit')
    }
  }

  dispose(): void {
    for (const run of this.bySession.values()) this.clearTimer(run)
    this.bySession.clear()
  }

  // --- state machine -----------------------------------------------------------

  private async startStage(run: PipelineRun, stage: PipelineStageId): Promise<void> {
    this.setStage(run, stage, 'running')
    run.snapshot.currentIndex = run.snapshot.stages.findIndex((s) => s.id === stage)
    run.sawCompletedAssistant = false
    this.clearTimer(run)
    run.timeout = setTimeout(() => {
      this.fail(run, `The ${stage} stage timed out after 90 minutes.`)
    }, STAGE_TIMEOUT_MS)
    run.timeout.unref()
    this.publish(run)
    // plan rides opencode's built-in read-only plan agent; implement/debug run
    // under the pipeline's permission mode; commit/document stay normal.
    const mode: PermissionMode =
      stage === 'plan'
        ? 'plan'
        : stage === 'implement' || stage === 'debug'
          ? run.permissionMode
          : 'normal'
    // The composer's visible tier rides along — stages must not silently run
    // on whatever tier an earlier manual prompt persisted (review finding).
    await this.deps.agentService.prompt(
      run.snapshot.sessionId,
      this.stagePrompt(run, stage),
      run.options.tier,
      run.options.family,
      mode
    )
  }

  private onSessionEvent(sessionId: string, event: unknown): void {
    const run = this.bySession.get(sessionId)
    if (!run) return
    const type = (event as { type?: unknown }).type
    if (typeof type !== 'string') return

    // Session deleted: events stop routing here forever — drop the run (and
    // its timer) instead of letting it hang 'running' for 90 minutes.
    if (type === 'crispin.sessionDeleted') {
      this.clearTimer(run)
      this.bySession.delete(sessionId)
      return
    }
    if (run.snapshot.status !== 'running') return

    if (type === 'crispin.promptFailed') {
      this.fail(run, String((event as { error?: unknown }).error ?? 'prompt failed'))
      return
    }
    // A stage prompt cancelled during its pre-warm (composer Stop) never
    // reaches opencode — without this the run would idle out after 90 min.
    if (type === 'crispin.promptCancelled') {
      this.fail(run, 'The stage prompt was cancelled.')
      return
    }
    if (type === 'session.error') {
      const props = (event as { properties?: { error?: unknown } }).properties
      this.fail(run, `opencode session error: ${JSON.stringify(props?.error ?? 'unknown').slice(0, 300)}`)
      return
    }
    if (type === 'message.updated') {
      const info = (event as { properties?: { info?: { role?: unknown; time?: { completed?: unknown } } } })
        .properties?.info
      if (info?.role === 'assistant' && info.time?.completed) run.sawCompletedAssistant = true
      return
    }
    // A stage is done when the session idles AFTER a completed assistant turn —
    // idles fired during admission/tool churn don't count.
    if (type === 'session.idle' && run.sawCompletedAssistant) {
      void this.completeStage(run).catch((err) => this.fail(run, errMessage(err)))
    }
  }

  private async completeStage(run: PipelineRun): Promise<void> {
    const stage = run.snapshot.stages[run.snapshot.currentIndex]
    if (!stage || stage.status !== 'running') return
    this.clearTimer(run)

    if (stage.id === 'verify') {
      const { verdict, issues } = await this.readVerdict(run)
      if (verdict === 'PASS') {
        this.setStage(run, 'verify', 'done')
        if (run.debugRounds === 0) this.setStage(run, 'debug', 'skipped')
        this.advancePast(run, 'debug')
        return
      }
      // ISSUES (or a missing verdict counted as ISSUES once)
      run.lastIssues = issues
      if (run.debugRounds >= MAX_DEBUG_ROUNDS) {
        this.setStage(run, 'verify', 'failed')
        this.fail(run, `Verification still failing after ${MAX_DEBUG_ROUNDS} debug rounds:\n${issues}`)
        return
      }
      run.debugRounds += 1
      this.setStage(run, 'verify', 'pending')
      await this.startStage(run, 'debug')
      return
    }

    this.setStage(run, stage.id, 'done')
    switch (stage.id) {
      case 'plan':
        await this.startStage(run, 'implement')
        return
      case 'implement':
        await this.startStage(run, 'verify')
        return
      case 'debug':
        // Debug stays visible as done; verification runs again.
        await this.startStage(run, 'verify')
        return
      case 'commit':
        this.advancePast(run, 'commit')
        return
      case 'document':
        this.finish(run)
        return
    }
  }

  /** Move forward from a stage (after done/skipped): commit gate → document → done. */
  private advancePast(run: PipelineRun, stage: PipelineStageId): void {
    if (stage === 'debug') {
      const commit = run.snapshot.stages.find((s) => s.id === 'commit')
      if (commit && commit.status === 'pending') {
        // Commit is user-gated — never run it without an explicit Approve.
        run.snapshot.status = 'waiting_user'
        run.snapshot.currentIndex = run.snapshot.stages.findIndex((s) => s.id === 'commit')
        this.publish(run)
        return
      }
      this.advancePast(run, 'commit')
      return
    }
    if (stage === 'commit') {
      const doc = run.snapshot.stages.find((s) => s.id === 'document')
      if (doc && doc.status === 'pending') {
        void this.startStage(run, 'document').catch((err) => this.fail(run, errMessage(err)))
        return
      }
      this.finish(run)
    }
  }

  private finish(run: PipelineRun): void {
    this.clearTimer(run)
    run.snapshot.status = 'done'
    this.publish(run)
  }

  private fail(run: PipelineRun, error: string): void {
    this.clearTimer(run)
    if (run.snapshot.status === 'aborted') return // an abort verdict is final
    const current = run.snapshot.stages[run.snapshot.currentIndex]
    if (current && current.status === 'running') current.status = 'failed'
    run.snapshot.status = 'failed'
    run.snapshot.error = error.slice(0, ISSUES_CLIP)
    this.publish(run)
  }

  // --- verdict ------------------------------------------------------------------

  private async readVerdict(run: PipelineRun): Promise<{ verdict: 'PASS' | 'ISSUES'; issues: string }> {
    const text = await this.lastAssistantText(run.snapshot.sessionId)
    const matches = [...text.matchAll(/VERDICT:\s*(PASS|ISSUES)/gi)]
    const last = matches.at(-1)?.[1]?.toUpperCase()
    if (last === 'PASS') return { verdict: 'PASS', issues: '' }
    if (last === 'ISSUES') return { verdict: 'ISSUES', issues: clipTail(text) }
    // No verdict at all: count it as ISSUES once (the debugger gets a chance),
    // then PASS — a verifier that never says the magic word must not loop.
    if (run.verdictMissingOnce) {
      this.log.warn('verifier omitted the verdict twice — counting as PASS (anti-loop)')
      return { verdict: 'PASS', issues: '' }
    }
    run.verdictMissingOnce = true
    return {
      verdict: 'ISSUES',
      issues: `The verifier did not produce a VERDICT line. Its reply ended with:\n${clipTail(text)}`
    }
  }

  private async lastAssistantText(sessionId: string): Promise<string> {
    const { messages } = await this.deps.agentService.get(sessionId)
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i] as {
        info?: { role?: unknown }
        parts?: Array<{ type?: unknown; text?: unknown }>
      }
      if (message?.info?.role !== 'assistant') continue
      const text = (message.parts ?? [])
        .filter((p) => p?.type === 'text' && typeof p.text === 'string')
        .map((p) => p.text as string)
        .join('\n')
      if (text.trim()) return text
    }
    return ''
  }

  // --- prompts -------------------------------------------------------------------

  private stagePrompt(run: PipelineRun, stage: PipelineStageId): string {
    const task = run.snapshot.task
    switch (stage) {
      case 'plan':
        return (
          `Use the "planner" skill: investigate this workspace and produce a numbered implementation plan for the task below. ` +
          `Do not edit any files. End your reply with the line PLAN COMPLETE.\n\nTask: ${task}`
        )
      case 'implement':
        return (
          `Implement the plan you just produced, step by step. Keep the changes minimal and consistent with the surrounding code. ` +
          `When every step is done, summarize what changed.\n\nTask: ${task}`
        )
      case 'verify':
        return (
          `Use the "verifier" skill: verify that the task below is correctly and completely implemented in this workspace ` +
          `(run the project's checks where available). Contract: your reply's FINAL line must be exactly ` +
          `"VERDICT: PASS" or "VERDICT: ISSUES", with the numbered issues listed before an ISSUES verdict.\n\nTask: ${task}`
        )
      case 'debug':
        return (
          `Use the "debugger" skill: the verifier reported the issues below. Reproduce each, find the root cause, and fix it.\n\n` +
          `Issues:\n${run.lastIssues ?? '(none captured)'}\n\nOriginal task: ${task}`
        )
      case 'commit':
        return (
          `Use the "commit-pr-author" skill: stage the changes made for this task and create one git commit with a ` +
          `well-written message (run the git commands yourself).\n\nTask: ${task}`
        )
      case 'document':
        return (
          `Use the "documentation-writer" skill: update any documentation this change affects (README, docs, comments) ` +
          `so it matches the new behavior. If nothing needs updating, say so.\n\nTask: ${task}`
        )
    }
  }

  // --- plumbing --------------------------------------------------------------------

  private isActive(run: PipelineRun): boolean {
    return run.snapshot.status === 'running' || run.snapshot.status === 'waiting_user'
  }

  private byId(pipelineId: string): PipelineRun | null {
    for (const run of this.bySession.values()) {
      if (run.snapshot.id === pipelineId) return run
    }
    return null
  }

  private setStage(run: PipelineRun, stage: PipelineStageId, status: PipelineSnapshot['stages'][number]['status']): void {
    const entry = run.snapshot.stages.find((s) => s.id === stage)
    if (entry) entry.status = status
  }

  private clearTimer(run: PipelineRun): void {
    if (run.timeout) clearTimeout(run.timeout)
    run.timeout = null
  }

  private publish(run: PipelineRun): void {
    this.deps.broadcast({ type: 'pipeline.update', pipeline: { ...run.snapshot, stages: run.snapshot.stages.map((s) => ({ ...s })) } })
  }
}

const errMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err))

function isInsideWorkTree(directory: string): boolean {
  try {
    return (
      execFileSync('git', ['rev-parse', '--is-inside-work-tree'], {
        cwd: directory,
        timeout: 5_000,
        encoding: 'utf8',
        env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' }
      }).trim() === 'true'
    )
  } catch {
    return false // no git / not a repo — the commit stage stays skipped
  }
}

const clipTail = (text: string): string =>
  text.length > ISSUES_CLIP ? `…${text.slice(-ISSUES_CLIP)}` : text
