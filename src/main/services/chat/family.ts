/**
 * Per-model-family quirks. Updated for oMLX 0.4.3 (2026-06-10):
 *
 * Thinking now arrives pre-parsed: the engine runs gemma with
 * enable_thinking and streams reasoning as delta.reasoning_content, so
 * content should never contain raw `<|channel>thought` markers anymore.
 * GemmaSplitter is retained as a defensive net for marker leaks (it
 * passes clean text through untouched).
 *
 * Tool history: oMLX templates OpenAI-shaped gemma tool history natively
 * (the Agent tab's opencode traffic relies on that), so text-encoding it
 * here is a retained legacy choice, not a serving-path workaround — the
 * text shapes were live-verified across two engines. Candidate follow-up:
 * live-verify a gemma OpenAI-shaped tool round-trip through the Chat tab
 * and flip encodesToolHistoryAsText to false.
 */

import type { WireToolCall } from '../engine-client'

export type ModelFamily = 'gemma' | 'qwen' | 'other'

export function familyOf(modelId: string): ModelFamily {
  const id = modelId.toLowerCase()
  if (id.includes('gemma')) return 'gemma'
  if (id.includes('qwen')) return 'qwen'
  return 'other'
}

interface FamilyDialect {
  /** How tool round-trips are recorded in the history sent back to the model. */
  toolHistory: 'native' | 'text'
  /** Keep the salvage net for families that still imitate the text dialect in content. */
  salvageTextCalls: boolean
}

/**
 * Per-family tool dialect. Gemma was flipped to NATIVE OpenAI tool messages
 * after a live round-trip through oMLX confirmed gemma-4 emits native tool_calls
 * AND accepts native tool results cleanly (verified 2026-06-23). The salvage net
 * stays on for gemma as a defensive backstop against occasional text-dialect
 * imitation (the engine's own docs note that history-mimicry mode).
 */
const FAMILY_DIALECT: Record<ModelFamily, FamilyDialect> = {
  gemma: { toolHistory: 'native', salvageTextCalls: true },
  qwen: { toolHistory: 'native', salvageTextCalls: false },
  other: { toolHistory: 'native', salvageTextCalls: false }
}

export function encodesToolHistoryAsText(family: ModelFamily): boolean {
  return FAMILY_DIALECT[family].toolHistory === 'text'
}

/** Whether to run the textual-tool-call salvage net for this family. */
export function salvagesTextualToolCalls(family: ModelFamily): boolean {
  return FAMILY_DIALECT[family].salvageTextCalls
}

export interface ContentSegment {
  channel: 'text' | 'thought'
  text: string
}

/**
 * Streaming-safe splitter: feed raw content deltas, get text/thought segments.
 * Chunk boundaries may fall inside a marker, so each push holds back the
 * longest buffer suffix that could still become one.
 */
export interface ContentSplitter {
  push(text: string): ContentSegment[]
  /** End of stream: emit whatever is held back (open thoughts stay thoughts). */
  flush(): ContentSegment[]
}

const OPEN = '<|channel>'
const CLOSE = '<channel|>'

/** Length of the longest suffix of buf that is a proper prefix of marker. */
function partialSuffixLen(buf: string, marker: string): number {
  const max = Math.min(buf.length, marker.length - 1)
  for (let len = max; len > 0; len--) {
    if (buf.endsWith(marker.slice(0, len))) return len
  }
  return 0
}

/** Gemma end-of-turn tokens that occasionally leak into content as literal text. */
const END_TOKENS = ['<end_of_turn>', '<eos>'] as const

/**
 * Length of the trailing suffix of buf that could be a leaked end token — a
 * COMPLETE end token at the very end, or a partial prefix of one at a chunk
 * boundary. It's held back during streaming and only stripped in flush(), so a
 * `<eos>` that appears mid-content (with more text after it) stays literal text
 * rather than truncating the answer at the first occurrence.
 */
function trailingEndHold(buf: string): number {
  let hold = 0
  for (const tok of END_TOKENS) {
    if (buf.endsWith(tok)) hold = Math.max(hold, tok.length)
    else hold = Math.max(hold, partialSuffixLen(buf, tok))
  }
  return hold
}

/**
 * Length of a COMPLETE leaked end token at the very end of buf, else 0. At flush
 * a bare PARTIAL prefix ('<', '<e', …) is real content — an engine emits its stop
 * token atomically, so it never cuts one short into the content stream — and must
 * not be stripped (stripping it silently drops the answer's last character).
 */
function completeTrailingEndLen(buf: string): number {
  for (const tok of END_TOKENS) {
    if (buf.endsWith(tok)) return tok.length
  }
  return 0
}

/**
 * Gemma reasoning-channel names whose content is hidden as thought. ANY other
 * channel name (a leaked answer/'final' channel) is treated as visible text:
 * classifying the answer as thought would silently drop it, which is exactly the
 * marker-leak degradation GemmaSplitter exists to survive.
 */
const THOUGHT_CHANNELS = new Set(['thought', 'thinking', 'reasoning', 'analysis'])

