import { describe, it, expect } from 'vitest'
import {
  validateModelRepo,
  candidateWarning,
  canonicalRepoId,
  isCuratedRepo,
  familyOf,
  tierOfRepo,
  tierSpecFor,
  classifyByParams,
  estimateGB,
  fitFor,
  kvQuantBitsFor,
  modelDisplayName,
  toolBudgetForTier,
  TIERS,
  TIER_ORDER,
  UTILITY_MODEL,
  EMBEDDING_MODEL,
  NON_QAT_GEMMA_WHITELIST
} from './model-tiers'

// model-tiers is pure policy with zero runtime dependencies (only type-only
// imports). Importing the module also runs its load-time invariant asserts
// (model-tiers.ts:295-314); a bad table edit would throw here before any test.

describe('validateModelRepo — the QAT/PLE garbage-model gate', () => {
  it('rejects a non-QAT Gemma 4 E-series repo', () => {
    const r = validateModelRepo('mlx-community/gemma-4-E2B-it-4bit')
    expect(r.ok).toBe(false)
    expect(r.warning).toMatch(/PLE|qat/i)
  })

  it('rejects regardless of case (the rule matches the lowercased id)', () => {
    expect(validateModelRepo('mlx-community/gemma-4-e4b-4bit').ok).toBe(false)
  })

  it('accepts a QAT Gemma 4 variant', () => {
    expect(validateModelRepo('mlx-community/gemma-4-E2B-it-qat-4bit')).toEqual({ ok: true })
  })

  it('accepts the whitelisted 31B regular 4-bit (PLE bug is E-series only)', () => {
    expect(validateModelRepo('mlx-community/gemma-4-31b-it-4bit')).toEqual({ ok: true })
    expect(NON_QAT_GEMMA_WHITELIST.has('mlx-community/gemma-4-31b-it-4bit')).toBe(true)
  })

  it('CHARACTERIZATION: the whitelist is case-sensitive — an upper-cased 31B id is rejected', () => {
    // :194 checks the original-case repoId against the Set, while :195 matches the
    // lowercased id. So a case-variant of the whitelisted id falls through to the
    // gemma-4-without-qat rule and is rejected. Pinned so a future "normalize the
    // whitelist" change is a conscious decision, not a silent behavior flip.
    expect(validateModelRepo('mlx-community/GEMMA-4-31B-IT-4BIT').ok).toBe(false)
  })

  it('accepts non-Gemma repos and Gemma generations other than 4', () => {
    expect(validateModelRepo('mlx-community/Qwen3.5-9B-MLX-4bit')).toEqual({ ok: true })
    expect(validateModelRepo('meta-llama/Llama-3-8B')).toEqual({ ok: true })
    expect(validateModelRepo('google/gemma-2-9b-it')).toEqual({ ok: true }) // only gemma-4 is gated
  })
})

describe('candidateWarning — the gate as a string|null, for the load/select seam (F4)', () => {
  it('returns the PLE warning for a non-QAT Gemma 4 E-series quant', () => {
    const w = candidateWarning('mlx-community/gemma-4-E4B-it-4bit')
    expect(w).not.toBeNull()
    expect(w).toMatch(/PLE|qat|garbage/i)
  })
  it('returns null for a QAT variant, the whitelisted 31B, and non-Gemma repos', () => {
    expect(candidateWarning('mlx-community/gemma-4-E4B-it-qat-4bit')).toBeNull()
    expect(candidateWarning('mlx-community/gemma-4-31b-it-4bit')).toBeNull()
    expect(candidateWarning('mlx-community/Qwen3.5-9B-MLX-4bit')).toBeNull()
  })
})

describe('canonicalRepoId — rename mapping', () => {
  it('maps a renamed repo to its canonical id', () => {
    expect(canonicalRepoId('mlx-community/Qwen3.5-4B-4bit')).toBe('mlx-community/Qwen3.5-4B-MLX-4bit')
  })
  it('passes through an unknown id unchanged', () => {
    expect(canonicalRepoId('some/random-model')).toBe('some/random-model')
  })
})

