import { describe, it, expect } from 'vitest'
import { embedderDiscoverAction } from './embedder-discovery'

// Pure decision kernel for embedder rediscovery (F2) — no deps. Rediscovery is
// non-destructive (a live re-scan that leaves loaded models untouched), so —
// unlike the old engine restart — it is NOT idle-gated: there is no 'wait' on an
// in-flight generation and no busy-wait deadline.

const base = {
  disposed: false,
  running: true,
  alreadyDiscovered: false
}

describe('embedderDiscoverAction', () => {
  it('rediscovers when the engine is running and the embedder is undiscovered', () => {
    expect(embedderDiscoverAction(base)).toBe('rediscover')
  })

  it('rediscovers even while a generation is in flight — it never disturbs loaded models', () => {
    // No 'idle' input at all: a running generation does not block a re-scan.
    expect(embedderDiscoverAction(base)).toBe('rediscover')
  })

  it('is a no-op when the engine is not running', () => {
    expect(embedderDiscoverAction({ ...base, running: false })).toBe('done')
  })

  it('is a no-op when the embedder is already discovered', () => {
    expect(embedderDiscoverAction({ ...base, alreadyDiscovered: true })).toBe('done')
  })

  it('gives up on shutdown', () => {
    expect(embedderDiscoverAction({ ...base, disposed: true })).toBe('giveUp')
  })
})
