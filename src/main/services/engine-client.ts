import { createParser } from 'eventsource-parser'
import type { EngineModelInfo } from '@shared/types'
import {
  checkSidecar,
  engineApiStatusSchema,
  engineDiscoverSchema,
  engineModelsStatusSchema
} from './sidecar-contract'

/** oMLX flattens HF repo ids into directory-safe ids ('/' → '--', all slashes,
 *  matching run_engine.py's engine_model_id so the two never diverge). */
export const engineModelId = (repoId: string): string => repoId.replaceAll('/', '--')

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
  /**
   * OpenAI tool_choice. 'none' keeps the tool defs in the rendered prompt
   * (stable, cacheable prefix) while forbidding calls — used for the
   * post-pipeline synthesis round (verified honored by oMLX). Omit for 'auto'.
   */
  toolChoice?: 'auto' | 'none'
  maxTokens?: number
  temperature?: number
  topP?: number
  topK?: number
  /** OpenAI response_format, e.g. {type:'json_schema', json_schema:{name, schema}}. */
  responseFormat?: unknown
  /**
   * Per-request chat-template kwargs, e.g. {enable_thinking: false} — beats
   * the per-model setting (verified live), so structured calls can reclaim
   * the budget thinking tokens would otherwise burn from max_tokens.
   */
  chatTemplateKwargs?: Record<string, unknown>
  /**
   * Total-request bound for non-streaming chat() only (default 600s); the
   * streaming path ignores it (inactivity detection covers it there).
   * Callers with big output budgets (research synthesis: 8192 tokens on a
   * 12B model under contention) must scale this up — a hard cap that fires
   * mid-decode fails work the old streaming transport finished. Note the
   * request holds an inflight slot the whole time, which also suppresses
   * the wedged-engine auto-restart for that long.
   */
  timeoutMs?: number
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

export interface ChatOnceResult {
  content: string
  reasoning: string | null
  toolCalls: WireToolCall[]
  finishReason: string | null
  tokensIn: number | null
  tokensOut: number | null
  /**
   * RFC-7234 Warning header, set by the engine when a json_schema request
   * silently degraded to prompt injection (no grammar). Null = constrained
   * decoding was honored (live-observed: grammar can still leak a synonym
   * key occasionally — the repair retry covers that — but a non-null value
   * here means xgrammar is missing or broke, which must not go unnoticed).
   */
  warning: string | null
}

interface CompletionResponse {
  choices?: Array<{
    message?: {
      content?: string | null
      reasoning_content?: string | null
      tool_calls?: WireToolCall[]
    }
    finish_reason?: string | null
  }>
  usage?: { prompt_tokens?: number; completion_tokens?: number } | null
}

/** One non-streaming completion, cold load included — generous by design. */
const CHAT_ONCE_TIMEOUT_MS = 600_000

/** No chunk for this long means a wedged stream, not a slow model — bail out. */
const STREAM_INACTIVITY_MS = 300_000

/** A new generation parks at most this long for a lifecycle op (restart/evict) to
 *  release the drain gate before proceeding anyway — a stuck op can't hang chat.
 *  Generous vs a normal restart (the server respawns in seconds; models load lazily
 *  on first request). A restart exceeding it means the engine is failing, and the
 *  un-parked generation then surfaces that as its own connection error. */
