import { create } from 'zustand'
import type {
  AttachmentInput,
  ChatMessage,
  Conversation,
  ConversationMeta,
  MessagePart,
  ModelSampling,
  Tier
} from '@shared/types'
import type { CrispinEventOf } from '@shared/ipc'
import { call, onEvent } from '@/lib/ipc'
import { pushToast } from '@/stores/toasts'
import { friendlyError } from '@/lib/friendlyError'

export interface ToolPhaseInfo {
  phase: 'start' | 'result' | 'error'
  detail?: string
}

export interface ConversationPatch {
  title?: string
  systemPrompt?: string | null
  /** A tier pins the conversation; null un-pins (follow featureDefaults.chat). */
  defaultTier?: Tier | null
  collectionId?: string | null
  webEnabled?: boolean
  archived?: boolean
  /** Favorite flag — pinned conversations sort to the top. */
  pinned?: boolean
  /** Per-conversation sampling override; null = follow the model's defaults. */
  sampling?: ModelSampling | null
}

/** One-shot regeneration steers: escalate the tier, and/or bias length/tone. */
export interface RegenerateOptions {
  tier?: Tier
  lengthHint?: 'shorter' | 'longer'
  toneHint?: 'formal' | 'casual'
}

/** Mirror main's tier-pin semantics for the optimistic conversation merge. */
function applyPatch(conversation: Conversation, patch: ConversationPatch): Conversation {
  const { defaultTier, ...rest } = patch
  const next = { ...conversation, ...rest }
  if (defaultTier !== undefined) {
    if (defaultTier === null) next.tierPinned = false
    else {
      next.defaultTier = defaultTier
      next.tierPinned = true
    }
  }
  return next
}

interface ChatStore {
  conversations: ConversationMeta[]
  showArchived: boolean
  activeId: string | null
  conversationById: Record<string, Conversation>
  /** Active path root→head per conversation; only loaded conversations have an entry. */
  messagesById: Record<string, ChatMessage[]>
  /** conversationId -> streaming assistant message id ('' until chat.send resolves). */
  streaming: Record<string, string>
  toolPhases: Record<string, ToolPhaseInfo>
  /** conversationId -> error from the last chat.done; cleared on the next send. */
  lastError: Record<string, string>
  /** conversationId -> the send that failed before any reply, so Retry can resend it. */
  lastFailedSend: Record<string, { text: string; attachments?: AttachmentInput[]; tier?: Tier }>
  /** conversationId -> tokens used vs the tier's context window (donut data). */
  usage: Record<string, { used: number; contextLength: number | null }>
  /** messageId -> user's manual activity-bubble expand state (survives Virtuoso unmount). */
  activityOpen: Record<string, boolean>
  /** messageIds whose generation the user stopped this session (for the "stopped" marker). */
  stoppedIds: Record<string, true>
  initialized: boolean
  init: () => Promise<void>
  refreshList: () => Promise<void>
  refreshConversation: (conversationId: string) => Promise<void>
  setShowArchived: (show: boolean) => Promise<void>
  select: (conversationId: string) => Promise<void>
  create: () => Promise<void>
  send: (
    conversationId: string,
    text: string,
    attachments?: AttachmentInput[],
    tier?: Tier
  ) => Promise<void>
  abort: (conversationId: string) => Promise<void>
  regenerate: (
    conversationId: string,
    messageId: string,
    options?: RegenerateOptions
  ) => Promise<void>
  editResend: (conversationId: string, messageId: string, text: string) => Promise<void>
  switchSibling: (
    conversationId: string,
    message: ChatMessage,
    direction: -1 | 1
  ) => Promise<void>
  update: (conversationId: string, patch: ConversationPatch) => Promise<void>
  remove: (conversationId: string) => Promise<void>
  clearError: (conversationId: string) => void
  retryLast: (conversationId: string) => Promise<void>
  setActivityOpen: (messageId: string, open: boolean) => void
}

// chat.get returns only the active path, but every message carries its full
// sibling id list in branch order — the registry mirrors it per (conversation,
// parent) so the BranchSwitcher can target any branch, visited or not.
const siblingRegistry = new Map<string, (string | undefined)[]>()

