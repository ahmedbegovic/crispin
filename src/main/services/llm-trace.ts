import { appendFile, rename, stat } from 'node:fs/promises'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { ChatCompletionMessage } from './engine-client'
import { dataDir } from './paths'
import { scopedLogger } from './logger'

/**
 * Always-on JSONL trace of every model call main makes (chat rounds, the
 * search router, structured research steps, condensations, title refinement).
 * One line per call — the ground truth when a small model misbehaves, and a
 * growing eval/fine-tuning dataset that costs nothing to keep. Appends are
 * fire-and-forget and serialized; the file rotates once to .1 at 100MB.
 */

export interface LlmTraceMeta {
  /** Which feature made the call, e.g. 'chat', 'research'. */
  surface: string
  /** Which step within it, e.g. 'route', 'select', 'loop', 'synthesis'. */
  step: string
  /** Correlation id: chat conversation id, research run id, … */
  conversationId?: string | null
}

export interface LlmTraceInput extends LlmTraceMeta {
  model: string
  /** Full request messages; image data URLs are replaced with '[image]'. */
  messages: ChatCompletionMessage[]
  /** Visible text the model produced (reasoning channel omitted). */
  output: string
  /** Validated object for structured calls; tool calls for loop rounds. */
  parsed?: unknown
  ok: boolean
  /** True when this call was a repair/truncation retry. */
  retried?: boolean
  finishReason?: string | null
  tokensIn?: number | null
  tokensOut?: number | null
  ms: number
  error?: string
  /** Engine's RFC-7234 Warning header — grammar degraded to prompt injection. */
  warning?: string | null
}

const MAX_BYTES = 100 * 1024 * 1024

const log = scopedLogger('llm-trace')

const tracePath = (): string => join(dataDir(), 'logs', 'llm-trace.jsonl')

/** Serializes appends — concurrent generations must not interleave lines. */
let chain: Promise<void> = Promise.resolve()
let dirReady = false

/** Base64 image payloads would dwarf the trace; the marker keeps shape intact. */
const sanitizeMessages = (messages: ChatCompletionMessage[]): unknown[] =>
  messages.map((m) =>
    Array.isArray(m.content)
      ? {
          ...m,
          content: m.content.map((p) =>
            p.type === 'image_url' ? { type: 'text', text: '[image]' } : p
          )
        }
      : m
  )

export function traceLlm(input: LlmTraceInput): void {
  const record = { ts: Date.now(), ...input, messages: sanitizeMessages(input.messages) }
  // Serialize NOW: chat-loop message arrays mutate between rounds, and a
  // queued write must capture the request as it was sent.
  let line: string
  try {
    line = `${JSON.stringify(record)}\n`
  } catch (err) {
    log.warn(`trace record not serializable: ${err instanceof Error ? err.message : err}`)
    return
  }
  chain = chain
    .then(async () => {
      const path = tracePath()
      if (!dirReady) {
        mkdirSync(join(dataDir(), 'logs'), { recursive: true })
        dirReady = true
      }
      const size = await stat(path).then((s) => s.size).catch(() => 0)
      if (size > MAX_BYTES) await rename(path, `${path}.1`).catch(() => {})
      await appendFile(path, line)
    })
    .catch((err) => {
      // Tracing never breaks a generation — log once per failure and move on.
      log.warn(`trace append failed: ${err instanceof Error ? err.message : err}`)
    })
}
