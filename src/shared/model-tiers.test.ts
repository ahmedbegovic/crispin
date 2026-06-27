import { describe, it, expect } from 'vitest'
import {
  validateModelRepo,
  candidateWarning,
  canonicalRepoId,
  isCuratedRepo,
  familyOf,
  selectionFamilyOf,
  repoForFamilyTier,
  resolveLadderRepo,
  maxOutputTokensFor,
  isNoColoadRepo,
  tierOfRepo,
  tierSpecFor,
  classifyByParams,
  estimateGB,
  estimateLoadGB,
  isOffloadableRepo,
  fitFor,
  kvQuantBitsFor,
  modelDisplayName,
  toolBudgetForTier,
  FAMILIES,
  FAMILY_LADDERS,
  FAMILY_LABELS,
  TIER_LABELS,
  TIERS,
  TIER_ORDER,
  UTILITY_MODEL,
  EMBEDDING_MODEL,
  NON_QAT_GEMMA_WHITELIST
} from './model-tiers'
import type { Family } from './types'

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

describe('estimateLoadGB — expert-offload-aware footprint', () => {
  const QWEN35 = 'mlx-community/Qwen3.6-35B-A3B-4bit'
  const QWEN35_BYTES = 17.5e9 // ~19.25 GB full, over the 18.5 GB budget without offload

  it('equals the full estimate when offload is off', () => {
    expect(estimateLoadGB(QWEN35, QWEN35_BYTES, 0)).toBeCloseTo(19.25, 5)
  })
  it('drops a big MoE to its measured offloaded resident when offload is on', () => {
    // Only this offloaded ~11 GB fits the 18.5 GB budget — the whole point of the fix.
    expect(estimateLoadGB(QWEN35, QWEN35_BYTES, 6)).toBeCloseTo(11, 5)
  })
  it('scales the estimate with the cache size (each GB of cache ≈ 1 GB resident)', () => {
    expect(estimateLoadGB(QWEN35, QWEN35_BYTES, 8)).toBeCloseTo(13, 5)
    expect(estimateLoadGB(QWEN35, QWEN35_BYTES, 3)).toBeCloseTo(8, 5)
  })
  it('never estimates MORE than the full resident, however large the cache', () => {
    expect(estimateLoadGB(QWEN35, QWEN35_BYTES, 30)).toBeCloseTo(19.25, 5)
  })
  it('leaves non-offloadable models at their full estimate even with offload on', () => {
    expect(isOffloadableRepo('mlx-community/Qwen3.5-4B-MLX-4bit')).toBe(false)
    expect(estimateLoadGB('mlx-community/Qwen3.5-4B-MLX-4bit', 3e9, 6)).toBeCloseTo(3.3, 5)
  })
  it('marks the curated big MoEs as offloadable', () => {
    expect(isOffloadableRepo(QWEN35)).toBe(true)
    expect(isOffloadableRepo('mlx-community/gemma-4-26B-A4B-it-qat-4bit')).toBe(true)
  })
})