function rememberSiblings(messages: ChatMessage[]): void {
  for (const m of messages) {
    const key = `${m.conversationId}:${m.parentId ?? 'root'}`
    if (m.siblingIds.length > 0) {
      siblingRegistry.set(key, m.siblingIds.slice())
      continue
    }
    // Locally-constructed stubs carry no sibling ids — fill the known slot.
    const slots = siblingRegistry.get(key) ?? []
    slots[m.siblingIndex] = m.id
    siblingRegistry.set(key, slots)
  }
}

// tokensIn of an assistant message is the prompt size of that generation, i.e.
// the whole-conversation context at that point — the latest one is the donut's
// numerator.
function usageFromMessages(
  messages: ChatMessage[],
  contextLength: number | null
): { used: number; contextLength: number | null } | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role === 'assistant' && m.tokensIn !== null)
      return { used: m.tokensIn + (m.tokensOut ?? 0), contextLength }
  }
  return null
}

/** Merge a chat.get / switchBranch view into per-conversation state: the object,
 *  its active path, and the usage donut. A null contextLength from main (model
 *  momentarily unresolvable) never erases a known denominator. */
function mergeView(
  s: ChatStore,
  conversationId: string,
  view: { conversation: Conversation; messages: ChatMessage[]; contextLength: number | null }
): Partial<ChatStore> {
  const entry = usageFromMessages(
    view.messages,
    view.contextLength ?? s.usage[conversationId]?.contextLength ?? null
  )
  const { [conversationId]: _omit, ...usage } = s.usage
  return {
    conversationById: { ...s.conversationById, [conversationId]: view.conversation },
    messagesById: { ...s.messagesById, [conversationId]: view.messages },
    usage: entry ? { ...usage, [conversationId]: entry } : usage
  }
}

function assistantStub(
  conversationId: string,
  id: string,
  parentId: string | null
): ChatMessage {
  return {
    id,
    conversationId,
    parentId,
    role: 'assistant',
    parts: [],
    modelId: null,
    tokensIn: null,
    tokensOut: null,
    ttftMs: null,
    genMs: null,
    createdAt: Date.now(),
    siblingIndex: 0,
    siblingCount: 1,
    siblingIds: []
  }
}

function applyDelta(message: ChatMessage, event: CrispinEventOf<'chat.delta'>): ChatMessage {
  const parts = message.parts.slice()
  const existing = parts[event.partIndex]
  if (
    event.append &&
    existing &&
    (existing.type === 'text' || existing.type === 'thought') &&
    event.part.type === existing.type
  ) {
    parts[event.partIndex] = { ...existing, text: existing.text + event.part.text }
  } else {
    // Insert/replace; pad if a part index ever arrives ahead of its predecessors.
    while (parts.length < event.partIndex) parts.push({ type: 'text', text: '' })
    parts[event.partIndex] = event.part
  }
  return { ...message, parts }
}

/** Optimistic mime guess for image parts; main re-derives the real one. */
function mimeFor(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? ''
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg'
  if (ext === 'png' || ext === 'webp' || ext === 'gif') return `image/${ext}`
  return 'application/octet-stream'
}

function fileName(path: string): string {
  return path.split('/').pop() ?? path
}

