import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { agentSessionMetaSchema, type CrispinEvent } from '@shared/ipc'
import type { AgentSessionMeta, AgentTab, Family, PermissionMode, Tier } from '@shared/types'
import type { CrispinDatabase } from './db'
import { engineModelId } from './engine-client'
import type { ModelService } from './model-service'
import type { OpencodePool } from './opencode-pool'
import { dataDir } from './paths'
import { scopedLogger } from './logger'
import { parseArrayDropInvalid } from './hydrate'

export interface AgentServiceDeps {
  db: CrispinDatabase
  pool: OpencodePool
  modelService: ModelService
  broadcast: (event: CrispinEvent) => void
}

interface AgentSessionRow {
  id: string
  opencode_session_id: string | null
  tab: AgentTab
  directory: string
  title: string | null
  /** Last explicitly chosen model tier; null = follow the feature default. */
  tier: Tier | null
  /** Last explicitly chosen model family; null = follow the global default. */
  family: Family | null
  created_at: number
  last_used_at: number | null
}

const rowToMeta = (row: AgentSessionRow): AgentSessionMeta => ({
  id: row.id,
  tab: row.tab,
  directory: row.directory,
  title: row.title,
  tier: row.tier,
  family: row.family,
  createdAt: row.created_at,
  lastUsedAt: row.last_used_at
})

const MEMORY_FILE_RE = /^[\w.-]+\.md$/

const MEMORY_TEMPLATE = `# Agent memory

This directory is your persistent memory. Every \`*.md\` file here is loaded
into the start of each of your sessions automatically.

When you are asked to remember something — or learn a durable fact, preference,
or convention worth keeping — create or update a markdown file here with a short
descriptive name (e.g. \`project-conventions.md\`). Keep files small and factual,
and remove entries that are no longer true.
`

/** Control-call timeout; prompt_async is admission-only so this never spans a generation. */
const REQUEST_TIMEOUT_MS = 30_000

/**
 * Agent sessions: our rows in agent_sessions own identity (id = UUID); the
 * opencode session behind each row is addressed via opencode_session_id.
 * opencode persists sessions on disk keyed by directory, so they survive
 * server restarts and pool evictions (verified live on 1.16.2).
 */
export class AgentService {
  private readonly log = scopedLogger('agent')
  private readonly memoryDir = join(dataDir(), 'memory')
  /** Last prompt's permission mode per session — drives the ask auto-replies. */
  private readonly modeBySession = new Map<string, PermissionMode>()
  /**
   * Cancellation token for a prompt still in its pre-warm (per session).
   * The pre-warm can take minutes; abort() and delete() flip the flag so the
   * prompt is dropped instead of firing into opencode after the user moved on.
   */
  private readonly pendingBySession = new Map<string, { cancelled: boolean }>()
  /** Typed taps on the per-session event stream (pipeline-service). */
  private readonly sessionEventListeners: Array<(sessionId: string, event: unknown) => void> = []

  constructor(private readonly deps: AgentServiceDeps) {
    deps.pool.onEvent((directory, event) => this.onPoolEvent(directory, event))
  }

  init(): void {
    mkdirSync(this.memoryDir, { recursive: true })
    const agentsMd = join(this.memoryDir, 'AGENTS.md')
    if (!existsSync(agentsMd)) writeFileSync(agentsMd, MEMORY_TEMPLATE)
  }

  /** Subscribe to every opencode event for OUR sessions, keyed by session id. */
  onSessionEvent(cb: (sessionId: string, event: unknown) => void): void {
    this.sessionEventListeners.push(cb)
  }

  /** The session's working directory (pipeline repo checks). */
  sessionDirectory(sessionId: string): string {
    return this.row(sessionId).directory
  }

  private emitSessionEvent(sessionId: string, event: unknown): void {
    for (const cb of this.sessionEventListeners) {
      try {
        cb(sessionId, event)
      } catch (err) {
        this.log.warn(`session event listener threw: ${err instanceof Error ? err.message : err}`)
      }
    }
  }

  // --- sessions ---------------------------------------------------------------

