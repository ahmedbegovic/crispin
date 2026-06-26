import { describe, it, expect } from 'vitest'
import {
  familyOf,
  encodesToolHistoryAsText,
  salvagesTextualToolCalls,
  salvageTextualToolCalls,
  createContentSplitter,
  stripThoughts,
  type ContentSegment,
  type ContentSplitter
} from './family'

// family.ts is pure (only a type-only import of ../engine-client, erased at
// build) — these run without any Electron/engine machinery.

/** Drive a splitter with a sequence of chunks, returning every emitted segment. */
function run(splitter: ContentSplitter, chunks: string[]): ContentSegment[] {
  const out: ContentSegment[] = []
  for (const c of chunks) out.push(...splitter.push(c))
  out.push(...splitter.flush())
  return out
}

const text = (segs: ContentSegment[]): string =>
  segs
    .filter((s) => s.channel === 'text')
    .map((s) => s.text)
    .join('')

describe('familyOf', () => {
  it('detects the family by substring, case-insensitively', () => {
    expect(familyOf('mlx-community/gemma-4-31b-it-4bit')).toBe('gemma')
    expect(familyOf('mlx-community/Qwen3.5-9B-MLX-4bit')).toBe('qwen')
    expect(familyOf('MLX/GEMMA-thing')).toBe('gemma')
    expect(familyOf('mistralai/Mistral-7B')).toBe('other')
  })
})

describe('tool dialect lookups', () => {
  it('encodes all current families natively (no text dialect)', () => {
    expect(encodesToolHistoryAsText('gemma')).toBe(false)
    expect(encodesToolHistoryAsText('qwen')).toBe(false)
    expect(encodesToolHistoryAsText('other')).toBe(false)
  })
  it('keeps the salvage net on for gemma only', () => {
    expect(salvagesTextualToolCalls('gemma')).toBe(true)
    expect(salvagesTextualToolCalls('qwen')).toBe(false)
    expect(salvagesTextualToolCalls('other')).toBe(false)
  })
})

describe('salvageTextualToolCalls — recover imitated [tool_call] lines', () => {
  const known = new Set(['search', 'ping', 'a', 'b'])

  it('salvages a known tool-call line and strips it from the text', () => {
    const r = salvageTextualToolCalls('[tool_call] search({"q":"hi"})', known)
    expect(r.calls).toHaveLength(1)
    expect(r.calls[0].function).toEqual({ name: 'search', arguments: '{"q":"hi"}' })
    expect(r.calls[0].type).toBe('function')
    expect(r.calls[0].id).toMatch(/^salvaged-/) // id is a random uuid — shape only
    expect(r.cleanedText).toBe('')
  })

  it('defaults empty args to "{}"', () => {
    const r = salvageTextualToolCalls('[tool_call] ping()', known)
    expect(r.calls[0].function.arguments).toBe('{}')
  })

  it('ignores unknown tool names and returns the original text unchanged', () => {
    const input = '[tool_call] notATool({})'
    const r = salvageTextualToolCalls(input, known)
    expect(r.calls).toHaveLength(0)
    expect(r.cleanedText).toBe(input)
  })

  it('leaves prose that merely mentions the syntax inline as prose', () => {
    const input = 'You could call [tool_call] search(x) but I will not.'
    const r = salvageTextualToolCalls(input, known)
    expect(r.calls).toHaveLength(0)
    expect(r.cleanedText).toBe(input)
  })

  it('salvages multiple lines', () => {
    const r = salvageTextualToolCalls('[tool_call] a({})\n[tool_call] b({})', known)
    expect(r.calls.map((c) => c.function.name)).toEqual(['a', 'b'])
    expect(r.cleanedText).toBe('')
  })
})

