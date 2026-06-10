import { createParser } from 'eventsource-parser'
import type { EngineModelInfo, EngineModelState } from '@shared/types'

// --- OpenAI chat wire shapes (this client owns them) -------------------------

export type ChatContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }

export interface WireToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

export interface ChatCompletionMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | ChatContentPart[] | null
  tool_calls?: WireToolCall[]
  tool_call_id?: string
}

export interface ChatToolDef {
  type: 'function'
  function: { name: string; description?: string; parameters?: Record<string, unknown> }
}

export type ChatStreamEvent =
  /** Raw content delta — family parsing (gemma thought channel) happens upstream. */
  | { type: 'content'; text: string }
  /** Models that stream a separate reasoning channel (none observed yet — defensive). */
  | { type: 'reasoning'; text: string }
  | {
      type: 'done'
      finishReason: string | null
      /** Accumulated per OpenAI index-keyed deltas; complete when emitted. */
      toolCalls: WireToolCall[]
      tokensIn: number | null
      tokensOut: number | null
    }

export interface StreamChatOptions {
  model: string
  messages: ChatCompletionMessage[]
  tools?: ChatToolDef[]
  maxTokens?: number
  temperature?: number
  signal?: AbortSignal
}

interface StreamChunk {
  choices?: Array<{
    delta?: {
      content?: string | null
      reasoning_content?: string | null
      tool_calls?: Array<{
        index?: number
        id?: string
        function?: { name?: string; arguments?: string }
      }>
    }
    finish_reason?: string | null
  }>
  usage?: { prompt_tokens?: number; completion_tokens?: number } | null
}

/** No chunk for this long means a wedged stream, not a slow model — bail out. */
const STREAM_INACTIVITY_MS = 300_000

/** One entry of /v1/status model_manager.models in registry mode. */
interface RegistryModelEntry {
  id: string
  status?: EngineModelState
  loaded?: boolean
  owned_by?: string
  source?: string
  memory_gb?: number | null
}

interface StatusResponse {
  status?: string
  num_running?: number
  model_manager?: {
    memory_budget_gb?: number
    models?: RegistryModelEntry[]
  }
}

/** Typed client for the vllm-mlx engine sidecar (OpenAI-compatible). */
export class EngineClient {
  /**
   * Generation requests in flight through THIS client. Registry-mode
   * /v1/status hides per-request state, and main owns all engine traffic in
   * M1/M2 — so this counter is the idleness signal restart decisions and the
   * supervisor's busy() hook rely on. Status/models probes (GETs) don't count.
   */
  private inflightCount = 0

  get inflight(): number {
    return this.inflightCount
  }

