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