describe('GemmaSplitter (createContentSplitter("gemma"))', () => {
  it('passes clean text through untouched', () => {
    expect(run(createContentSplitter('gemma'), ['Hello world'])).toEqual([
      { channel: 'text', text: 'Hello world' }
    ])
  })

  it('hides a recognized reasoning channel, shows the answer', () => {
    expect(
      run(createContentSplitter('gemma'), ['<|channel>thinking\nreasoning here<channel|>answer'])
    ).toEqual([
      { channel: 'thought', text: 'reasoning here' },
      { channel: 'text', text: 'answer' }
    ])
  })

  it('INVARIANT: a leaked/unknown channel stays VISIBLE (never silently dropped)', () => {
    // Classifying an unrecognized channel as thought would swallow the answer.
    const segs = run(createContentSplitter('gemma'), ['<|channel>final\nThe answer<channel|>'])
    expect(segs).toEqual([{ channel: 'text', text: 'The answer' }])
  })

  it('handles markers split across chunk boundaries', () => {
    const segs = run(createContentSplitter('gemma'), ['<|chan', 'nel>thinking\nfoo<chan', 'nel|>bar'])
    expect(segs).toEqual([
      { channel: 'thought', text: 'foo' },
      { channel: 'text', text: 'bar' }
    ])
  })

  it('strips a complete trailing end token at flush', () => {
    expect(text(run(createContentSplitter('gemma'), ['done<end_of_turn>']))).toBe('done')
    expect(text(run(createContentSplitter('gemma'), ['answer<eos>']))).toBe('answer')
  })

  it('INVARIANT: an end token mid-content stays literal (not a truncation point)', () => {
    expect(text(run(createContentSplitter('gemma'), ['a<eos>b']))).toBe('a<eos>b')
  })

  it('INVARIANT: a bare partial marker at flush is real content (no dropped char)', () => {
    // '<' is held during the push (it could begin a marker), but flush keeps it.
    expect(text(run(createContentSplitter('gemma'), ['answer<']))).toBe('answer<')
  })

  it('handles a channel label split across chunk boundaries', () => {
    // The label ('thinking') and its terminating newline arrive in separate
    // chunks — exercises the label-buffering branch.
    expect(
      run(createContentSplitter('gemma'), ['<|channel>think', 'ing\nfoo<channel|>bar'])
    ).toEqual([
      { channel: 'thought', text: 'foo' },
      { channel: 'text', text: 'bar' }
    ])
  })

  it('INVARIANT: an open thought channel at flush stays thought (not leaked, not dropped)', () => {
    // Stream truncated mid-thought with no closing marker (ultra tier caps output).
    expect(run(createContentSplitter('gemma'), ['<|channel>thinking\nstill reasoning'])).toEqual([
      { channel: 'thought', text: 'still reasoning' }
    ])
  })

  it('emits a held partial-close at flush as thought (covers the flush channel branch)', () => {
    // The trailing '<chan' is held back during push, then emitted at flush with
    // state==='channel' — the only input that reaches the flush() channel arm.
    expect(run(createContentSplitter('gemma'), ['<|channel>thinking\nreasoning<chan'])).toEqual([
      { channel: 'thought', text: 'reasoning' },
      { channel: 'thought', text: '<chan' }
    ])
  })

  it('INVARIANT: an open UNKNOWN channel at flush stays visible text', () => {
    expect(run(createContentSplitter('gemma'), ['<|channel>final\nThe answer'])).toEqual([
      { channel: 'text', text: 'The answer' }
    ])
  })

  it('drops a bare channel-label remainder at flush (no content yet)', () => {
    expect(run(createContentSplitter('gemma'), ['<|channel>thin'])).toEqual([])
  })
})

describe('PassthroughSplitter (non-gemma families)', () => {
  it('emits text verbatim and never parses markers', () => {
    const segs = run(createContentSplitter('qwen'), ['plain <|channel> not-a-marker<channel|> text'])
    expect(segs).toEqual([{ channel: 'text', text: 'plain <|channel> not-a-marker<channel|> text' }])
  })
})

describe('stripThoughts', () => {
  it('removes thought channels from a complete gemma response', () => {
    expect(stripThoughts('<|channel>thinking\nhidden<channel|>shown', 'gemma')).toBe('shown')
  })
  it('is a no-op (trim only) for non-gemma families', () => {
    expect(stripThoughts('  plain text  ', 'qwen')).toBe('plain text')
  })
})