export const useChatStore = create<ChatStore>((set, get) => ({
  conversations: [],
  showArchived: false,
  activeId: null,
  conversationById: {},
  messagesById: {},
  streaming: {},
  toolPhases: {},
  lastError: {},
  lastFailedSend: {},
  usage: {},
  activityOpen: {},
  stoppedIds: {},
  initialized: false,

  init: async () => {
    if (get().initialized) return
    set({ initialized: true })

    onEvent('chat.delta', (event) => {
      set((s) => {
        const messages = s.messagesById[event.conversationId]
        if (!messages) return {}
        let found = false
        let next = messages.map((m) => {
          if (m.id !== event.messageId) return m
          found = true
          return applyDelta(m, event)
        })
        if (!found) {
          // Delta beat the chat.send response — stream into a stub until reconciled.
          const parentId = messages[messages.length - 1]?.id ?? null
          next = [
            ...messages,
            applyDelta(assistantStub(event.conversationId, event.messageId, parentId), event)
          ]
        }
        return { messagesById: { ...s.messagesById, [event.conversationId]: next } }
      })
    })

    onEvent('chat.toolEvent', (event) => {
      set((s) => ({
        toolPhases: {
          ...s.toolPhases,
          [event.toolCallId]: { phase: event.phase, detail: event.detail }
        }
      }))
    })

    onEvent('chat.done', (event) => {
      set((s) => {
        const { [event.conversationId]: _, ...streaming } = s.streaming
        return {
          streaming,
          stoppedIds: event.aborted
            ? { ...s.stoppedIds, [event.messageId]: true as const }
            : s.stoppedIds,
          lastError:
            event.error !== null
              ? { ...s.lastError, [event.conversationId]: event.error }
              : s.lastError,
          usage:
            !event.aborted && event.tokensIn !== null
              ? {
                  ...s.usage,
                  [event.conversationId]: {
                    used: event.tokensIn + (event.tokensOut ?? 0),
                    // A null contextLength here just means main couldn't resolve
                    // the model this time — keep the last known denominator.
                    contextLength:
                      event.contextLength ?? s.usage[event.conversationId]?.contextLength ?? null
                  }
                }
              : s.usage
        }
      })
      if (event.error !== null && !event.aborted) pushToast('error', friendlyError(event.error))
      // Reconcile with what main persisted: sibling counts, attachment parts, usage.
      void get()
        .refreshConversation(event.conversationId)
        .catch(() => {})
      void get()
        .refreshList()
        .catch(() => {})
    })

    onEvent('models.installedChanged', () => {
      // On a cold start the views can arrive while main's first cache scan is
      // still running, leaving every donut denominator null — re-pull loaded
      // views once the installed set actually lands.
      for (const id of Object.keys(get().messagesById)) {
        void get()
          .refreshConversation(id)
          .catch(() => {})
      }
    })

    onEvent('chat.titleChanged', (event) => {
      set((s) => ({
        conversations: s.conversations.map((c) =>
          c.id === event.conversationId ? { ...c, title: event.title } : c
        ),
        conversationById: s.conversationById[event.conversationId]
          ? {
              ...s.conversationById,
              [event.conversationId]: {
                ...s.conversationById[event.conversationId],
                title: event.title
              }
            }
          : s.conversationById
      }))
    })

    await get().refreshList()
    const first = get().conversations[0]
    if (first && get().activeId === null) await get().select(first.id)
  },

  refreshList: async () => {
    const { conversations } = await call(
      'chat.list',
      get().showArchived ? { archived: true } : {}
    )
    set({ conversations })
  },

  refreshConversation: async (conversationId) => {
    if (!get().messagesById[conversationId]) return
    const view = await call('chat.get', { conversationId })
    rememberSiblings(view.messages)
    // Never clobber an in-flight stream with the slower persisted snapshot.
    if (get().streaming[conversationId] !== undefined) return
    set((s) => mergeView(s, conversationId, view))
  },

  setShowArchived: async (show) => {
    set({ showArchived: show })
    await get().refreshList()
  },

  select: async (conversationId) => {
    set({ activeId: conversationId })
    if (get().messagesById[conversationId]) {
      // Quiet refresh keeps branch counts fresh without flashing the thread.
      void get()
        .refreshConversation(conversationId)
        .catch(() => {})
      return
    }
    const view = await call('chat.get', { conversationId })
    rememberSiblings(view.messages)
    set((s) => mergeView(s, conversationId, view))
  },

  create: async () => {
    const { conversation } = await call('chat.create', {})
    set((s) => ({
      conversations: [
        {
          id: conversation.id,
          title: conversation.title,
          archived: conversation.archived,
          pinned: conversation.pinned,
          updatedAt: conversation.updatedAt
        },
        ...s.conversations
      ],
      conversationById: { ...s.conversationById, [conversation.id]: conversation },
      messagesById: { ...s.messagesById, [conversation.id]: [] },
      activeId: conversation.id
    }))
  },

  send: async (conversationId, text, attachments, tier) => {
    // Reject rather than toast-and-return: the Composer clears its draft before
    // calling and restores it only from the rejection path.
    if (conversationId in get().streaming)
      throw new Error('A generation is already running in this conversation')
    const tempId = `pending-${crypto.randomUUID()}`
    const parts: MessagePart[] = []
    if (text) parts.push({ type: 'text', text })
    for (const a of attachments ?? []) {
      // Documents materialize server-side as extracted text parts; show a label
      // part until the chat.done refresh replaces this optimistic message.
      if (a.kind === 'image') parts.push({ type: 'image', path: a.path, mime: mimeFor(a.path) })
      else parts.push({ type: 'text', text: `Attached: ${fileName(a.path)}` })
    }

    set((s) => {
      const { [conversationId]: _, ...lastError } = s.lastError
      const prev = s.messagesById[conversationId] ?? []
      const userMessage: ChatMessage = {
        id: tempId,
        conversationId,
        parentId: prev[prev.length - 1]?.id ?? null,
        role: 'user',
        parts,
        modelId: null,
        tokensIn: null,
        tokensOut: null,
        ttftMs: null,
        genMs: null,
        createdAt: Date.now(),
        siblingIndex: 0,
        siblingCount: 1,
        siblingIds: []
      }
      return {
        lastError,
        streaming: { ...s.streaming, [conversationId]: '' },
        messagesById: { ...s.messagesById, [conversationId]: [...prev, userMessage] }
      }
    })

    try {
      const { messageId, assistantMessageId } = await call('chat.send', {
        conversationId,
        text,
        attachments: attachments && attachments.length > 0 ? attachments : undefined,
        tier
      })
      set((s) => {
        const withRealId = (s.messagesById[conversationId] ?? []).map((m) =>
          m.id === tempId ? { ...m, id: messageId } : m
        )
        const messages = withRealId.some((m) => m.id === assistantMessageId)
          ? withRealId
          : [...withRealId, assistantStub(conversationId, assistantMessageId, messageId)]
        const { [conversationId]: _f, ...lastFailedSend } = s.lastFailedSend
        return {
          messagesById: { ...s.messagesById, [conversationId]: messages },
          lastFailedSend,
          // chat.done may already have cleared the flag on an instant failure.
          streaming:
            conversationId in s.streaming
              ? { ...s.streaming, [conversationId]: assistantMessageId }
              : s.streaming
        }
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      set((s) => {
        const { [conversationId]: _, ...streaming } = s.streaming
        return {
          streaming,
          lastError: { ...s.lastError, [conversationId]: message },
          lastFailedSend: {
            ...s.lastFailedSend,
            [conversationId]: { text, attachments, tier }
          },
          messagesById: {
            ...s.messagesById,
            [conversationId]: (s.messagesById[conversationId] ?? []).filter(
              (m) => m.id !== tempId
            )
          }
        }
      })
      throw err
    }
  },

  abort: async (conversationId) => {
    // chat.done {aborted:true} clears the streaming flag.
    await call('chat.abort', { conversationId })
  },

  regenerate: async (conversationId, messageId, options) => {
    // The optimistic set below would clobber a live streaming entry, and the
    // catch would then erase it — stranding the generation with no Stop button.
    if (conversationId in get().streaming) {
      pushToast('warn', 'A generation is already running in this conversation.')
      return
    }
    set((s) => {
      const { [conversationId]: _, ...lastError } = s.lastError
      return { lastError, streaming: { ...s.streaming, [conversationId]: '' } }
    })
    try {
      const { assistantMessageId } = await call('chat.regenerate', {
        conversationId,
        messageId,
        ...options
      })
      const prev = get().messagesById[conversationId] ?? []
      const index = prev.findIndex((m) => m.id === messageId)
      const target = index === -1 ? undefined : prev[index]
      // A delta may have beaten this response and already created the assistant
      // stub (with streamed parts) — keep those parts instead of an empty stub.
      const existing = prev.find((m) => m.id === assistantMessageId)
      const stub: ChatMessage = {
        ...(existing ?? assistantStub(conversationId, assistantMessageId, target?.parentId ?? null)),
        parentId: target?.parentId ?? existing?.parentId ?? null,
        siblingIndex: target?.siblingCount ?? 0,
        siblingCount: (target?.siblingCount ?? 0) + 1
      }
      rememberSiblings([stub])
      set((s) => {
        const tail = index === -1 ? prev : prev.slice(0, index)
        // A successful regen supersedes any earlier failed send, so retryLast must
        // not later resend that stale input instead of regenerating this turn.
        const { [conversationId]: _lf, ...lastFailedSend } = s.lastFailedSend
        return {
          messagesById: {
            ...s.messagesById,
            [conversationId]: [...tail.filter((m) => m.id !== assistantMessageId), stub]
          },
          lastFailedSend,
          streaming:
            conversationId in s.streaming
              ? { ...s.streaming, [conversationId]: assistantMessageId }
              : s.streaming
        }
      })
    } catch (err) {
      set((s) => {
        const { [conversationId]: _, ...streaming } = s.streaming
        return { streaming }
      })
      throw err
    }
  },

  editResend: async (conversationId, messageId, text) => {
    // Same guard as regenerate: only ever clear a streaming entry this action
    // created itself.
    if (conversationId in get().streaming) {
      pushToast('warn', 'A generation is already running in this conversation.')
      return
    }
    set((s) => {
      const { [conversationId]: _, ...lastError } = s.lastError
      return { lastError, streaming: { ...s.streaming, [conversationId]: '' } }
    })
    try {
      const result = await call('chat.editResend', { conversationId, messageId, text })
      const prev = get().messagesById[conversationId] ?? []
      const index = prev.findIndex((m) => m.id === messageId)
      const target = index === -1 ? undefined : prev[index]
      // Mirror main: preserve the original message's attachments (images +
      // document text parts), replacing only the typed text (first text part),
      // so the optimistic bubble doesn't flash without them before the refresh.
      const editedParts: MessagePart[] = []
      let replacedText = false
      for (const p of target?.parts ?? []) {
        if (p.type === 'text' && !replacedText) {
          editedParts.push({ type: 'text', text })
          replacedText = true
        } else {
          editedParts.push(p)
        }
      }
      if (!replacedText) editedParts.unshift({ type: 'text', text })
      const userMessage: ChatMessage = {
        id: result.messageId,
        conversationId,
        parentId: target?.parentId ?? null,
        role: 'user',
        parts: editedParts,
        modelId: null,
        tokensIn: null,
        tokensOut: null,
        ttftMs: null,
        genMs: null,
        createdAt: Date.now(),
        siblingIndex: target?.siblingCount ?? 0,
        siblingCount: (target?.siblingCount ?? 0) + 1,
        siblingIds: target ? [...target.siblingIds, result.messageId] : []
      }
      // Preserve any parts a delta already streamed into the assistant stub.
      const existing = prev.find((m) => m.id === result.assistantMessageId)
      const stub: ChatMessage = existing
        ? { ...existing, parentId: result.messageId }
        : assistantStub(conversationId, result.assistantMessageId, result.messageId)
      rememberSiblings([userMessage])
      set((s) => {
        const tail = index === -1 ? prev : prev.slice(0, index)
        // Supersedes any earlier failed send (see regenerate) — clear it so a
        // later Retry regenerates this turn rather than resending stale input.
        const { [conversationId]: _lf, ...lastFailedSend } = s.lastFailedSend
        return {
          messagesById: {
            ...s.messagesById,
            [conversationId]: [
              ...tail.filter((m) => m.id !== result.assistantMessageId),
              userMessage,
              stub
            ]
          },
          lastFailedSend,
          streaming:
            conversationId in s.streaming
              ? { ...s.streaming, [conversationId]: result.assistantMessageId }
              : s.streaming
        }
      })
    } catch (err) {
      set((s) => {
        const { [conversationId]: _, ...streaming } = s.streaming
        return { streaming }
      })
      throw err
    }
  },

  switchSibling: async (conversationId, message, direction) => {
    const key = `${conversationId}:${message.parentId ?? 'root'}`
    const targetId = (siblingRegistry.get(key) ?? [])[message.siblingIndex + direction]
    if (!targetId) {
      pushToast('warn', 'That branch has not been visited since the app started.')
      return
    }
    const view = await call('chat.switchBranch', { conversationId, messageId: targetId })
    rememberSiblings(view.messages)
    set((s) => mergeView(s, conversationId, view))
  },

  update: async (conversationId, patch) => {
    // Optimistic: pickers and toggles reflect instantly; revert if main rejects.
    const prevConversation = get().conversationById[conversationId]
    set((s) => ({
      conversationById: prevConversation
        ? { ...s.conversationById, [conversationId]: applyPatch(prevConversation, patch) }
        : s.conversationById,
      conversations: s.conversations.map((c) =>
        c.id === conversationId
          ? {
              ...c,
              ...(patch.title !== undefined ? { title: patch.title } : {}),
              ...(patch.archived !== undefined ? { archived: patch.archived } : {}),
              ...(patch.pinned !== undefined ? { pinned: patch.pinned } : {})
            }
          : c
      )
    }))
    try {
      await call('chat.update', { conversationId, ...patch })
      // Re-assert the optimistic patch: a refreshConversation racing this update
      // (e.g. from a chat.done) can write pre-toggle server state over it between
      // the optimistic set and here, silently reverting a webEnabled/sampling toggle.
      set((s) => ({
        conversationById: s.conversationById[conversationId]
          ? {
              ...s.conversationById,
              [conversationId]: applyPatch(s.conversationById[conversationId], patch)
            }
          : s.conversationById
      }))
      // Archive / pin change which list bucket or order the conversation lands in.
      if (patch.archived !== undefined || patch.pinned !== undefined) await get().refreshList()
      if (patch.defaultTier !== undefined) {
        // The donut denominator tracks the tier's active model — a tier switch
        // changes it without any new generation. Patch ONLY the usage entry so
        // the in-flight-stream guard protecting messages stays untouched.
        const view = await call('chat.get', { conversationId })
        set((s) => {
          const prev = s.usage[conversationId]
          return prev
            ? {
                usage: {
                  ...s.usage,
                  // Keep the last known denominator when main can't resolve the
                  // model this time — same null policy as every other usage write.
                  [conversationId]: {
                    ...prev,
                    contextLength: view.contextLength ?? prev.contextLength ?? null
                  }
                }
              }
            : {}
        })
      }
    } catch (err) {
      // Revert just this conversation's object; re-sync the list from the server
      // rather than restoring a stale full-array snapshot (which would stomp a
      // titleChanged / other update that landed during the in-flight call).
      set((s) => {
        const current = s.conversationById[conversationId]
        return {
          conversationById: prevConversation
            ? {
                ...s.conversationById,
                // Restore the pre-optimistic object but keep a title a concurrent
                // chat.titleChanged may have landed during the in-flight call.
                [conversationId]: {
                  ...prevConversation,
                  title: current?.title ?? prevConversation.title
                }
              }
            : s.conversationById
        }
      })
      void get().refreshList().catch(() => {})
      throw err
    }
  },

  remove: async (conversationId) => {
    await call('chat.delete', { conversationId })
    set((s) => {
      const { [conversationId]: removedMsgs, ...messagesById } = s.messagesById
      const { [conversationId]: _c, ...conversationById } = s.conversationById
      const { [conversationId]: _u, ...usage } = s.usage
      const { [conversationId]: _e, ...lastError } = s.lastError
      const { [conversationId]: _f, ...lastFailedSend } = s.lastFailedSend
      // None of these were evicted before, so they leaked for the whole session.
      // Prune the message-keyed maps for this conversation's messages and the
      // sibling-registry entries under it.
      const msgIds = new Set((removedMsgs ?? []).map((m) => m.id))
      const activityOpen = Object.fromEntries(
        Object.entries(s.activityOpen).filter(([id]) => !msgIds.has(id))
      )
      const stoppedIds = Object.fromEntries(
        Object.entries(s.stoppedIds).filter(([id]) => !msgIds.has(id))
      ) as Record<string, true>
      for (const key of [...siblingRegistry.keys()]) {
        if (key.startsWith(`${conversationId}:`)) siblingRegistry.delete(key)
      }
      return {
        conversations: s.conversations.filter((c) => c.id !== conversationId),
        conversationById,
        messagesById,
        usage,
        lastError,
        lastFailedSend,
        activityOpen,
        stoppedIds,
        activeId: s.activeId === conversationId ? null : s.activeId
      }
    })
    const next = get().conversations[0]
    if (get().activeId === null && next) await get().select(next.id)
  },

  clearError: (conversationId) => {
    set((s) => {
      const { [conversationId]: _, ...lastError } = s.lastError
      return { lastError }
    })
  },

  setActivityOpen: (messageId, open) => {
    set((s) => ({ activityOpen: { ...s.activityOpen, [messageId]: open } }))
  },

  retryLast: async (conversationId) => {
    get().clearError(conversationId)
    // A send that failed before any reply rolled its user turn back out — resend
    // that exact input rather than regenerating an earlier (unrelated) answer.
    const failed = get().lastFailedSend[conversationId]
    if (failed) {
      await get().send(conversationId, failed.text, failed.attachments, failed.tier)
      return
    }
    const messages = get().messagesById[conversationId] ?? []
    const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant')
    if (!lastAssistant) return
    await get().regenerate(conversationId, lastAssistant.id)
  }
}))
