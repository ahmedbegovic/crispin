import { z } from 'zod'
import type { ChatCompletionMessage, EngineClient } from './engine-client'
import { familyOf, stripThoughts } from './chat/family'
import { traceLlm, type LlmTraceMeta } from './llm-trace'

/**
 * Shared structured-generation helpers, extracted from the research
 * orchestrator's jsonStep/summarize so chat (search router, page condensation)
 * and research drive the same battle-tested path.
 *
 * Every call here is NON-streaming: the engine only strips fences and thought
 * leaks server-side on the non-streaming path, and with the grammar extra
 * installed response_format json_schema is actually constrained (an RFC-7234
 * Warning header would flag the prompt-injection fallback). The fence-tolerant
 * parse below stays as a defensive net, not the mechanism.
 */

/**
 * All structured generations run at 0.3 — schema adherence and determinism
 * beat the model's recommended sampling here; flaky JSON is not debuggable.
 */
export const STRUCTURED_TEMPERATURE = 0.3

const clip = (text: string, limit: number): string =>
  text.length > limit ? `${text.slice(0, limit)}…` : text

/**
 * Total-request bound scaled to the output budget: ~100ms/token of decode
 * headroom on top of a 300s floor (queue + possible lazy reload + prefill).
 * A micro-call stays tightly bounded (~326s at 256 tokens); an 8192-token
 * research synthesis on a contended 12B gets the time the old streaming
 * transport effectively gave it (review finding: a flat 600s cap failed
 * legitimate max-length syntheses deterministically).
 */
const timeoutFor = (maxTokens: number): number => 300_000 + maxTokens * 100

export interface StructuredOptions<T> {
  engine: EngineClient
  /** Canonical HF repo id of the model to ask. */
  model: string
  /** json_schema name — shows up in engine logs, keep it step-specific. */
  name: string
  schema: z.ZodType<T>
  messages: ChatCompletionMessage[]
  maxTokens: number
  meta: LlmTraceMeta
  signal: AbortSignal
}

/**
 * One structured generation: response_format json_schema derived from the zod
 * schema, fences/thought-leaks tolerated, ONE repair retry carrying the parse
 * error (or a doubled budget capped at 8192 after a truncation) before the
 * call fails. Both attempts are traced.
 */
