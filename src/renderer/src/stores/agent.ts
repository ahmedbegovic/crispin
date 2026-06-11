import { create } from 'zustand'
import type {
  AgentSessionMeta,
  AgentTab,
  PermissionMode,
  PipelineSnapshot,
  SkillMeta,
  Tier
} from '@shared/types'
import { call, onEvent } from '@/lib/ipc'
import { pushToast } from '@/stores/toasts'

// ---------------------------------------------------------------------------
// Tolerant casts over opencode 1.16.2 payloads. agent.event / agent.get carry
// raw opencode shapes (z.unknown() passthrough) — never trust a field exists.
// ---------------------------------------------------------------------------

export function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
}

export function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

export function permissionIdOf(request: unknown): string | undefined {
  return asString(asRecord(request).id)
}

export type AgentToolStatus = 'pending' | 'running' | 'completed' | 'error'

export interface AgentToolState {
  status?: AgentToolStatus
  input?: unknown
  output?: string
  title?: string
  error?: string
  metadata?: Record<string, unknown>
}

/** Reduced opencode message part — unknown types are kept and skipped at render. */
export interface AgentPart {
  id: string
  type: string
  text?: string
  tool?: string
  state?: AgentToolState
}

export interface AgentMessage {
  id: string
  role: string
  /** info.time.completed landed — the assistant turn is finished. */
  completed: boolean
  /** Flattened info.error; deliberate aborts are omitted. */
  error?: string
  parts: AgentPart[]
}

export interface PermissionAsk {
  sessionId: string
  /** Owning surface — the Agent tab and Code panel each pop only their own asks. */
  tab: AgentTab
  request: unknown
}

export interface MemoryFileMeta {
  name: string
  updatedAt: number
}

export type PermissionReplyKind = 'once' | 'always' | 'reject'

const OPTIMISTIC_PREFIX = 'optimistic-'

function castToolState(raw: unknown): AgentToolState | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const s = raw as Record<string, unknown>
  const status = asString(s.status)
  return {
    status:
      status === 'pending' || status === 'running' || status === 'completed' || status === 'error'
        ? status
        : undefined,
    input: s.input,
    output: asString(s.output),
    title: asString(s.title),
    error: asString(s.error),
    metadata:
      typeof s.metadata === 'object' && s.metadata !== null
        ? (s.metadata as Record<string, unknown>)
        : undefined
  }
}

function castPart(raw: unknown): AgentPart | null {
  const p = asRecord(raw)
  const id = asString(p.id)
  const type = asString(p.type)
  if (!id || !type) return null
  return { id, type, text: asString(p.text), tool: asString(p.tool), state: castToolState(p.state) }
}

function messageFromInfo(info: Record<string, unknown>): AgentMessage | null {
  const id = asString(info.id)
  if (!id) return null
  const error = asRecord(info.error)
  const name = asString(error.name)
  return {
    id,
    role: asString(info.role) ?? 'assistant',
    completed: asRecord(info.time).completed !== undefined,
    // MessageAbortedError is the user's own Stop, not a failure worth a red row.
    error:
      name && name !== 'MessageAbortedError'
        ? (asString(asRecord(error.data).message) ?? name)
        : undefined,
    parts: []
  }
}

/** One agent.get row: {info, parts}. */
function castMessage(raw: unknown): AgentMessage | null {
  const row = asRecord(raw)
  const message = messageFromInfo(asRecord(row.info))
  if (!message) return null
  if (Array.isArray(row.parts)) {
    for (const rawPart of row.parts) {
      const part = castPart(rawPart)
      if (part) message.parts.push(part)
    }
  }
  return message
}

/** Upsert a message.updated info by id; existing parts survive the info refresh. */
function upsertInfo(messages: AgentMessage[], info: Record<string, unknown>): AgentMessage[] {
  const next = messageFromInfo(info)
  if (!next) return messages
  const index = messages.findIndex((m) => m.id === next.id)
  if (index === -1) return [...messages, next]
  return messages.map((m, i) => (i === index ? { ...next, parts: m.parts } : m))
}