describe('isCuratedRepo / familyOf (catalog) — rename-aware', () => {
  it('recognizes curated repos, including via the rename map', () => {
    expect(isCuratedRepo('mlx-community/gemma-4-E2B-it-qat-4bit')).toBe(true)
    expect(isCuratedRepo('mlx-community/Qwen3.5-4B-4bit')).toBe(true) // old id → canonical is curated
    expect(isCuratedRepo('some/random-model')).toBe(false)
  })

  it('classifies a curated repo by brand and non-curated as experimental', () => {
    expect(familyOf('mlx-community/gemma-4-31b-it-4bit')).toBe('gemma')
    expect(familyOf('mlx-community/Qwen3.5-9B-MLX-4bit')).toBe('qwen')
    expect(familyOf('some/random-model')).toBe('experimental')
  })
})

describe('tierOfRepo / tierSpecFor — which tier a curated repo belongs to', () => {
  it('maps each curated candidate to its tier', () => {
    expect(tierOfRepo('mlx-community/gemma-4-E2B-it-qat-4bit')).toBe('low')
    expect(tierOfRepo('mlx-community/Qwen3.5-2B-4bit')).toBe('low')
    expect(tierOfRepo('mlx-community/gemma-4-E4B-it-qat-4bit')).toBe('medium')
    expect(tierOfRepo('mlx-community/Qwen3.5-9B-MLX-4bit')).toBe('high')
    expect(tierOfRepo('mlx-community/gemma-4-12B-it-qat-4bit')).toBe('high')
    expect(tierOfRepo('mlx-community/gemma-4-26B-A4B-it-qat-4bit')).toBe('extraHigh')
    expect(tierOfRepo('mlx-community/Qwen3.6-27B-4bit')).toBe('ultra')
    expect(tierOfRepo('mlx-community/gemma-4-31b-it-4bit')).toBe('ultra')
  })
  it('is rename-aware and returns null for non-curated repos', () => {
    expect(tierOfRepo('mlx-community/Qwen3.5-4B-4bit')).toBe('medium') // old id → canonical
    expect(tierOfRepo('some/random-model')).toBeNull()
  })
  it('tierSpecFor returns the matching TierSpec (or undefined)', () => {
    expect(tierSpecFor('mlx-community/Qwen3.6-27B-4bit')).toBe(TIERS.ultra)
    expect(tierSpecFor('some/random-model')).toBeUndefined()
  })
})

describe('classifyByParams — bucket an arbitrary model by parameter count', () => {
  it('buckets by the parsed param count at the tier boundaries', () => {
    expect(classifyByParams('x/model-2B')).toBe('low')
    expect(classifyByParams('x/model-4B')).toBe('low') // ≤4
    expect(classifyByParams('x/model-5B')).toBe('medium')
    expect(classifyByParams('x/model-8B')).toBe('medium') // ≤8
    expect(classifyByParams('x/model-9B')).toBe('high')
    expect(classifyByParams('x/model-12B')).toBe('high') // ≤12
    expect(classifyByParams('x/model-27B')).toBe('extraHigh') // ≤27
    expect(classifyByParams('x/model-30B')).toBe('ultra')
  })

  it('parses the FIRST "<n>B" token and rejects the "4bit" lookahead trap', () => {
    expect(classifyByParams('x/gemma-4-26B-A4B-experimental')).toBe('extraHigh') // first match 26B
    // "model-4bit" has no real param token (the [bB] lookahead rejects "4bit")
    // and no sizeBytes → unparseable → defaults to 'high'.
    expect(classifyByParams('x/model-4bit')).toBe('high')
  })

  it('falls back to sizeBytes (~0.55 GB/B) when the name has no param token', () => {
    expect(classifyByParams('x/mystery', 2e9)).toBe('low') // 2/0.55 ≈ 3.6 B
    expect(classifyByParams('x/mystery', 6e9)).toBe('high') // 6/0.55 ≈ 10.9 B
    expect(classifyByParams('x/mystery', 18e9)).toBe('ultra') // 18/0.55 ≈ 32.7 B
  })
})

