import { describe, it, expect } from 'vitest'
import type { MessagePart } from '@shared/types'
import { estimateMessageTokens, computeBudget, trimToBudget } from './budget'

// Pure budget core extracted from the orchestrator — no Electron/engine deps.

describe('estimateMessageTokens', () => {
  it('counts text/thought at ~4 chars per token', () => {
    expect(estimateMessageTokens([{ type: 'text', text: 'abcdefgh' }])).toBe(2) // ceil(8/4)
    expect(estimateMessageTokens([{ type: 'thought', text: 'abcd' }])).toBe(1)
  })

  it('adds a flat 16-char overhead for tool calls and results', () => {
    expect(estimateMessageTokens([{ type: 'tool_call', id: '1', name: 'ab', args: 'cd' }])).toBe(5) // (2+2+16)/4
    expect(
      estimateMessageTokens([{ type: 'tool_result', toolCallId: '1', name: 'n', result: 'abcd' }])
    ).toBe(5) // (4+16)/4
  })

  it('charges a flat 900 tokens per image', () => {
    expect(estimateMessageTokens([{ type: 'image', path: 'p', mime: 'image/png' }])).toBe(900)
  })

  it('sums across parts and returns 0 for an empty message', () => {
    expect(estimateMessageTokens([])).toBe(0)
    expect(
      estimateMessageTokens([
        { type: 'text', text: 'abcd' },
        { type: 'image', path: 'p', mime: 'image/png' }
      ])
    ).toBe(901) // 1 + 900
  })
})

describe('computeBudget', () => {
  it('subtracts the output reserve, the flat system margin, and the evidence reserve', () => {
    expect(computeBudget(100_000, 4096, 0)).toBe(100_000 - 4096 - 4096)
    expect(computeBudget(100_000, 4096, 5000)).toBe(100_000 - 4096 - 4096 - 5000)
  })

  it('never drops below the 2048 floor', () => {
    expect(computeBudget(5000, 4096, 0)).toBe(2048)
  })
})

describe('trimToBudget', () => {
  type Msg = { role: string; parts: MessagePart[] }
  // cost(msg) = ceil((tokens*4)/4) = tokens
  const msg = (role: string, tokens: number): Msg => ({
    role,
    parts: [{ type: 'text', text: 'x'.repeat(tokens * 4) }]
  })

  it('keeps everything when it all fits, order intact', () => {
    const path = [msg('user', 10), msg('assistant', 10), msg('user', 10)]
    expect(trimToBudget(path, 1000)).toEqual(path)
  })

  it('always keeps the newest message even if it alone exceeds the budget', () => {
    const path = [msg('user', 50), msg('user', 50)]
    expect(trimToBudget(path, 1)).toEqual([path[1]])
  })

  it('greedily keeps the newest turns that fit', () => {
    const path = [msg('user', 10), msg('user', 10), msg('user', 10), msg('user', 10)]
    // budget 25 fits two 10-token turns (20) but not three (30).
    expect(trimToBudget(path, 25)).toEqual([path[2], path[3]])
  })

  it('never starts the kept window on an assistant turn', () => {
    const u1 = msg('user', 10)
    const a1 = msg('assistant', 10)
    const u2 = msg('user', 10)
    // budget 25 would greedily keep [a1, u2]; the leading assistant is trimmed.
    expect(trimToBudget([u1, a1, u2], 25)).toEqual([u2])
  })

  it('returns an empty array for an empty path', () => {
    expect(trimToBudget([], 1000)).toEqual([])
  })

  it('keeps a lone trailing assistant on an all-assistant path (keep-newest wins over the trim)', () => {
    // Degenerate input: the always-keep-newest rule wins over the leading-assistant
    // trim, so the window can start on an assistant when only one message remains.
    const a1 = msg('assistant', 10)
    const a2 = msg('assistant', 10)
    expect(trimToBudget([a1, a2], 1000)).toEqual([a2])
    expect(trimToBudget([a1], 1000)).toEqual([a1])
  })
})
