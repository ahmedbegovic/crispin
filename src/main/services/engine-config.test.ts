import { describe, it, expect } from 'vitest'
import { engineModelSettings, offloadConfigFields } from './engine-config'

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

// run_engine.py is a dumb translator of these three JSON fields into the OMLX_MOE_*
// env vars; the policy (dynamic-when-auto, optimistic only when offload is on) lives
// here so the config file is self-describing and the contract is unit-tested.
describe('offloadConfigFields', () => {
  it('clears every field when offload is off (gb 0), ignoring optimistic', () => {
    expect(offloadConfigFields(0, true)).toEqual({
      moe_offload_gb: 0,
      moe_offload_dynamic: false,
      moe_offload_optimistic: false
    })
  })

  it('keeps a fixed cache static; optimistic passes through', () => {
    expect(offloadConfigFields(6, false)).toEqual({
      moe_offload_gb: 6,
      moe_offload_dynamic: false,
      moe_offload_optimistic: false
    })
    expect(offloadConfigFields(8, true)).toEqual({
      moe_offload_gb: 8,
      moe_offload_dynamic: false,
      moe_offload_optimistic: true
    })
  })

  it('turns dynamic sizing on for auto; optimistic passes through', () => {
    expect(offloadConfigFields('auto', false)).toEqual({
      moe_offload_gb: 'auto',
      moe_offload_dynamic: true,
      moe_offload_optimistic: false
    })
    expect(offloadConfigFields('auto', true)).toEqual({
      moe_offload_gb: 'auto',
      moe_offload_dynamic: true,
      moe_offload_optimistic: true
    })
  })
})