describe('estimateGB — load footprint', () => {
  it('prefers sizeBytes (weights + 10% overhead)', () => {
    expect(estimateGB('x/anything', 10e9)).toBeCloseTo(11.0, 5)
  })
  it('falls back to the parsed param count (params*0.55 + 0.6)', () => {
    expect(estimateGB('x/model-7B')).toBeCloseTo(4.45, 5)
  })
  it('returns null when neither sizeBytes nor a param token is available', () => {
    expect(estimateGB('x/model-4bit')).toBeNull()
  })
})

describe('fitFor — traffic-light fit against budget + available memory', () => {
  const budget = 18.5
  it('returns "unable" when the estimate exceeds the budget', () => {
    expect(fitFor(20, { budgetGB: budget, availableGB: 30 })).toBe('unable')
  })
  it('returns "risky" when it would eat into the last 2 GB of available memory', () => {
    expect(fitFor(10, { budgetGB: budget, availableGB: 11 })).toBe('risky') // 10 > 11-2
  })
  it('returns "good" above 70% of budget, "perfect" below', () => {
    expect(fitFor(14, { budgetGB: budget, availableGB: 30 })).toBe('good') // 14 > 12.95
    expect(fitFor(5, { budgetGB: budget, availableGB: 30 })).toBe('perfect')
  })
  it('the risky check takes precedence over good', () => {
    // 14 is both >70% of budget AND within 2 GB of available — risky wins (checked first).
    expect(fitFor(14, { budgetGB: budget, availableGB: 15 })).toBe('risky')
  })
  it('skips the risky branch entirely when availableGB is null', () => {
    expect(fitFor(10, { budgetGB: budget, availableGB: null })).toBe('perfect')
    expect(fitFor(14, { budgetGB: budget, availableGB: null })).toBe('good')
  })
})

describe('kvQuantBitsFor — TurboQuant KV width by effective tier', () => {
  it('returns 4 for ultra-tier repos (curated)', () => {
    expect(kvQuantBitsFor('mlx-community/Qwen3.6-27B-4bit')).toBe(4)
    expect(kvQuantBitsFor('mlx-community/gemma-4-31b-it-4bit')).toBe(4)
  })
  it('returns null for tiers without KV quant', () => {
    expect(kvQuantBitsFor('mlx-community/gemma-4-E2B-it-qat-4bit')).toBeNull()
  })
  it('extends KV quant to big experimental downloads via classifyByParams', () => {
    expect(kvQuantBitsFor('x/model-30B')).toBe(4) // not curated → classified ultra → 4
    expect(kvQuantBitsFor('x/model-7B')).toBeNull() // classified medium → no quant
  })
})

describe('modelDisplayName', () => {
  it('uses the curated short name (rename-aware)', () => {
    expect(modelDisplayName('mlx-community/gemma-4-E2B-it-qat-4bit')).toBe('Gemma 4 E2B')
    expect(modelDisplayName('mlx-community/Qwen3.5-4B-4bit')).toBe('Qwen 3.5 4B') // old id → canonical
  })
  it('prettifies a non-curated id by stripping quant/format suffixes and the org', () => {
    expect(modelDisplayName('someorg/My-Cool-Model-7B-it-4bit')).toBe('My Cool Model 7B')
  })
})

describe('tier policy invariants', () => {
  it('has all five tiers, each with at least one candidate', () => {
    expect(TIER_ORDER).toEqual(['low', 'medium', 'high', 'extraHigh', 'ultra'])
    for (const tier of TIER_ORDER) expect(TIERS[tier].candidates.length).toBeGreaterThan(0)
  })
  it('the utility model is the low tier’s first candidate, and the embedder is not curated', () => {
    expect(UTILITY_MODEL).toBe(TIERS.low.candidates[0])
    expect(isCuratedRepo(EMBEDDING_MODEL)).toBe(false)
  })
  it('KV quant is configured only where set, and only at 4 or 8 bits', () => {
    for (const tier of TIER_ORDER) {
      const bits = TIERS[tier].kvQuantBits
      if (bits !== undefined) expect([4, 8]).toContain(bits)
    }
  })
  it('toolBudgetForTier returns the per-tier visible-tool cap', () => {
    expect(toolBudgetForTier('low')).toBe(5)
    expect(toolBudgetForTier('ultra')).toBeUndefined()
  })
})