  constructor(private readonly baseUrl: () => string) {}

  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    timeoutMs = 10_000
  ): Promise<T> {
    if (method === 'POST') this.inflightCount += 1
    try {
      const res = await fetch(`${this.baseUrl()}${path}`, {
        method,
        headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs)
      })
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw new Error(`engine ${method} ${path} → ${res.status}: ${text.slice(0, 300)}`)
      }
      return (await res.json()) as T
    } finally {
      if (method === 'POST') this.inflightCount -= 1
    }
  }

  /**
   * Registry state of every configured model — from /v1/status, because the
   * /v1/models route strips everything but the id. Tolerates the single-model
   * shape (no model_manager) by reporting the active model as loaded.
   */
  async models(): Promise<EngineModelInfo[]> {
    const res = await this.request<StatusResponse & { model?: string }>('GET', '/v1/status')
    if (res.model_manager?.models) {
      return res.model_manager.models.map((m) => ({
        id: m.id,
        state: m.status ?? (m.loaded ? 'loaded' : 'unloaded'),
        memoryGB: typeof m.memory_gb === 'number' ? m.memory_gb : null
      }))
    }
    return res.model ? [{ id: res.model, state: 'loaded', memoryGB: null }] : []
  }

  /** Liveness subset — used to avoid restarting mid-generation. */
  async status(): Promise<{ running: boolean; numRunning: number }> {
    const res = await this.request<StatusResponse>('GET', '/v1/status')
    return {
      running: res.status === 'running',
      numRunning: Math.max(res.num_running ?? 0, this.inflightCount)
    }
  }

  /**
   * Streaming chat completion. Yields raw deltas; tool calls are accumulated
   * (index-keyed, arguments appended) and delivered complete on 'done'.
   * Counts against the same inflight counter as request() — busy() health
   * suppression and the idle-unload timer depend on every generation passing
   * through it. The finally block keeps the counter balanced on abort/throw,
   * including a consumer abandoning the iterator (generator return()).
   */
  async *streamChat(opts: StreamChatOptions): AsyncGenerator<ChatStreamEvent, void, void> {
    this.inflightCount += 1
    // First token can be minutes away (cold model load blocks the event loop),
    // so there is no overall timeout — only inactivity between chunks.
    const inactivity = new AbortController()
    let inactivityTimer = setTimeout(() => inactivity.abort(), STREAM_INACTIVITY_MS)
    try {
      const signals = [inactivity.signal, ...(opts.signal ? [opts.signal] : [])]
      const res = await fetch(`${this.baseUrl()}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: opts.model,
          messages: opts.messages,
          tools: opts.tools?.length ? opts.tools : undefined,
          max_tokens: opts.maxTokens,
          temperature: opts.temperature,
          stream: true
        }),
        signal: AbortSignal.any(signals)
      })
      if (!res.ok || !res.body) {
        const text = await res.text().catch(() => '')
        throw new Error(`engine POST /v1/chat/completions → ${res.status}: ${text.slice(0, 300)}`)
      }

      const toolCalls = new Map<number, WireToolCall>()
      let finishReason: string | null = null
      let tokensIn: number | null = null
      let tokensOut: number | null = null
      let sawDone = false

      const dataQueue: string[] = []
      const parser = createParser({ onEvent: (event) => dataQueue.push(event.data) })
      const reader = res.body.getReader()
      const decoder = new TextDecoder()

      while (!sawDone) {
        const { done, value } = await reader.read()
        if (done) break
        clearTimeout(inactivityTimer)
        inactivityTimer = setTimeout(() => inactivity.abort(), STREAM_INACTIVITY_MS)
        parser.feed(decoder.decode(value, { stream: true }))

        while (dataQueue.length > 0) {
          const data = dataQueue.shift()!
          if (data === '[DONE]') {
            sawDone = true
            break
          }
          let chunk: StreamChunk
          try {
            chunk = JSON.parse(data) as StreamChunk
          } catch {
            continue // tolerate a malformed SSE line rather than killing the stream
          }
          if (chunk.usage) {
            tokensIn = chunk.usage.prompt_tokens ?? tokensIn
            tokensOut = chunk.usage.completion_tokens ?? tokensOut
          }
          const choice = chunk.choices?.[0]
          if (!choice) continue
          if (choice.finish_reason) finishReason = choice.finish_reason
          const delta = choice.delta
          if (!delta) continue
          if (delta.content) yield { type: 'content', text: delta.content }
          if (delta.reasoning_content) yield { type: 'reasoning', text: delta.reasoning_content }
          for (const tc of delta.tool_calls ?? []) {
            const index = tc.index ?? 0
            const existing = toolCalls.get(index)
            if (existing) {
              if (tc.id) existing.id = tc.id
              if (tc.function?.name) existing.function.name = tc.function.name
              existing.function.arguments += tc.function?.arguments ?? ''
            } else {
              toolCalls.set(index, {
                id: tc.id ?? `call_${index}`,
                type: 'function',
                function: { name: tc.function?.name ?? '', arguments: tc.function?.arguments ?? '' }
              })
            }
          }
        }
      }

      yield {
        type: 'done',
        finishReason,
        toolCalls: [...toolCalls.entries()].sort(([a], [b]) => a - b).map(([, c]) => c),
        tokensIn,
        tokensOut
      }
    } catch (err) {
      // Surface the user's abort untouched; translate ours into something readable.
      if (inactivity.signal.aborted && !opts.signal?.aborted) {
        throw new Error(`engine stream stalled for ${STREAM_INACTIVITY_MS / 1000}s`)
      }
      throw err
    } finally {
      clearTimeout(inactivityTimer)
      this.inflightCount -= 1
    }
  }

  /**
   * "Load" a model: in registry mode the first request naming a model makes
   * the manager load it (evicting idle models if the budget demands it).
   * Generous timeout — a cold load pages weights in from disk.
   */
  async warm(modelId: string): Promise<void> {
    await this.request(
      'POST',
      '/v1/chat/completions',
      {
        model: modelId,
        messages: [{ role: 'user', content: 'Hi' }],
        max_tokens: 1,
        stream: false
      },
      300_000
    )
  }
}