export async function structured<T>(opts: StructuredOptions<T>): Promise<T> {
  // The engine rejects nothing here today, but $schema is pure noise to it.
  const { $schema: _omitted, ...jsonSchema } = z.toJSONSchema(opts.schema) as Record<
    string,
    unknown
  >
  const responseFormat = {
    type: 'json_schema',
    json_schema: { name: opts.name, schema: jsonSchema }
  }

  const parse = (raw: string): T => {
    const text = stripThoughts(raw, familyOf(opts.model))
    const start = text.indexOf('{')
    const end = text.lastIndexOf('}')
    if (start < 0 || end <= start) throw new Error('no JSON object in the response')
    return opts.schema.parse(JSON.parse(text.slice(start, end + 1)))
  }

  const attempt = async (
    messages: ChatCompletionMessage[],
    maxTokens: number,
    retried: boolean
  ): Promise<{ parsed?: T; raw: string; finish: string | null; failure?: string }> => {
    const startedAt = Date.now()
    let raw = ''
    let finish: string | null = null
    let tokensIn: number | null = null
    let tokensOut: number | null = null
    let parsed: T | undefined
    let failure: string | undefined
    try {
      const res = await opts.engine.chat({
        model: opts.model,
        messages,
        maxTokens,
        temperature: STRUCTURED_TEMPERATURE,
        responseFormat,
        // Thinking tokens count against max_tokens and the reasoning channel
        // is discarded here anyway — without this, gemma burns the whole JSON
        // budget thinking and every structured step truncates.
        chatTemplateKwargs: { enable_thinking: false },
        timeoutMs: timeoutFor(maxTokens),
        signal: opts.signal
      })
      raw = res.content
      finish = res.finishReason
      tokensIn = res.tokensIn
      tokensOut = res.tokensOut
    } catch (err) {
      failure = err instanceof Error ? err.message : String(err)
      traceLlm({
        ...opts.meta,
        model: opts.model,
        messages,
        output: raw,
        ok: false,
        retried,
        finishReason: finish,
        tokensIn,
        tokensOut,
        ms: Date.now() - startedAt,
        error: failure
      })
      throw err
    }
    if (finish === 'length') {
      // Truncated output is not a parse problem: retrying at the same budget
      // would deterministically truncate again — raise it and say so.
      failure = `the reply was cut off at ${maxTokens} tokens`
    } else {
      try {
        parsed = parse(raw)
      } catch (err) {
        failure = err instanceof Error ? err.message : String(err)
      }
    }
    traceLlm({
      ...opts.meta,
      model: opts.model,
      messages,
      output: raw,
      parsed,
      ok: parsed !== undefined,
      retried,
      finishReason: finish,
      tokensIn,
      tokensOut,
      ms: Date.now() - startedAt,
      error: failure
    })
    return { parsed, raw, finish, failure }
  }

  const first = await attempt(opts.messages, opts.maxTokens, false)
  if (first.parsed !== undefined) return first.parsed
  if (opts.signal.aborted) throw new Error('aborted')
  const reason = first.failure ?? 'unusable response'
  const retryTokens = first.finish === 'length' ? Math.min(opts.maxTokens * 2, 8192) : opts.maxTokens
  const second = await attempt(
    [
      ...opts.messages,
      { role: 'assistant', content: clip(first.raw, 4000) },
      {
        role: 'user',
        content:
          `That response could not be used: ${clip(reason, 500)}. ` +
          'Reply again with ONLY a valid JSON object matching the requested schema — no prose, no code fences.'
      }
    ],
    retryTokens,
    true
  )
  if (second.parsed !== undefined) return second.parsed
  if (second.finish === 'length') {
    throw new Error(`output truncated at ${retryTokens} tokens (finish_reason=length)`)
  }
  throw new Error(second.failure ?? 'unusable response')
}

export interface CondenseOptions {
  engine: EngineClient
  /** Usually the low-tier model — condensation is a utility job. */
  model: string
  /** Page or document text; clipped to 80k chars before prompting. */
  text: string
  /** The question/subquestion the extracted claims must bear on. */
  focus: string
  charLimit: number
  maxTokens?: number
  meta: LlmTraceMeta
  signal: AbortSignal
}

/** Condense a long page against the question it was fetched for. */
export async function condense(opts: CondenseOptions): Promise<string> {
  const maxTokens = opts.maxTokens ?? 700
  const messages: ChatCompletionMessage[] = [
    { role: 'system', content: 'You condense web pages for a research agent.' },
    {
      role: 'user',
      content:
        // Chat can pass a whole pasted user message as focus — clip it.
        `Extract only the factual claims relevant to: "${clip(opts.focus, 1000)}"\n\n` +
        `Page content:\n${opts.text.slice(0, 80_000)}\n\n` +
        `Reply with at most ${opts.charLimit} characters of terse claims, one per line. No preamble.`
    }
  ]
  const startedAt = Date.now()
  try {
    const res = await opts.engine.chat({
      model: opts.model,
      messages,
      maxTokens,
      temperature: STRUCTURED_TEMPERATURE,
      chatTemplateKwargs: { enable_thinking: false },
      timeoutMs: timeoutFor(maxTokens),
      signal: opts.signal
    })
    const out = clip(stripThoughts(res.content, familyOf(opts.model)).trim(), opts.charLimit)
    traceLlm({
      ...opts.meta,
      model: opts.model,
      messages,
      output: res.content,
      ok: true,
      finishReason: res.finishReason,
      tokensIn: res.tokensIn,
      tokensOut: res.tokensOut,
      ms: Date.now() - startedAt
    })
    return out
  } catch (err) {
    traceLlm({
      ...opts.meta,
      model: opts.model,
      messages,
      output: '',
      ok: false,
      ms: Date.now() - startedAt,
      error: err instanceof Error ? err.message : String(err)
    })
    throw err
  }
}
