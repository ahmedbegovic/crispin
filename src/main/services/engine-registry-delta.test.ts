import { describe, it, expect } from 'vitest'
import { registryDelta, registryKey, parseRegistryKey, registryDeltaFromKey } from './engine-registry-delta'

// Pure kernel: classify a chat-registry change as additive (new models only,
// nothing removed or altered → a live rediscovery suffices) vs. restart-needed
// (a removal or a settings change that only a respawn applies). Operates on the
// [name, maxTokens] pairs that registryKey fingerprints.

const m = (name: string, maxTokens = 32768) => ({ name, maxTokens })

describe('registryDelta', () => {
  it('reports no change when the registries are identical', () => {
    const prev = [m('a'), m('b')]
    expect(registryDelta(prev, [m('b'), m('a')])).toEqual({ kind: 'none', added: [] })
  })

  it('is additive when a model is added and nothing else changes', () => {
    const prev = [m('a')]
    expect(registryDelta(prev, [m('a'), m('b')])).toEqual({ kind: 'additive', added: ['b'] })
  })

  it('lists every newly added model', () => {
    const prev = [m('a')]
    const delta = registryDelta(prev, [m('a'), m('b'), m('c')])
    expect(delta.kind).toBe('additive')
    expect(delta.added.sort()).toEqual(['b', 'c'])
  })

  it('needs a restart when a model is removed', () => {
    const prev = [m('a'), m('b')]
    expect(registryDelta(prev, [m('a')])).toEqual({ kind: 'restart', added: [] })
  })

  it("needs a restart when an existing model's maxTokens changes", () => {
    const prev = [m('a', 32768)]
    expect(registryDelta(prev, [m('a', 8192)])).toEqual({ kind: 'restart', added: [] })
  })

  it('needs a restart when models are both added and removed', () => {
    const prev = [m('a'), m('b')]
    expect(registryDelta(prev, [m('a'), m('c')])).toEqual({ kind: 'restart', added: [] })
  })
})

describe('registryKey / parseRegistryKey round-trip', () => {
  it('is order-insensitive and parses back to the same fingerprints', () => {
    const a = registryKey([m('b', 100), m('a', 200)])
    const b = registryKey([m('a', 200), m('b', 100)])
    expect(a).toBe(b) // order-insensitive fingerprint
    expect(parseRegistryKey(a)).toEqual([m('a', 200), m('b', 100)])
  })
})

describe('registryDeltaFromKey', () => {
  const prevKey = registryKey([m('a')])

  it('reports none when the key matches the current registry', () => {
    expect(registryDeltaFromKey(prevKey, [m('a')])).toEqual({ kind: 'none', added: [] })
  })

  it('detects an additive change against a prior key', () => {
    expect(registryDeltaFromKey(prevKey, [m('a'), m('b')])).toEqual({ kind: 'additive', added: ['b'] })
  })

  it('restarts when the prior key is null (unknown previous state)', () => {
    expect(registryDeltaFromKey(null, [m('a')])).toEqual({ kind: 'restart', added: [] })
  })

  it('restarts when the prior key is unparseable', () => {
    expect(registryDeltaFromKey('not json', [m('a')])).toEqual({ kind: 'restart', added: [] })
  })
})
