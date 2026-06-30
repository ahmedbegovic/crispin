import { describe, expect, it, vi } from 'vitest'
import type { CrispinEvent } from '@shared/ipc'
import type { ChatMessage, Conversation } from '@shared/types'
import { ChatOrchestrator, type ChatOrchestratorDeps } from './orchestrator'

const h = vi.hoisted(() => ({
  warn: vi.fn(),
  error: vi.fn()
}))

vi.mock('../paths', () => ({
  dataDir: () => '/tmp/crispin-orchestrator-model-load-test'
}))

vi.mock('../logger', () => ({
  scopedLogger: () => ({ info: () => {}, warn: h.warn, error: h.error })
}))

vi.mock('../llm-trace', () => ({
  traceLlm: vi.fn()
}))

const MODEL_ID = 'mlx-community/Qwen3.5-2B-4bit'

const conversation: Conversation = {
  id: 'conversation-1',
  title: 'Pinned title',
  systemPrompt: null,
  headMessageId: 'assistant-1',
  defaultTier: 'low',
  tierPinned: false,
  family: null,
  collectionId: null,
  webEnabled: false,
  archived: false,
  pinned: false,
  sampling: null,
  createdAt: 1,
  updatedAt: 1
}

const userMessage: ChatMessage = {
  id: 'user-1',
  conversationId: conversation.id,
  parentId: null,
  role: 'user',
  parts: [{ type: 'text', text: 'Hello' }],
  modelId: null,
  tokensIn: null,
  tokensOut: null,
  ttftMs: null,
  genMs: null,
  createdAt: 1,
  siblingIndex: 0,
  siblingCount: 1,
  siblingIds: ['user-1']
}

async function* answerStream() {
  yield { type: 'content' as const, text: 'ok' }
  yield {
    type: 'done' as const,
    finishReason: 'stop',
    toolCalls: [],
    tokensIn: 3,
    tokensOut: 1
  }
}

function harness(isResident: boolean) {
  const broadcast = vi.fn<(event: CrispinEvent) => void>()
  const modelService = {
    isResident: vi.fn(() => isResident),
    ensureLoaded: vi.fn(async () => {}),
    contextLengthFor: vi.fn(() => 131072),
    samplingFor: vi.fn(() => null),
    refreshEngineModels: vi.fn(async () => {}),
    overview: vi.fn(() => ({
      engine: { running: true, budgetGB: 18.5, models: [{ id: MODEL_ID, state: 'loaded', memoryGB: 3 }] },
      installed: [],
      downloads: [],
      tiers: [],
      defaults: { chat: 'low', agent: 'low', code: 'low', research: 'low', news: 'low' },
      tierSelections: {},
      defaultFamily: 'qwen',
      ram: { totalGB: 24, freeGB: 10, availableGB: 10, budgetGB: 18.5, loadedGB: 3 }
    }))
  }
  const deps = {
    db: { prepare: () => ({ get: () => undefined }) },
    repo: {
      getConversation: vi.fn(() => conversation),
      activePath: vi.fn(() => [userMessage]),
      updateParts: vi.fn()
    },
    engine: {
      streamChat: vi.fn(() => answerStream())
    },
    tools: {},
    modelService,
    mcp: { toolDefsFor: vi.fn(async () => []) },
    skills: { list: vi.fn(() => []) },
    library: {
      embeddingsUrl: vi.fn(() => 'http://127.0.0.1:1/v1/embeddings'),
      lancedbDir: vi.fn(() => '/tmp/crispin-orchestrator-model-load-test/lancedb')
    },
    appSettings: {
      get: vi.fn(() => ({
        profile: { userName: '', assistantName: '' },
        instructions: { global: '', perModule: { chat: '' } }
      }))
    },
    broadcast
  } as unknown as ChatOrchestratorDeps

  return { orchestrator: new ChatOrchestrator(deps), broadcast, modelService }
}

async function runGeneration(orchestrator: ChatOrchestrator): Promise<void> {
  await (
    orchestrator as unknown as {
      run(ctx: {
        conversationId: string
        assistantMessageId: string
        modelId: string
        family: 'qwen'
        controller: AbortController
      }): Promise<void>
    }
  ).run({
    conversationId: conversation.id,
    assistantMessageId: 'assistant-1',
    modelId: MODEL_ID,
    family: 'qwen',
    controller: new AbortController()
  })
}

function modelLoadEvents(broadcast: ReturnType<typeof vi.fn<(event: CrispinEvent) => void>>) {
  return broadcast.mock.calls
    .map(([event]) => event)
    .filter((event) => event.type === 'chat.modelLoad')
}

describe('ChatOrchestrator model load events', () => {
  it('broadcasts loading then ready around a cold model load', async () => {
    const { orchestrator, broadcast, modelService } = harness(false)

    await runGeneration(orchestrator)

    expect(modelService.isResident).toHaveBeenCalledWith(MODEL_ID)
    expect(modelService.ensureLoaded).toHaveBeenCalledWith(MODEL_ID)
    expect(modelLoadEvents(broadcast)).toEqual([
      {
        type: 'chat.modelLoad',
        conversationId: conversation.id,
        messageId: 'assistant-1',
        modelId: MODEL_ID,
        phase: 'loading'
      },
      {
        type: 'chat.modelLoad',
        conversationId: conversation.id,
        messageId: 'assistant-1',
        modelId: MODEL_ID,
        phase: 'ready'
      }
    ])
  })

  it('does not broadcast model load events when the model is already resident', async () => {
    const { orchestrator, broadcast, modelService } = harness(true)

    await runGeneration(orchestrator)

    expect(modelService.isResident).toHaveBeenCalledWith(MODEL_ID)
    expect(modelService.ensureLoaded).toHaveBeenCalledWith(MODEL_ID)
    expect(modelLoadEvents(broadcast)).toEqual([])
  })
})