/** Upsert a message.part.updated part by id within its messageID's part list. */
function upsertPart(messages: AgentMessage[], rawPart: unknown): AgentMessage[] {
  const part = castPart(rawPart)
  const messageId = asString(asRecord(rawPart).messageID)
  if (!part || !messageId) return messages
  const index = messages.findIndex((m) => m.id === messageId)
  if (index === -1) {
    // Part beat its message.updated — host it in a stub; the info upsert fixes the role.
    return [...messages, { id: messageId, role: 'assistant', completed: false, parts: [part] }]
  }
  return messages.map((m, i) => {
    if (i !== index) return m
    const partIndex = m.parts.findIndex((p) => p.id === part.id)
    return {
      ...m,
      parts:
        partIndex === -1
          ? [...m.parts, part]
          : m.parts.map((p, j) => (j === partIndex ? part : p))
    }
  })
}

function without<T>(record: Record<string, T>, key: string): Record<string, T> {
  const { [key]: _, ...rest } = record
  return rest
}

interface AgentStore {
  /** Sessions of BOTH tabs — each surface filters by `tab`. */
  sessions: AgentSessionMeta[]
  /** Agent-tab selection; the Code panel keeps its own per-workspace pick. */
  activeId: string | null
  /** Reduced opencode timelines; only opened sessions have an entry. */
  messagesBySession: Record<string, AgentMessage[]>
  busyBySession: Record<string, boolean>
  permissionQueue: PermissionAsk[]
  memoryFiles: MemoryFileMeta[]
  skills: SkillMeta[]
  initialized: boolean
  init: () => Promise<void>
  /** Agent-tab eager select of the newest agent session — split from init() so
   *  the Code panel's init never spawns a server for an unrelated directory. */
  selectInitialAgentSession: () => Promise<void>
  refresh: () => Promise<void>
  /** Folder picker -> agent.create -> select. No-op when the picker is cancelled. */
  create: () => Promise<void>
  /** agent.create for a known directory (Code panel); never moves activeId. */
  createIn: (directory: string, tab: AgentTab, tier?: Tier) => Promise<AgentSessionMeta>
  select: (sessionId: string) => Promise<void>
  /** Snapshot-fetch a session's timeline without touching activeId. */
  load: (sessionId: string) => Promise<void>
  prompt: (sessionId: string, text: string, tier?: Tier) => Promise<void>
  /** Per-session permission posture; sent with every prompt. */
  modeBySession: Record<string, PermissionMode>
  setMode: (sessionId: string, mode: PermissionMode) => void
  /** Staged pipeline runs (PipelineBar). */
  pipelineBySession: Record<string, PipelineSnapshot>
  startPipeline: (
    sessionId: string,
    task: string,
    options: { commit: boolean; docs: boolean; permissionMode?: PermissionMode }
  ) => Promise<void>
  abortPipeline: (pipelineId: string) => Promise<void>
  approvePipeline: (pipelineId: string, approve: boolean) => Promise<void>
  refreshPipeline: (sessionId: string) => Promise<void>
  /** Hide a finished pipeline's bar. */
  dismissPipeline: (sessionId: string) => void
  /** Ids hidden via dismissPipeline — main still retains the runs. */
  dismissedPipelineIds: Set<string>
  abort: (sessionId: string) => Promise<void>
  permissionReply: (
    sessionId: string,
    permissionId: string,
    reply: PermissionReplyKind
  ) => Promise<void>
  /** Local pop for malformed asks that carry no id to reply to. */
  dismissPermission: (ask: PermissionAsk) => void
  remove: (sessionId: string) => Promise<void>
  refreshMemory: () => Promise<void>
  readMemory: (name: string) => Promise<string>
  writeMemory: (name: string, content: string) => Promise<void>
  refreshSkills: () => Promise<void>
  setSkillEnabled: (name: string, enabled: boolean) => Promise<void>
}