class GemmaSplitter implements ContentSplitter {
  private buf = ''
  /** 'label' = between `<|channel>` and the `\n` that ends the channel name. */
  private state: 'text' | 'label' | 'channel' = 'text'
  /** Visibility of the channel currently being read, decided at its label. */
  private channelKind: 'text' | 'thought' = 'thought'

  push(text: string): ContentSegment[] {
    this.buf += text
    const out: ContentSegment[] = []
    for (;;) {
      if (this.state === 'text') {
        const openIdx = this.buf.indexOf(OPEN)
        if (openIdx >= 0) {
          if (openIdx > 0) out.push({ channel: 'text', text: this.buf.slice(0, openIdx) })
          this.buf = this.buf.slice(openIdx + OPEN.length)
          this.state = 'label'
          continue
        }
        // Hold back a trailing channel-open partial OR a (partial/complete)
        // leaked end token. A complete end token mid-buffer (more text after it)
        // stays in the emitted text; only a trailing one is held for flush() to
        // strip — so a literal `<eos>` in the answer is never a truncation point.
        const hold = Math.max(partialSuffixLen(this.buf, OPEN), trailingEndHold(this.buf))
        const emit = this.buf.slice(0, this.buf.length - hold)
        if (emit) out.push({ channel: 'text', text: emit })
        this.buf = this.buf.slice(this.buf.length - hold)
        return out
      }
      if (this.state === 'label') {
        const i = this.buf.indexOf('\n')
        if (i < 0) return out // labels are a few tokens; keep buffering
        const name = this.buf.slice(0, i).trim().toLowerCase()
        this.buf = this.buf.slice(i + 1) // consume the channel name line
        // Only a recognized reasoning channel is hidden; an unknown/leaked answer
        // channel stays visible so a marker leak never swallows the answer.
        this.channelKind = THOUGHT_CHANNELS.has(name) ? 'thought' : 'text'
        this.state = 'channel'
        continue
      }
      // channel: read to the close marker, emitting with the label's visibility.
      const i = this.buf.indexOf(CLOSE)
      if (i >= 0) {
        if (i > 0) out.push({ channel: this.channelKind, text: this.buf.slice(0, i) })
        this.buf = this.buf.slice(i + CLOSE.length)
        this.state = 'text'
        continue
      }
      const hold = partialSuffixLen(this.buf, CLOSE)
      const emit = this.buf.slice(0, this.buf.length - hold)
      if (emit) out.push({ channel: this.channelKind, text: emit })
      this.buf = this.buf.slice(this.buf.length - hold)
      return out
    }
  }

  flush(): ContentSegment[] {
    const out: ContentSegment[] = []
    // 'label' remainder is mid-marker markup with no content yet — drop it. In the
    // text state, strip only a COMPLETE trailing leaked end token; a bare partial
    // prefix is real content. A still-open channel emits with its label visibility.
    if (this.buf && this.state !== 'label') {
      const text =
        this.state === 'text'
          ? this.buf.slice(0, this.buf.length - completeTrailingEndLen(this.buf))
          : this.buf
      if (text) out.push({ channel: this.state === 'channel' ? this.channelKind : 'text', text })
    }
    this.buf = ''
    this.state = 'text'
    this.channelKind = 'thought'
    return out
  }
}

class PassthroughSplitter implements ContentSplitter {
  push(text: string): ContentSegment[] {
    return text ? [{ channel: 'text', text }] : []
  }

  flush(): ContentSegment[] {
    return []
  }
}

export function createContentSplitter(family: ModelFamily): ContentSplitter {
  return family === 'gemma' ? new GemmaSplitter() : new PassthroughSplitter()
}

/**
 * The text-encoded tool history teaches gemma the literal
 * `[tool_call] name(args)` shape, and the model sometimes imitates it in
 * visible content instead of emitting a native call (the engine's own docs
 * note this history-mimicry mode). Salvage such lines into real calls; only
 * known tool names qualify, so prose that merely mentions the syntax stays
 * prose. Returns the cleaned text so the call line isn't re-taught twice
 * when the round is recorded back into the history.
 */
export function salvageTextualToolCalls(
  text: string,
  knownTools: ReadonlySet<string>
): { calls: WireToolCall[]; cleanedText: string } {
  const calls: WireToolCall[] = []
  const cleaned = text.replace(
    /^\[tool_call\]\s+([A-Za-z_][\w.-]*)\s*\((.*)\)\s*$/gm,
    (line, name: string, args: string) => {
      if (!knownTools.has(name)) return line
      calls.push({
        id: `salvaged-${crypto.randomUUID()}`,
        type: 'function',
        function: { name, arguments: args.trim() || '{}' }
      })
      return ''
    }
  )
  return calls.length > 0 ? { calls, cleanedText: cleaned.trim() } : { calls, cleanedText: text }
}

/** Strip thought channels from a complete (non-streamed) gemma response. */
export function stripThoughts(content: string, family: ModelFamily): string {
  const splitter = createContentSplitter(family)
  return [...splitter.push(content), ...splitter.flush()]
    .filter((s) => s.channel === 'text')
    .map((s) => s.text)
    .join('')
    .trim()
}
