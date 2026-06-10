import { createParser } from 'eventsource-parser'
import type { EngineModelInfo } from '@shared/types'

/** oMLX flattens HF repo ids into directory-safe ids ('/' → '--'). */
export const engineModelId = (repoId: string): string => repoId.replace('/', '--')

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
  /** Raw content delta — family parsing happens upstream when needed. */
  | { type: 'content'; text: string }
  /** Thinking parsed server-side into the reasoning channel (gemma et al). */
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
  /** Canonical HF repo id; mapped to the engine id internally. */
  model: string
  messages: ChatCompletionMessage[]
  tools?: ChatToolDef[]
  maxTokens?: number
  temperature?: number
  topP?: number
  topK?: number
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

/** One entry of oMLX's /v1/models/status. */
interface ModelStatusEntry {
  id: string
  loaded?: boolean
  is_loading?: boolean
  estimated_size?: number | null
  actual_size?: number | null
  /** Original HF repo id (slash form); absent for built-ins like MarkItDown. */
  source_repo_id?: string | null
}

interface ModelsStatusResponse {
  models?: ModelStatusEntry[]
}

interface ApiStatusResponse {
  status?: string
  active_requests?: number
  waiting_requests?: number
  models_loading?: number
}

/** Typed client for the oMLX engine sidecar (OpenAI-compatible). */
export class EngineClient {
  /**
   * Generation requests in flight through THIS client. Main owns all engine
   * traffic, so this counter is the idleness signal restart decisions and the
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
   * Load state of every discovered model, keyed by the canonical HF repo id.
   * Built-in pseudo-models (no source_repo_id, e.g. MarkItDown) are dropped.
   */
  async models(): Promise<EngineModelInfo[]> {
    const res = await this.request<ModelsStatusResponse>('GET', '/v1/models/status')
    return (res.models ?? [])
      .filter((m) => typeof m.source_repo_id === 'string' && m.source_repo_id.length > 0)
      .map((m) => {
        const bytes = m.loaded ? (m.actual_size ?? m.estimated_size) : null
        return {
          id: m.source_repo_id as string,
          state: m.loaded ? ('loaded' as const) : m.is_loading ? ('loading' as const) : ('unloaded' as const),
          memoryGB: typeof bytes === 'number' ? Math.round((bytes / 1e9) * 100) / 100 : null
        }
      })
  }

  /** Liveness subset — used to avoid restarting mid-generation. */
  async status(): Promise<{ running: boolean; numRunning: number }> {
    const res = await this.request<ApiStatusResponse>('GET', '/api/status')
    // models_loading counts: a request parked inside a lazy cold load (e.g.
    // opencode traffic that bypasses this client) registers in neither
    // active nor waiting, and the cached engineModels snapshot lags by a poll.
    const busy =
      (res.active_requests ?? 0) + (res.waiting_requests ?? 0) + (res.models_loading ?? 0)
    return {
      running: res.status === 'ok',
      numRunning: Math.max(busy, this.inflightCount)
    }
  }

  /**
   * Streaming chat completion. Yields raw deltas; tool calls are accumulated
   * (index-keyed, arguments appended) and delivered complete on 'done'.
   * Counts against the same inflight counter as request() — busy() health
   * suppression depends on every generation passing through it. The finally
   * block keeps the counter balanced on abort/throw, including a consumer
   * abandoning the iterator (generator return()).
   */
  async *streamChat(opts: StreamChatOptions): AsyncGenerator<ChatStreamEvent, void, void> {
    this.inflightCount += 1
    // First token can be minutes away on a cold load, so there is no overall
    // timeout — only inactivity between chunks.
    const inactivity = new AbortController()
    let inactivityTimer = setTimeout(() => inactivity.abort(), STREAM_INACTIVITY_MS)
    try {
      const signals = [inactivity.signal, ...(opts.signal ? [opts.signal] : [])]
      const res = await fetch(`${this.baseUrl()}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: engineModelId(opts.model),
          messages: opts.messages,
          tools: opts.tools?.length ? opts.tools : undefined,
          max_tokens: opts.maxTokens,
          temperature: opts.temperature,
          top_p: opts.topP,
          top_k: opts.topK,
          stream: true,
          // Usage arrives in the final chunk only when asked for.
          stream_options: { include_usage: true }
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

  /** Explicit load — blocks until the model is in memory (cold loads page weights). */
  async warm(repoId: string): Promise<void> {
    await this.request('POST', `/v1/models/${engineModelId(repoId)}/load`, {}, 300_000)
  }

  /** Explicit per-model unload — frees the weights without touching other models. */
  async unloadModel(repoId: string): Promise<void> {
    await this.request('POST', `/v1/models/${engineModelId(repoId)}/unload`, {}, 60_000)
  }
}