  sessions(filter?: { tab?: AgentTab; directory?: string }): AgentSessionMeta[] {
    const where: string[] = []
    const params: string[] = []
    if (filter?.tab) {
      where.push('tab = ?')
      params.push(filter.tab)
    }
    if (filter?.directory) {
      where.push('directory = ?')
      params.push(filter.directory)
    }
    const rows = this.deps.db
      .prepare(
        `SELECT * FROM agent_sessions${where.length ? ` WHERE ${where.join(' AND ')}` : ''}
         ORDER BY COALESCE(last_used_at, created_at) DESC`
      )
      .all(...params) as unknown as AgentSessionRow[]
    return parseArrayDropInvalid(agentSessionMetaSchema, rows.map(rowToMeta), 'agent.sessions')
  }

  async create(
    directory: string,
    tier?: Tier,
    family?: Family,
    tab: AgentTab = 'agent'
  ): Promise<AgentSessionMeta> {
    const modelId = engineModelId(this.resolveRepo(tier, family, tab))
    const { baseUrl } = await this.deps.pool.ensureServer(directory)
    this.deps.pool.touch(directory)
    const opencodeId = await this.createOpencodeSession(baseUrl, modelId)
    const row: AgentSessionRow = {
      id: crypto.randomUUID(),
      opencode_session_id: opencodeId,
      tab,
      directory,
      title: null,
      tier: tier ?? null,
      family: family ?? null,
      created_at: Date.now(),
      last_used_at: null
    }
    this.deps.db
      .prepare(
        `INSERT INTO agent_sessions (id, opencode_session_id, tab, directory, title, tier, family, created_at, last_used_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        row.id,
        row.opencode_session_id,
        row.tab,
        row.directory,
        row.title,
        row.tier,
        row.family,
        row.created_at,
        row.last_used_at
      )
    return rowToMeta(row)
  }

  async get(sessionId: string): Promise<{ session: AgentSessionMeta; messages: unknown[] }> {
    const row = this.row(sessionId)
    const { baseUrl } = await this.deps.pool.ensureServer(row.directory)
    this.deps.pool.touch(row.directory)
    const res = await this.request(baseUrl, 'GET', `/session/${row.opencode_session_id}/message`)
    if (res.status === 404) {
      // opencode storage for this session is gone; the next prompt's 404 path recreates it.
      return { session: rowToMeta(row), messages: [] }
    }
    if (!res.ok) throw new Error(`opencode message list failed: ${res.status}`)
    return { session: rowToMeta(row), messages: (await res.json()) as unknown[] }
  }

  /**
   * Fire-and-forget: POST /session/{id}/prompt_async returns 204 on admission
   * and all progress arrives over the SSE bridge. Errors surface as an
   * crispin.promptFailed agent.event (the renderer's handler owns the toast)
   * instead of failing the IPC call.
   */
  async prompt(
    sessionId: string,
    text: string,
    tier?: Tier,
    family?: Family,
    mode?: PermissionMode
  ): Promise<void> {
    const row = this.row(sessionId)
    // Explicit pick > the session's persisted tier/family > the feature default —
    // a chat started on High/Qwen must not jump back to the code default just
    // because the composer remounted on a session switch.
    const repoId = this.resolveRepo(
      tier ?? row.tier ?? undefined,
      family ?? row.family ?? undefined,
      row.tab
    )
    const modelId = engineModelId(repoId)
    await this.deps.pool.ensureServer(row.directory)
    this.deps.pool.touch(row.directory)
    this.modeBySession.set(row.id, mode ?? 'normal')
    this.deps.db
      .prepare(
        'UPDATE agent_sessions SET last_used_at = ?, tier = COALESCE(?, tier), family = COALESCE(?, family) WHERE id = ?'
      )
      .run(Date.now(), tier ?? null, family ?? null, row.id)
    const pending = { cancelled: false }
    this.pendingBySession.set(row.id, pending)
    void (async () => {
      // opencode talks to the engine directly, so nothing on that path evicts
      // idle co-residents — a big-tier prompt with the utility model still
      // loaded trips the engine's prefill memory guard. Warm through load():
      // it swap-unloads the others exactly like the chat path does.
      await this.deps.modelService.ensureLoaded(repoId)
      // The pre-warm can take minutes; everything captured before it is stale
      // now. Stop and session deletion must win (the prompt was never admitted
      // to opencode, so abort() had nothing to cancel there), and the pool may
      // have evicted the session's server — re-resolve instead of fetching a
      // dead baseUrl or resurrecting a deleted session via the 404 path.
      if (pending.cancelled) return this.notifyCancelled(row)
      const fresh = this.rowOrNull(row.id)
      if (!fresh) return // deleted mid-warm — nothing to prompt
      const { baseUrl } = await this.deps.pool.ensureServer(fresh.directory)
      this.deps.pool.touch(fresh.directory)
      if (pending.cancelled) return this.notifyCancelled(fresh)
      await this.firePrompt(fresh, baseUrl, modelId, text, mode)
    })()
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err)
        if (pending.cancelled) {
          // The user already stopped this prompt — a late pre-warm failure is
          // log-worthy, not toast-worthy.
          this.log.info(`cancelled prompt's pre-warm failed for session ${row.id}: ${message}`)
          return
        }
        this.log.warn(`prompt failed for session ${row.id}: ${message}`)
        const failed = { type: 'crispin.promptFailed', error: message }
        this.deps.broadcast({ type: 'agent.event', sessionId: row.id, tab: row.tab, event: failed })
        this.emitSessionEvent(row.id, failed)
      })
      .finally(() => {
        if (this.pendingBySession.get(row.id) === pending) this.pendingBySession.delete(row.id)
      })
  }

  /** Quiet renderer cleanup for a prompt cancelled before opencode admission. */
  private notifyCancelled(row: AgentSessionRow): void {
    this.log.info(`prompt cancelled during pre-warm for session ${row.id}`)
    const event = { type: 'crispin.promptCancelled' }
    this.deps.broadcast({ type: 'agent.event', sessionId: row.id, tab: row.tab, event })
    this.emitSessionEvent(row.id, event)
  }

  async abort(sessionId: string): Promise<void> {
    // A prompt still in its pre-warm was never admitted to opencode — the
    // POST below would abort nothing and the prompt would fire after the
    // user's Stop. The token makes Stop win.
    const pending = this.pendingBySession.get(sessionId)
    if (pending) pending.cancelled = true
    const row = this.row(sessionId)
    const server = this.deps.pool.runningServer(row.directory)
    if (!server) return // no live server — nothing in flight to abort
    this.deps.pool.touch(row.directory)
    const res = await this.request(server.baseUrl, 'POST', `/session/${row.opencode_session_id}/abort`)
    if (!res.ok) throw new Error(`opencode abort failed: ${res.status}`)
  }

  async permissionReply(
    sessionId: string,
    permissionId: string,
    reply: 'once' | 'always' | 'reject'
  ): Promise<void> {
    const row = this.row(sessionId)
    const server = this.deps.pool.runningServer(row.directory)
    if (!server) return // no live server — no pending ask left to answer
    this.deps.pool.touch(row.directory)
    const res = await this.request(
      server.baseUrl,
      'POST',
      `/session/${row.opencode_session_id}/permissions/${permissionId}`,
      { response: reply }
    )
    if (res.status === 404) {
      this.log.warn(`permission ${permissionId} no longer pending — dropping stale ask`)
      return
    }
    if (!res.ok) throw new Error(`opencode permission reply failed: ${res.status}`)
  }

  async delete(sessionId: string): Promise<void> {
    const row = this.row(sessionId)
    // A prompt mid-pre-warm must not fire after the session is gone — the
    // 404-recreate path would resurrect an orphan opencode session whose
    // events route nowhere.
    const pending = this.pendingBySession.get(sessionId)
    if (pending) pending.cancelled = true
    this.pendingBySession.delete(sessionId)
    // Listeners (pipeline) must hear about the deletion — after the row goes,
    // SSE events stop resolving to this session and nothing else tells them.
    this.emitSessionEvent(sessionId, { type: 'crispin.sessionDeleted' })
    const server = this.deps.pool.runningServer(row.directory)
    if (server) {
      try {
        this.deps.pool.touch(row.directory)
        await this.request(server.baseUrl, 'DELETE', `/session/${row.opencode_session_id}`)
      } catch (err) {
        this.log.warn(`opencode delete skipped: ${err instanceof Error ? err.message : err}`)
      }
    }
    this.deps.db.prepare('DELETE FROM agent_sessions WHERE id = ?').run(sessionId)
    this.modeBySession.delete(sessionId)
  }

  // --- memory -------------------------------------------------------------------

  memoryList(): Array<{ name: string; updatedAt: number }> {
    let names: string[]
    try {
      names = readdirSync(this.memoryDir).filter((n) => MEMORY_FILE_RE.test(n))
    } catch {
      return []
    }
    return names
      .map((name) => ({ name, updatedAt: Math.round(statSync(join(this.memoryDir, name)).mtimeMs) }))
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  memoryRead(name: string): string {
    return readFileSync(join(this.memoryDir, this.memoryFileName(name)), 'utf8')
  }

  /** Empty content deletes the file (per the IPC contract). */
  memoryWrite(name: string, content: string): void {
    const path = join(this.memoryDir, this.memoryFileName(name))
    if (content === '') {
      try {
        unlinkSync(path)
      } catch {
        // already gone
      }
      return
    }
    mkdirSync(this.memoryDir, { recursive: true })
    writeFileSync(path, content)
  }

  /** Rejects rather than aliases: the regex excludes separators, so this stays escape-free. */
  private memoryFileName(name: string): string {
    if (!MEMORY_FILE_RE.test(name)) throw new Error(`Invalid memory file name: ${name}`)
    return name
  }

  // --- internals -------------------------------------------------------------------

  /**
   * The session's effective HF repo id (engineModelId() flattens it at the
   * opencode/engine boundary). The (tier, family) walk itself is ModelService's
   * shared resolveRepoFor — one algorithm for chat/agent/research.
   */
  private resolveRepo(tier: Tier | undefined, family: Family | undefined, tab: AgentTab): string {
    // Each surface honors its own persisted feature default.
    const requested =
      tier ?? this.deps.modelService.overview().defaults[tab === 'code' ? 'code' : 'agent']
    return this.deps.modelService.resolveRepoFor(requested, family)
  }

  private async createOpencodeSession(baseUrl: string, modelId: string): Promise<string> {
    const res = await this.request(baseUrl, 'POST', '/session', {
      model: { providerID: 'crispin', id: modelId }
    })
    if (!res.ok) throw new Error(`opencode session create failed: ${res.status}`)
    const session = (await res.json()) as { id: string }
    return session.id
  }

  private async firePrompt(
    row: AgentSessionRow,
    baseUrl: string,
    modelId: string,
    text: string,
    mode?: PermissionMode
  ): Promise<void> {
    const body = {
      model: { providerID: 'crispin', modelID: modelId },
      // 'plan' is opencode's built-in read-only agent; the other two are ours
      // (opencode-config.ts). Normal omits the field = top-level permissions.
      ...(mode && mode !== 'normal' ? { agent: mode } : {}),
      parts: [{ type: 'text', text }]
    }
    const path = (): string => `/session/${row.opencode_session_id}/prompt_async`
    let res = await this.request(baseUrl, 'POST', path(), body)
    if (res.status === 404) {
      // Sessions survive server restarts (opencode persists them on disk), so a
      // 404 means the storage is gone — recreate transparently and retry once.
      const opencodeId = await this.createOpencodeSession(baseUrl, modelId)
      row.opencode_session_id = opencodeId
      this.deps.db
        .prepare('UPDATE agent_sessions SET opencode_session_id = ? WHERE id = ?')
        .run(opencodeId, row.id)
      res = await this.request(baseUrl, 'POST', path(), body)
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      throw new Error(`opencode prompt failed: ${res.status}${detail ? ` ${detail.slice(0, 200)}` : ''}`)
    }
  }

  private request(baseUrl: string, method: string, path: string, body?: unknown): Promise<Response> {
    return fetch(baseUrl + path, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    })
  }

  private row(sessionId: string): AgentSessionRow {
    const row = this.rowOrNull(sessionId)
    if (!row) throw new Error(`No such agent session: ${sessionId}`)
    return row
  }

  private rowOrNull(sessionId: string): AgentSessionRow | null {
    const row = this.deps.db
      .prepare('SELECT * FROM agent_sessions WHERE id = ?')
      .get(sessionId) as unknown as AgentSessionRow | undefined
    return row ?? null
  }

  // --- SSE bridge -------------------------------------------------------------------

  private onPoolEvent(directory: string, event: unknown): void {
    // Live SSE traffic counts as use, so a mid-turn server never idles out.
    this.deps.pool.touch(directory)
    const opencodeId = extractSessionId(event)
    if (!opencodeId) return
    const row = this.deps.db
      .prepare('SELECT * FROM agent_sessions WHERE opencode_session_id = ?')
      .get(opencodeId) as unknown as AgentSessionRow | undefined
    if (!row) return

    const type = (event as { type?: unknown }).type
    const props = (event as { properties?: Record<string, unknown> }).properties

    if (type === 'session.updated') {
      const info = props?.info as { title?: unknown } | undefined
      const title = typeof info?.title === 'string' ? info.title : null
      if (title && title !== row.title) {
        this.deps.db.prepare('UPDATE agent_sessions SET title = ? WHERE id = ?').run(title, row.id)
      }
    }

    this.deps.broadcast({ type: 'agent.event', sessionId: row.id, tab: row.tab, event })
    this.emitSessionEvent(row.id, event)
    // Live 1.16.2 emits 'permission.asked' with properties = the permission
    // object ({id: 'per_…', sessionID, permission, patterns, metadata, …}).
    // The id guard excludes 'permission.replied' (whose properties carry no
    // id), which would otherwise enqueue a ghost ask after every reply.
    if (typeof type === 'string' && type.includes('permission') && typeof props?.id === 'string') {
      // Mode auto-replies (belt and braces over the per-agent config): a
      // handled ask never reaches the renderer.
      const mode = this.modeBySession.get(row.id) ?? 'normal'
      const kind = String(props.permission ?? props.type ?? '')
      const isEdit = kind.includes('edit')
      const autoReply: 'once' | 'reject' | null =
        mode === 'auto'
          ? 'once'
          : mode === 'acceptEdits' && isEdit
            ? 'once'
            : mode === 'plan' && isEdit
              ? 'reject'
              : null
      if (autoReply) {
        this.log.info(`${mode} mode auto-${autoReply === 'once' ? 'allows' : 'rejects'} ${kind || 'ask'} ${props.id}`)
        void this.permissionReply(row.id, props.id, autoReply).catch((err) => {
          this.log.warn(`auto-reply failed: ${err instanceof Error ? err.message : err}`)
        })
        return
      }
      this.deps.broadcast({
        type: 'agent.permissionRequest',
        sessionId: row.id,
        tab: row.tab,
        request: props
      })
    }
  }
}

/**
 * Every 1.16.2 event observed live carries properties.sessionID directly; the
 * .part / .info fallbacks cover the shapes the SDK types still describe.
 */
function extractSessionId(event: unknown): string | null {
  if (typeof event !== 'object' || event === null) return null
  const props = (event as { properties?: unknown }).properties
  if (typeof props !== 'object' || props === null) return null
  const p = props as Record<string, unknown>
  if (typeof p.sessionID === 'string') return p.sessionID
  const part = p.part as { sessionID?: unknown } | undefined
  if (typeof part?.sessionID === 'string') return part.sessionID
  const info = p.info as { sessionID?: unknown; id?: unknown } | undefined
  if (typeof info?.sessionID === 'string') return info.sessionID
  if (typeof info?.id === 'string' && info.id.startsWith('ses')) return info.id
  return null
}
