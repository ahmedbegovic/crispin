/**
 * Per-model-family quirks. Live-verified against vllm-mlx 0.3.0 (2026-06-10):
 *
 * gemma-4 emits a raw thought channel inside content:
 *   `<|channel>thought\n...reasoning...<channel|>...answer...`
 * The opener is `<|channel>` + a label line ending in `\n` (only "thought"
 * observed); the closer `<channel|>` arrives glued mid-chunk to surrounding
 * text (observed: `" factors).<channel|>No,"`). When the model decides to call
 * a tool the thought is left UNCLOSED — content just stops, then a complete
 * delta.tool_calls chunk follows — so flush() must finalize an open thought.
 *
 * gemma-4 is also served by vllm-mlx's MLLM path, which drops assistant
 * tool_calls and role:tool messages before templating (MLLM.chat() keeps only
 * text content) — OpenAI-shaped tool round-trips silently never reach the
 * model. Live-verified: the model re-issues the identical call forever. Tool
 * history for gemma must therefore be encoded as plain text turns.
 */

export type ModelFamily = 'gemma' | 'qwen' | 'other'

export function familyOf(modelId: string): ModelFamily {
  const id = modelId.toLowerCase()
  if (id.includes('gemma')) return 'gemma'
  if (id.includes('qwen')) return 'qwen'
  return 'other'
}

/** gemma: see module doc. qwen/others: standard OpenAI tool messages work. */
export function encodesToolHistoryAsText(family: ModelFamily): boolean {
  return family === 'gemma'
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

class GemmaSplitter implements ContentSplitter {
  private buf = ''
  /** 'label' = between `<|channel>` and the `\n` that ends the channel name. */
  private state: 'text' | 'label' | 'thought' = 'text'

  push(text: string): ContentSegment[] {
    this.buf += text
    const out: ContentSegment[] = []
    for (;;) {
      if (this.state === 'text') {
        const i = this.buf.indexOf(OPEN)
        if (i >= 0) {
          if (i > 0) out.push({ channel: 'text', text: this.buf.slice(0, i) })
          this.buf = this.buf.slice(i + OPEN.length)
          this.state = 'label'
          continue
        }
        const hold = partialSuffixLen(this.buf, OPEN)
        const emit = this.buf.slice(0, this.buf.length - hold)
        if (emit) out.push({ channel: 'text', text: emit })
        this.buf = this.buf.slice(this.buf.length - hold)
        return out
      }
      if (this.state === 'label') {
        const i = this.buf.indexOf('\n')
        if (i < 0) return out // labels are a few tokens; keep buffering
        this.buf = this.buf.slice(i + 1) // discard the channel name line
        this.state = 'thought'
        continue
      }
      // thought
      const i = this.buf.indexOf(CLOSE)
      if (i >= 0) {
        if (i > 0) out.push({ channel: 'thought', text: this.buf.slice(0, i) })
        this.buf = this.buf.slice(i + CLOSE.length)
        this.state = 'text'
        continue
      }
      const hold = partialSuffixLen(this.buf, CLOSE)
      const emit = this.buf.slice(0, this.buf.length - hold)
      if (emit) out.push({ channel: 'thought', text: emit })
      this.buf = this.buf.slice(this.buf.length - hold)
      return out
    }
  }

  flush(): ContentSegment[] {
    const out: ContentSegment[] = []
    // 'label' remainder is markup mid-marker — drop it. Elsewhere a held-back
    // partial marker turned out to be ordinary text/thought after all.
    if (this.buf && this.state !== 'label') {
      out.push({ channel: this.state === 'thought' ? 'thought' : 'text', text: this.buf })
    }
    this.buf = ''
    this.state = 'text'
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

/** Strip thought channels from a complete (non-streamed) gemma response. */
export function stripThoughts(content: string, family: ModelFamily): string {
  const splitter = createContentSplitter(family)
  return [...splitter.push(content), ...splitter.flush()]
    .filter((s) => s.channel === 'text')
    .map((s) => s.text)
    .join('')
    .trim()
}
