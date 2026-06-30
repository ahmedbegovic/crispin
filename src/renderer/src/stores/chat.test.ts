import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CrispinEvent, CrispinEventType } from '@shared/ipc'
import type { ChatMessage } from '@shared/types'

type EventHandler = (event: CrispinEvent) => void

const ipc = vi.hoisted(() => ({
  call: vi.fn(),
  onEvent: vi.fn(),
  handlers: new Map<string, (event: unknown) => void>()
}))

vi.mock('@/lib/ipc', () => ({
  call: ipc.call,
  onEvent: ipc.onEvent
}))

vi.mock('@/stores/toasts', () => ({
  pushToast: vi.fn()
}))

vi.mock('@/lib/friendlyError', () => ({
  friendlyError: (message: string) => message
}))

import { useChatStore, reconcileMessages } from './chat'

function msg(id: string, text: string): ChatMessage {
  return {
    id,
    conversationId: CONVERSATION_ID,
    parentId: null,
    role: 'assistant',
    parts: [{ type: 'text', text }],
    modelId: null,
    tokensIn: null,
    tokensOut: null,
    ttftMs: null,
    genMs: null,
    createdAt: 1,
    siblingIndex: 0,
    siblingCount: 1,
    siblingIds: [id]
  }
}

const CONVERSATION_ID = 'conversation-1'
const MODEL_ID = 'mlx-community/Qwen3.5-2B-4bit'

function resetStore(): void {
  useChatStore.setState({
    conversations: [],
    showArchived: false,
    activeId: null,
    conversationById: {},
    messagesById: {},
    streaming: {},
    modelLoad: {},
    stopping: {},
    toolPhases: {},
    lastError: {},
    lastFailedSend: {},
    usage: {},
    activityOpen: {},
    stoppedIds: {},
    drafts: {},
    initialized: false
  })
}

async function initStore(): Promise<void> {
  ipc.handlers.clear()
  ipc.onEvent.mockImplementation((type: CrispinEventType, handler: EventHandler) => {
    ipc.handlers.set(type, handler as (event: unknown) => void)
    return () => {}
  })
  ipc.call.mockImplementation(async (method: string) => {
    if (method === 'chat.list') return { conversations: [] }
    throw new Error(`Unexpected IPC call: ${method}`)
  })
  await useChatStore.getState().init()
  ipc.call.mockClear()
}

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason?: unknown) => void
} {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function handler(type: CrispinEventType): EventHandler {
  const captured = ipc.handlers.get(type)
  expect(captured).toBeDefined()
  return captured as EventHandler
}

beforeEach(async () => {
  vi.clearAllMocks()
  resetStore()
  await initStore()
})

describe('useChatStore abort', () => {
  it('clears stopping when abort resolves without aborting anything', async () => {
    useChatStore.setState({ streaming: { [CONVERSATION_ID]: 'assistant-1' }, stopping: {} })
    const result = deferred<{ ok: boolean }>()
    ipc.call.mockReturnValue(result.promise)

    const abort = useChatStore.getState().abort(CONVERSATION_ID)

    expect(useChatStore.getState().stopping[CONVERSATION_ID]).toBe(true)
    result.resolve({ ok: false })
    await abort

    expect(ipc.call).toHaveBeenCalledWith('chat.abort', { conversationId: CONVERSATION_ID })
    expect(useChatStore.getState().stopping[CONVERSATION_ID]).toBeUndefined()
  })

  it('rolls back stopping when abort rejects', async () => {
    useChatStore.setState({ streaming: { [CONVERSATION_ID]: 'assistant-1' }, stopping: {} })
    const result = deferred<{ ok: boolean }>()
    ipc.call.mockReturnValue(result.promise)

    const abort = useChatStore.getState().abort(CONVERSATION_ID)

    expect(useChatStore.getState().stopping[CONVERSATION_ID]).toBe(true)
    result.reject(new Error('abort failed'))
    await expect(abort).rejects.toThrow('abort failed')

    expect(ipc.call).toHaveBeenCalledWith('chat.abort', { conversationId: CONVERSATION_ID })
    expect(useChatStore.getState().stopping[CONVERSATION_ID]).toBeUndefined()
  })
})

describe('useChatStore chat events', () => {
  it('tracks model load state until the ready event', () => {
    const modelLoad = handler('chat.modelLoad')

    modelLoad({
      type: 'chat.modelLoad',
      conversationId: CONVERSATION_ID,
      messageId: 'assistant-1',
      modelId: MODEL_ID,
      phase: 'loading'
    })

    expect(useChatStore.getState().modelLoad[CONVERSATION_ID]).toEqual({
      modelId: MODEL_ID,
      startedAt: expect.any(Number)
    })

    modelLoad({
      type: 'chat.modelLoad',
      conversationId: CONVERSATION_ID,
      messageId: 'assistant-1',
      modelId: MODEL_ID,
      phase: 'ready'
    })

    expect(useChatStore.getState().modelLoad[CONVERSATION_ID]).toBeUndefined()
  })

  it('clears model load and stopping state when chat finishes', () => {
    useChatStore.setState({
      modelLoad: { [CONVERSATION_ID]: { modelId: MODEL_ID, startedAt: 1 } },
      stopping: { [CONVERSATION_ID]: true }
    })

    handler('chat.done')({
      type: 'chat.done',
      conversationId: CONVERSATION_ID,
      messageId: 'assistant-1',
      aborted: true,
      error: null,
      tokensIn: null,
      tokensOut: null,
      ttftMs: null,
      genMs: null,
      contextLength: null
    })

    expect(useChatStore.getState().modelLoad[CONVERSATION_ID]).toBeUndefined()
    expect(useChatStore.getState().stopping[CONVERSATION_ID]).toBeUndefined()
  })
})

describe('reconcileMessages', () => {
  it('keeps every previous reference (and the array) when nothing changed', () => {
    const a = msg('a', 'hi')
    const b = msg('b', 'yo')
    const prev = [a, b]
    // Fresh objects with identical content (as a re-fetch produces).
    const out = reconcileMessages(prev, [msg('a', 'hi'), msg('b', 'yo')])
    expect(out).toBe(prev) // same array ref — Virtuoso no-ops, no blink
    expect(out[0]).toBe(a)
    expect(out[1]).toBe(b)
  })

  it('replaces only the changed message and keeps the rest', () => {
    const a = msg('a', 'hi')
    const b = msg('b', 'yo')
    const changedB = msg('b', 'yo — now finished')
    const out = reconcileMessages([a, b], [msg('a', 'hi'), changedB])
    expect(out[0]).toBe(a) // unchanged → previous ref kept
    expect(out[1]).toBe(changedB) // changed → new ref re-renders
  })

  it('returns next when there is no previous list, and on a length change', () => {
    const next = [msg('a', 'hi')]
    expect(reconcileMessages(undefined, next)).toBe(next)
    const a = msg('a', 'hi')
    const grown = reconcileMessages([a], [msg('a', 'hi'), msg('b', 'new')])
    expect(grown).toHaveLength(2)
    expect(grown[0]).toBe(a) // unchanged row still keeps its ref
  })
})