const DRAIN_GATE_MS = 30_000

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

  /**
   * Set by ModelService while a lifecycle op (restart / stop / per-model unload)
   * needs the engine drained. New IN-CLIENT generations (chat/agent/research/news)
   * park (see awaitDrainGate) until it clears, so the op runs with nothing in flight
   * AND nothing able to start — the airtight half of the old idle gate, which a
   * sampled status() probe could miss because a generation can begin between the
   * probe and the act. NOTE: opencode talks to the engine directly and bypasses this
   * gate; drained() still WAITS for an in-flight opencode request (via /api/status)
   * but cannot block a NEW one — so the barrier is best-effort for opencode traffic.
   */
  private isDraining = false
  private drainWaiters: Array<() => void> = []

  setDraining(draining: boolean): void {
    this.isDraining = draining
    if (!draining) {
      const waiters = this.drainWaiters
      this.drainWaiters = []
      for (const resolve of waiters) resolve()
    }
  }

  private async awaitDrainGate(): Promise<void> {
    if (!this.isDraining) return
    await Promise.race([
      new Promise<void>((resolve) => this.drainWaiters.push(resolve)),
      new Promise<void>((resolve) => setTimeout(resolve, DRAIN_GATE_MS))
    ])
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
      // Tolerate a 204 / empty 200 (e.g. /load, /unload): res.json() on an empty
      // body throws "Unexpected end of JSON input", turning a success into a
      // generation failure. Callers of no-content endpoints ignore the result.
      const text = await res.text()
      return (text ? JSON.parse(text) : undefined) as T
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
    checkSidecar(engineModelsStatusSchema, res, '/v1/models/status')
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
    checkSidecar(engineApiStatusSchema, res, '/api/status')
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
    await this.awaitDrainGate() // park if a lifecycle op holds the drain gate
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
          tool_choice: opts.tools?.length ? opts.toolChoice : undefined,
          max_tokens: opts.maxTokens,
          temperature: opts.temperature,
          top_p: opts.topP,
          top_k: opts.topK,
          response_format: opts.responseFormat,
          chat_template_kwargs: opts.chatTemplateKwargs,
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

  /**
   * Non-streaming chat completion. Structured calls go through here: the
   * engine only strips fences/thought leaks server-side on the non-streaming
   * path (streaming gets that treatment only when tools are present), so
   * json_schema output arrives clean. Counts toward inflight like every
   * generation; no inactivity signal exists without chunks, so a hard
   * timeout bounds the whole request instead.
   */
  async chat(opts: StreamChatOptions): Promise<ChatOnceResult> {
    await this.awaitDrainGate() // park if a lifecycle op holds the drain gate
    this.inflightCount += 1
    try {
      const signals = [
        AbortSignal.timeout(opts.timeoutMs ?? CHAT_ONCE_TIMEOUT_MS),
        ...(opts.signal ? [opts.signal] : [])
      ]
      const res = await fetch(`${this.baseUrl()}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: engineModelId(opts.model),
          messages: opts.messages,
          tools: opts.tools?.length ? opts.tools : undefined,
          tool_choice: opts.tools?.length ? opts.toolChoice : undefined,
          max_tokens: opts.maxTokens,
          temperature: opts.temperature,
          top_p: opts.topP,
          top_k: opts.topK,
          response_format: opts.responseFormat,
          chat_template_kwargs: opts.chatTemplateKwargs,
          stream: false
        }),
        signal: AbortSignal.any(signals)
      })
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw new Error(`engine POST /v1/chat/completions → ${res.status}: ${text.slice(0, 300)}`)
      }
      const data = (await res.json()) as CompletionResponse
      const choice = data.choices?.[0]
      return {
        content: choice?.message?.content ?? '',
        reasoning: choice?.message?.reasoning_content ?? null,
        toolCalls: choice?.message?.tool_calls ?? [],
        finishReason: choice?.finish_reason ?? null,
        tokensIn: data.usage?.prompt_tokens ?? null,
        tokensOut: data.usage?.completion_tokens ?? null,
        warning: res.headers.get('warning')
      }
    } finally {
      this.inflightCount -= 1
    }
  }

  /**
   * Trigger a live re-scan of the HF cache so freshly downloaded models become
   * servable WITHOUT an engine restart (Crispin's oMLX patch — POST
   * /v1/models/discover). The re-scan is non-destructive: it merges new entries
   * and leaves loaded models in place, so it needs no drain/idle gate and never
   * counts as a generation. Optional `settings` (keyed by the engine '--' model
   * id) are applied before the scan so a new chat model arrives with its
   * max_tokens / KV policy already set.
   *
   * Returns the post-scan pool summary, or `null` when the endpoint is absent
   * (404 on an un-patched engine) so the caller can fall back to a restart.
   * Throws on any other failure.
   */
  async rediscover(
    settings?: Record<string, Record<string, unknown>>
  ): Promise<{ modelsDiscovered: number; loadedModels: string[] } | null> {
    const res = await fetch(`${this.baseUrl()}/v1/models/discover`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(settings ? { settings } : {}),
      signal: AbortSignal.timeout(30_000)
    })
    if (res.status === 404) return null // route absent → caller falls back to restart
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`engine POST /v1/models/discover → ${res.status}: ${text.slice(0, 300)}`)
    }
    const data = (await res.json()) as { models_discovered?: number; loaded_models?: string[] }
    checkSidecar(engineDiscoverSchema, data, '/v1/models/discover')
    return { modelsDiscovered: data.models_discovered ?? 0, loadedModels: data.loaded_models ?? [] }
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
