import { describe, it, expect } from 'vitest'
import { engineModelSettings } from './engine-config'

// The per-model oMLX wire settings must be built in ONE place so the spawn-time
// write (run_engine merges engine-config.json) and the live rediscovery push
// (POST /v1/models/discover) can never disagree about a model's max_tokens/KV.

describe('engineModelSettings', () => {
  it('enables TurboQuant KV with the given bits when kvQuantBits is set', () => {
    expect(engineModelSettings({ name: 'a/b', maxTokens: 8192, ttlSeconds: 1800, kvQuantBits: 4 })).toEqual({
      name: 'a/b',
      max_tokens: 8192,
      enable_thinking: true,
      ttl_seconds: 1800,
      turboquant_kv_enabled: true,
      turboquant_kv_bits: 4,
      turboquant_skip_last: true
    })
  })

  it('disables TurboQuant KV (defaulting bits to 4) when kvQuantBits is null', () => {
    const s = engineModelSettings({ name: 'c/d', maxTokens: 32768, ttlSeconds: null, kvQuantBits: null })
    expect(s.turboquant_kv_enabled).toBe(false)
    expect(s.turboquant_kv_bits).toBe(4)
    expect(s.ttl_seconds).toBeNull()
  })
})