describe('fitFor — stable traffic-light fit against the static budget', () => {
  const budget = 18.5 // > 0.9 = 16.65, > 0.7 = 12.95
  it('classifies by size against the budget (unable > risky > good > perfect)', () => {
    expect(fitFor(20, budget)).toBe('unable') // exceeds budget
    expect(fitFor(17, budget)).toBe('risky') // > 90% of budget
    expect(fitFor(14, budget)).toBe('good') // > 70% of budget
    expect(fitFor(5, budget)).toBe('perfect')
  })
  it('is MONOTONIC — a smaller model never ranks worse than a larger one', () => {
    const order = ['perfect', 'good', 'risky', 'unable']
    const sizes = [1.5, 3, 7, 12, 15, 17.5, 20]
    const ranks = sizes.map((g) => order.indexOf(fitFor(g, budget)))
    for (let i = 1; i < ranks.length; i++) expect(ranks[i]).toBeGreaterThanOrEqual(ranks[i - 1])
  })
  it('does NOT depend on live free memory (no flicker): same estGB → same verdict', () => {
    // E4B (~3 GB) is always perfect; the 12B (~7.7) is always perfect too — a
    // smaller model can no longer show "won't fit" beside a larger "perfect".
    expect(fitFor(3, budget)).toBe('perfect')
    expect(fitFor(7.7, budget)).toBe('perfect')
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

describe('family ladders — the (family × rung) source of truth', () => {
  it('derives each tier’s candidates from the ladders, gemma first', () => {
    for (const tier of TIER_ORDER) {
      expect(TIERS[tier].candidates).toEqual([FAMILY_LADDERS.gemma[tier], FAMILY_LADDERS.qwen[tier]])
    }
    // candidates[0] gemma-first keeps UTILITY_MODEL the gemma E2B.
    expect(UTILITY_MODEL).toBe(FAMILY_LADDERS.gemma.low)
    expect(UTILITY_MODEL).toBe('mlx-community/gemma-4-E2B-it-qat-4bit')
  })

  it('repoForFamilyTier resolves all ten cells, including the new Qwen 35B', () => {
    expect(repoForFamilyTier('gemma', 'low')).toBe('mlx-community/gemma-4-E2B-it-qat-4bit')
    expect(repoForFamilyTier('gemma', 'ultra')).toBe('mlx-community/gemma-4-31b-it-4bit')
    expect(repoForFamilyTier('qwen', 'extraHigh')).toBe('mlx-community/Qwen3.6-35B-A3B-4bit')
    expect(repoForFamilyTier('qwen', 'ultra')).toBe('mlx-community/Qwen3.6-27B-4bit')
  })

  it('the new Qwen 35B is curated at extraHigh, qwen family, with a display name', () => {
    const id = 'mlx-community/Qwen3.6-35B-A3B-4bit'
    expect(isCuratedRepo(id)).toBe(true)
    expect(tierOfRepo(id)).toBe('extraHigh')
    expect(familyOf(id)).toBe('qwen')
    expect(selectionFamilyOf(id)).toBe('qwen')
    expect(modelDisplayName(id)).toBe('Qwen 3.6 35B')
  })

  it('selectionFamilyOf is rename-aware and null for non-curated', () => {
    expect(selectionFamilyOf('mlx-community/gemma-4-12B-it-qat-4bit')).toBe('gemma')
    expect(selectionFamilyOf('mlx-community/Qwen3.5-4B-4bit')).toBe('qwen') // old id → canonical
    expect(selectionFamilyOf('some/random-model')).toBeNull()
  })

  it('relabels extraHigh to "Extra" and labels both families', () => {
    expect(TIER_LABELS.extraHigh).toBe('Extra')
    expect(FAMILIES).toEqual(['gemma', 'qwen'])
    expect(FAMILY_LABELS).toEqual({ gemma: 'Gemma', qwen: 'Qwen' })
  })
})

describe('per-model policy overrides — the 35B-A3B MoE guards', () => {
  const big = 'mlx-community/Qwen3.6-35B-A3B-4bit'
  it('gives the 35B ultra-grade KV/output/no-coload guards despite sitting at extraHigh', () => {
    expect(kvQuantBitsFor(big)).toBe(4) // override; extraHigh tier alone has none
    expect(maxOutputTokensFor(big)).toBe(32768)
    expect(isNoColoadRepo(big)).toBe(true)
  })
  it('leaves the gemma 26B at the plain extraHigh policy', () => {
    const g26 = 'mlx-community/gemma-4-26B-A4B-it-qat-4bit'
    expect(kvQuantBitsFor(g26)).toBeNull()
    expect(maxOutputTokensFor(g26)).toBeUndefined()
    expect(isNoColoadRepo(g26)).toBe(false)
  })
  it('keeps ultra-tier policy intact (tier-level, no override needed)', () => {
    expect(isNoColoadRepo('mlx-community/Qwen3.6-27B-4bit')).toBe(true)
    expect(maxOutputTokensFor('mlx-community/gemma-4-31b-it-4bit')).toBe(32768)
  })
})

describe('resolveLadderRepo — pure (family, tier) precedence', () => {
  const all = (): boolean => true
  const none = (): boolean => false
  const onlyInstalled =
    (...ids: string[]) =>
    (repoId: string): boolean =>
      ids.includes(repoId)
  const base = { defaultFamily: 'gemma' as Family, tierSelection: null as string | null }

  it('an explicit family pin returns that family’s exact cell when installed', () => {
    expect(
      resolveLadderRepo({ ...base, tier: 'high', family: 'qwen', installed: all })
    ).toBe(repoForFamilyTier('qwen', 'high'))
  })

  it('a pin cascades WITHIN the family (nearest rung down, then up) when the cell is absent', () => {
    // Pinned Qwen High, only Qwen Low installed → nearest installed rung of qwen.
    expect(
      resolveLadderRepo({
        ...base,
        tier: 'high',
        family: 'qwen',
        installed: onlyInstalled(repoForFamilyTier('qwen', 'low'))
      })
    ).toBe(repoForFamilyTier('qwen', 'low'))
  })

  it('a pinned family with nothing installed returns null (caller falls back)', () => {
    expect(resolveLadderRepo({ ...base, tier: 'high', family: 'qwen', installed: none })).toBeNull()
  })

  it('no pin: an explicit tierSelection wins (Experimental / cross-family pick)', () => {
    expect(
      resolveLadderRepo({
        tier: 'high',
        family: null,
        defaultFamily: 'gemma',
        tierSelection: 'some/experimental-9B',
        installed: all
      })
    ).toBe('some/experimental-9B')
  })

  it('no pin: prefers the default family’s cell, else the other family’s', () => {
    expect(
      resolveLadderRepo({ ...base, tier: 'high', family: null, installed: all })
    ).toBe(repoForFamilyTier('gemma', 'high'))
    // default gemma not installed, qwen is → other family.
    expect(
      resolveLadderRepo({
        ...base,
        tier: 'high',
        family: null,
        installed: onlyInstalled(repoForFamilyTier('qwen', 'high'))
      })
    ).toBe(repoForFamilyTier('qwen', 'high'))
  })

  it('no pin with nothing installed returns null', () => {
    expect(resolveLadderRepo({ ...base, tier: 'high', family: null, installed: none })).toBeNull()
  })
})