export const useAgentStore = create<AgentStore>((set, get) => ({
  sessions: [],
  activeId: null,
  messagesBySession: {},
  busyBySession: {},
  permissionQueue: [],
  memoryFiles: [],
  skills: [],
  initialized: false,

  init: async () => {
    if (get().initialized) return
    set({ initialized: true })

    const clearBusy = (sessionId: string): void =>
      set((s) =>
        s.busyBySession[sessionId] ? { busyBySession: without(s.busyBySession, sessionId) } : {}
      )

    onEvent('agent.event', ({ sessionId, event }) => {
      const e = asRecord(event)
      const type = asString(e.type)
      const props = asRecord(e.properties)
      switch (type) {
        case 'message.updated': {
          const info = asRecord(props.info)
          const role = asString(info.role)
          const completed = role === 'assistant' && asRecord(info.time).completed !== undefined
          set((s) => {
            const prev = s.messagesBySession[sessionId]
            // The real user message replaces our optimistic prompt stub.
            const base =
              prev && role === 'user'
                ? prev.filter((m) => !m.id.startsWith(OPTIMISTIC_PREFIX))
                : prev
            return {
              ...(base
                ? { messagesBySession: { ...s.messagesBySession, [sessionId]: upsertInfo(base, info) } }
                : {}),
              ...(completed && s.busyBySession[sessionId]
                ? { busyBySession: without(s.busyBySession, sessionId) }
                : {})
            }
          })
          break
        }
        case 'message.part.updated': {
          set((s) => {
            const messages = s.messagesBySession[sessionId]
            if (!messages) return {}
            return {
              messagesBySession: { ...s.messagesBySession, [sessionId]: upsertPart(messages, props.part) }
            }
          })
          break
        }
        case 'message.removed': {
          const messageId = asString(props.messageID)
          if (!messageId) break
          set((s) => {
            const messages = s.messagesBySession[sessionId]
            if (!messages) return {}
            return {
              messagesBySession: {
                ...s.messagesBySession,
                [sessionId]: messages.filter((m) => m.id !== messageId)
              }
            }
          })
          break
        }
        case 'message.part.removed': {
          const messageId = asString(props.messageID)
          const partId = asString(props.partID)
          if (!messageId || !partId) break
          set((s) => {
            const messages = s.messagesBySession[sessionId]
            if (!messages) return {}
            return {
              messagesBySession: {
                ...s.messagesBySession,
                [sessionId]: messages.map((m) =>
                  m.id === messageId ? { ...m, parts: m.parts.filter((p) => p.id !== partId) } : m
                )
              }
            }
          })
          break
        }
        case 'session.updated': {
          const title = asString(asRecord(props.info).title)
          if (title)
            set((s) => ({
              sessions: s.sessions.map((x) => (x.id === sessionId ? { ...x, title } : x))
            }))
          break
        }
        case 'session.idle':
          clearBusy(sessionId)
          break
        case 'session.status': {
          const statusType = asString(asRecord(props.status).type)
          if (statusType === 'idle') clearBusy(sessionId)
          else if (statusType === 'busy' || statusType === 'retry')
            set((s) => ({ busyBySession: { ...s.busyBySession, [sessionId]: true } }))
          break
        }
        case 'session.error': {
          clearBusy(sessionId)
          const error = asRecord(props.error)
          const name = asString(error.name)
          const message = asString(asRecord(error.data).message) ?? name
          if (message && name !== 'MessageAbortedError') pushToast('error', message)
          break
        }
        case 'permission.replied': {
          // Replied elsewhere (or by main) — drop the stale ask from the queue.
          // opencode versions disagree on the field name: permissionID vs requestID.
          const permissionId = asString(props.permissionID) ?? asString(props.requestID)
          if (permissionId)
            set((s) => ({
              permissionQueue: s.permissionQueue.filter(
                (p) => permissionIdOf(p.request) !== permissionId
              )
            }))
          break
        }
        case 'crispin.promptFailed': {
          // Main's own marker: the fire-and-forget prompt never reached opencode.
          clearBusy(sessionId)
          set((s) => {
            const messages = s.messagesBySession[sessionId]
            if (!messages) return {}
            return {
              messagesBySession: {
                ...s.messagesBySession,
                [sessionId]: messages.filter((m) => !m.id.startsWith(OPTIMISTIC_PREFIX))
              }
            }
          })
          const message =
            asString(e.error) ?? asString(props.error) ?? asString(props.message) ?? 'Prompt failed'
          pushToast('error', message)
          break
        }
        default:
          break // unknown opencode event types are expected — ignore
      }
    })

    onEvent('agent.permissionRequest', ({ sessionId, tab, request }) => {
      // Real asks always carry an id; id-less payloads (e.g. a rebroadcast
      // permission.replied) have nothing to reply to — never queue them.
      const id = permissionIdOf(request)
      if (!id) return
      set((s) => {
        if (s.permissionQueue.some((p) => permissionIdOf(p.request) === id)) return {}
        return { permissionQueue: [...s.permissionQueue, { sessionId, tab, request }] }
      })
    })

    onEvent('pipeline.update', ({ pipeline }) => {
      set((s) =>
        s.dismissedPipelineIds.has(pipeline.id)
          ? {}
          : { pipelineBySession: { ...s.pipelineBySession, [pipeline.sessionId]: pipeline } }
      )
    })

    await get().refresh()
  },

  // select() -> load() -> agent.get spawns the session's opencode server, so
  // only the Agent tab's own mount may run this — never the Code panel's init.
  selectInitialAgentSession: async () => {
    const s = get()
    const first = s.sessions.find((x) => x.tab === 'agent')
    if (first && s.activeId === null) await s.select(first.id)
  },

  refresh: async () => {
    const { sessions } = await call('agent.sessions', {})
    set({ sessions })
  },

  create: async () => {
    const { path } = await call('agent.pickDirectory')
    if (!path) return
    const session = await get().createIn(path, 'agent')
    set({ activeId: session.id })
  },

  createIn: async (directory, tab, tier) => {
    const { session } = await call('agent.create', { directory, tier, tab })
    set((s) => ({
      sessions: [session, ...s.sessions.filter((x) => x.id !== session.id)],
      messagesBySession: { ...s.messagesBySession, [session.id]: [] }
    }))
    return session
  },

  select: async (sessionId) => {
    set({ activeId: sessionId })
    await get().load(sessionId)
  },

  load: async (sessionId) => {
    // Never clobber a live-streaming timeline with a snapshot fetch.
    if (get().busyBySession[sessionId] && get().messagesBySession[sessionId]) return
    const { session, messages } = await call('agent.get', { sessionId })
    const reduced: AgentMessage[] = []
    for (const raw of messages) {
      const message = castMessage(raw)
      if (message) reduced.push(message)
    }
    if (get().busyBySession[sessionId] && get().messagesBySession[sessionId]) return
    set((s) => ({
      sessions: s.sessions.map((x) => (x.id === session.id ? session : x)),
      messagesBySession: { ...s.messagesBySession, [sessionId]: reduced }
    }))
  },

  modeBySession: {},

  setMode: (sessionId, mode) =>
    set((s) => ({ modeBySession: { ...s.modeBySession, [sessionId]: mode } })),

  pipelineBySession: {},

  // Dismissals are renderer-only while main retains finished runs — remember
  // the dismissed ids so refreshPipeline/pipeline.update don't resurrect them.
  dismissedPipelineIds: new Set<string>(),

  startPipeline: async (sessionId, task, options) => {
    if (get().busyBySession[sessionId])
      throw new Error('The agent is already working in this session')
    await call('pipeline.start', { sessionId, task, options })
    await get().refreshPipeline(sessionId)
  },

  abortPipeline: async (pipelineId) => {
    await call('pipeline.abort', { pipelineId })
  },

  approvePipeline: async (pipelineId, approve) => {
    await call('pipeline.approve', { pipelineId, approve })
  },

  refreshPipeline: async (sessionId) => {
    const { pipeline } = await call('pipeline.get', { sessionId })
    set((s) => {
      if (!pipeline || s.dismissedPipelineIds.has(pipeline.id)) {
        const { [sessionId]: _gone, ...rest } = s.pipelineBySession
        return { pipelineBySession: rest }
      }
      return { pipelineBySession: { ...s.pipelineBySession, [sessionId]: pipeline } }
    })
  },

  dismissPipeline: (sessionId) =>
    set((s) => {
      const { [sessionId]: gone, ...pipelineBySession } = s.pipelineBySession
      const dismissedPipelineIds = new Set(s.dismissedPipelineIds)
      if (gone) dismissedPipelineIds.add(gone.id)
      return { pipelineBySession, dismissedPipelineIds }
    }),

  prompt: async (sessionId, text, tier) => {
    // Reject rather than toast: the composer restores its draft from the rejection.
    if (get().busyBySession[sessionId])
      throw new Error('The agent is already working in this session')
    const optimistic: AgentMessage = {
      id: `${OPTIMISTIC_PREFIX}${crypto.randomUUID()}`,
      role: 'user',
      completed: true,
      parts: [{ id: 'text', type: 'text', text }]
    }
    set((s) => ({
      busyBySession: { ...s.busyBySession, [sessionId]: true },
      messagesBySession: {
        ...s.messagesBySession,
        [sessionId]: [...(s.messagesBySession[sessionId] ?? []), optimistic]
      },
      sessions: s.sessions.map((x) =>
        x.id === sessionId ? { ...x, lastUsedAt: Date.now() } : x
      )
    }))
    try {
      await call('agent.prompt', {
        sessionId,
        text,
        tier,
        mode: get().modeBySession[sessionId] ?? 'normal'
      })
    } catch (err) {
      set((s) => ({
        busyBySession: without(s.busyBySession, sessionId),
        messagesBySession: {
          ...s.messagesBySession,
          [sessionId]: (s.messagesBySession[sessionId] ?? []).filter(
            (m) => m.id !== optimistic.id
          )
        }
      }))
      throw err
    }
  },

  abort: async (sessionId) => {
    try {
      await call('agent.abort', { sessionId })
    } finally {
      // session.idle confirms, but never leave the Stop button stranded — even
      // when the abort call fails (dead server means no turn left to clear it).
      // If the turn is in fact still running, session.status re-sets the flag.
      set((s) => ({ busyBySession: without(s.busyBySession, sessionId) }))
    }
  },

  permissionReply: async (sessionId, permissionId, reply) => {
    await call('agent.permissionReply', { sessionId, permissionId, reply })
    set((s) => ({
      permissionQueue: s.permissionQueue.filter(
        (p) => !(p.sessionId === sessionId && permissionIdOf(p.request) === permissionId)
      )
    }))
  },

  dismissPermission: (ask) => {
    set((s) => ({ permissionQueue: s.permissionQueue.filter((p) => p !== ask) }))
  },

  remove: async (sessionId) => {
    await call('agent.delete', { sessionId })
    set((s) => ({
      sessions: s.sessions.filter((x) => x.id !== sessionId),
      messagesBySession: without(s.messagesBySession, sessionId),
      busyBySession: without(s.busyBySession, sessionId),
      permissionQueue: s.permissionQueue.filter((p) => p.sessionId !== sessionId),
      pipelineBySession: without(s.pipelineBySession, sessionId),
      modeBySession: without(s.modeBySession, sessionId),
      activeId: s.activeId === sessionId ? null : s.activeId
    }))
    // activeId is the Agent tab's selection — never refill it with a code session.
    const next = get().sessions.find((x) => x.tab === 'agent')
    if (get().activeId === null && next) await get().select(next.id)
  },

  refreshMemory: async () => {
    const { files } = await call('memory.list')
    set({ memoryFiles: files })
  },

  readMemory: async (name) => {
    const { content } = await call('memory.read', { name })
    return content
  },

  writeMemory: async (name, content) => {
    await call('memory.write', { name, content })
    await get().refreshMemory()
  },

  refreshSkills: async () => {
    const { skills } = await call('skills.list')
    set({ skills })
  },

  setSkillEnabled: async (name, enabled) => {
    // Optimistic toggle; revert if main rejects the symlink change.
    set((s) => ({
      skills: s.skills.map((sk) => (sk.name === name ? { ...sk, agentEnabled: enabled } : sk))
    }))
    try {
      await call('skills.setAgentEnabled', { name, enabled })
    } catch (err) {
      set((s) => ({
        skills: s.skills.map((sk) => (sk.name === name ? { ...sk, agentEnabled: !enabled } : sk))
      }))
      throw err
    }
  }
}))
