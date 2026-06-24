import type { Feature, Tier } from './types'

export type ModelCapability = 'text' | 'vision' | 'audio' | 'video'

export interface TierSpec {
  /** Ordered candidate HF repo ids; first installed+supported one wins. */
  candidates: string[]
  caps: ModelCapability[]
  /** Approximate weights footprint on disk / in memory at 4-bit, GB. */
  approxGB: number
  /**
   * Display fallback for the context window, used ONLY when the real
   * context_length — read from the installed snapshot's config.json
   * (max_position_embeddings) and surfaced via ModelService.contextLengthFor —
   * is unknown (e.g. the model isn't installed yet). An installed model's own
   * value always wins; this is never enforced as a cap. Each value mirrors the
   * preferred candidate's (candidates[0]) max_position_embeddings on Hugging
   * Face, so the fallback matches what the installed model will report.
   */
  defaultCtx: number
  /**
   * Per-request max_tokens the orchestrator sends for this tier. Unset means
   * the engine default (spawned at 131072 ≈ unlimited, bounded by context) —
   * small models get free rein on reasoning; only ultra is capped to keep a
   * runaway 27B generation's fp16 KV growth inside the RAM budget.
   */
  maxOutputTokens?: number
  /** If true this model may never share RAM with the utility model. */
  noCoload?: boolean
  /**
   * Cap on tools (builtin + MCP) shown to this tier. Tool-selection accuracy
   * collapses as the catalog grows — small models need a short list (~5 at 2B,
   * ~10–12 sub-14B). Unset = no cap.
   */
  maxVisibleTools?: number
  /**
   * TurboQuant KV-cache quantization width in bits (oMLX per-model setting,
   * `turboquant_kv_enabled`/`turboquant_kv_bits`). Unset = full-precision KV.
   * Enabled only where KV growth pressures the RAM budget; the small tiers fit
   * comfortably and skip it to avoid the (small) quality cost.
   */
  kvQuantBits?: number
}

/**
 * The six quality tiers. Single source of truth for model policy;
 * user overrides are stored in settings and merged over this table.
 *
 * All Gemma 4 entries MUST be QAT quants — non-QAT MLX quants of Gemma 4
 * produce garbage output because the PLE (per-layer embedding) layers get
 * quantized (see mlx-community/gemma-4-e2b-4bit discussion #1).
 */
export const TIERS: Record<Tier, TierSpec> = {
  low: {
    // gemma stays first: UTILITY_MODEL is candidates[0].
    candidates: ['mlx-community/gemma-4-E2B-it-qat-4bit', 'mlx-community/Qwen3.5-2B-4bit'],
    caps: ['text', 'vision', 'audio'],
    approxGB: 3,
    // candidates[0] gemma-4 E2B reports max_position_embeddings 131072 on HF.
    defaultCtx: 131072,
    maxVisibleTools: 5
  },
  medium: {
    candidates: ['mlx-community/gemma-4-E4B-it-qat-4bit', 'mlx-community/Qwen3.5-4B-MLX-4bit'],
    caps: ['text', 'vision', 'audio'],
    approxGB: 5,
    // candidates[0] gemma-4 E4B reports max_position_embeddings 131072 on HF.
    defaultCtx: 131072,
    maxVisibleTools: 8
  },
  high: {
    candidates: [
      'mlx-community/Qwen3.5-9B-MLX-4bit',
      'mlx-community/gemma-4-12B-it-qat-4bit'
    ],
    caps: ['text', 'vision'],
    approxGB: 7,
    // candidates[0] Qwen3.5 9B reports max_position_embeddings 262144 on HF.
    defaultCtx: 262144,
    maxVisibleTools: 12
  },
  extraHigh: {
    candidates: ['mlx-community/gemma-4-26B-A4B-it-qat-4bit'],
    caps: ['text', 'vision'],
    approxGB: 15,
    // candidates[0] gemma-4 26B reports max_position_embeddings 262144 on HF.
    defaultCtx: 262144,
    maxVisibleTools: 20
  },
  ultra: {
    // 4-bit TurboQuant KV (rotation + Lloyd-Max; `turboquant_skip_last` guards
    // quality) quarters KV growth on the tier that most pressures the budget.
    // The 32k output cap + noCoload deliberately STAY for now — they relax only
    // after the quant is validated live (see kvQuantBits below). The 31B
    // (~18.4 GB weights) only fits machines above 24 GB — the fit badge tells
    // that story honestly.
    candidates: ['mlx-community/Qwen3.6-27B-4bit', 'mlx-community/gemma-4-31b-it-4bit'],
    caps: ['text', 'vision', 'video'],
    approxGB: 16.5,
    // candidates[0] Qwen3.6 27B reports max_position_embeddings 262144 on HF.
    defaultCtx: 262144,
    maxOutputTokens: 32768,
    noCoload: true,
    kvQuantBits: 4
  }
}

/** Single source for tier display names — the "Extra High" rename lands here. */
export const TIER_LABELS: Record<Tier, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  extraHigh: 'Extra High',
  ultra: 'Ultra'
}

/**
 * Curated repo ids that were renamed (old → canonical). The old id may live on
 * in persisted state (tier selections, old chat messages) or even as a
 * downloaded snapshot — every comparison against the curated tables goes
 * through canonicalRepoId() so a rename never strands that state.
 */
export const RENAMED_REPOS: Record<string, string> = {
  // 0.20.0 shipped a repo id that never existed upstream; 928ad4e fixed it.
  'mlx-community/Qwen3.5-4B-4bit': 'mlx-community/Qwen3.5-4B-MLX-4bit'
}

export function canonicalRepoId(repoId: string): string {
  return RENAMED_REPOS[repoId] ?? repoId
}

/** Curated short names; repos outside the tier table get a prettified id. */
const MODEL_DISPLAY_NAMES: Record<string, string> = {
  'mlx-community/gemma-4-E2B-it-qat-4bit': 'Gemma 4 E2B',
  'mlx-community/gemma-4-E4B-it-qat-4bit': 'Gemma 4 E4B',
  'mlx-community/gemma-4-12B-it-qat-4bit': 'Gemma 4 12B',
  'mlx-community/gemma-4-26B-A4B-it-qat-4bit': 'Gemma 4 26B',
  'mlx-community/gemma-4-31b-it-4bit': 'Gemma 4 31B',
  'mlx-community/Qwen3.5-2B-4bit': 'Qwen 3.5 2B',
  'mlx-community/Qwen3.5-4B-MLX-4bit': 'Qwen 3.5 4B',
  'mlx-community/Qwen3.5-9B-MLX-4bit': 'Qwen 3.5 9B',
  'mlx-community/Qwen3.6-27B-4bit': 'Qwen 3.6 27B'
}

/** Human name for a repo id — quant/format suffixes stripped, org dropped. */
export function modelDisplayName(repoId: string): string {
  const curated = MODEL_DISPLAY_NAMES[canonicalRepoId(repoId)]
  if (curated) return curated
  const short = (repoId.split('/').pop() ?? repoId)
    // Lookahead keeps keyword-prefixed words intact ('-italian' is not '-it').
    .replace(/[-_](it|instruct|chat|mlx|qat|bf16|fp16|\d+bit|\d+-bit)(?=[-_.]|$)/gi, '')
    .replace(/[-_]+/g, ' ')
    .trim()
  return short || repoId
}

export const TIER_ORDER: Tier[] = ['low', 'medium', 'high', 'extraHigh', 'ultra']

/** Which tier each feature uses by default (user-overridable in settings). */
export const FEATURE_DEFAULTS: Record<Feature, Tier> = {
  chat: 'high',
  agent: 'extraHigh',
  code: 'extraHigh',
  research: 'high',
  news: 'low'
}

/** The only model allowed in the RAM guard's utility slot. */
export const UTILITY_MODEL = TIERS.low.candidates[0]

/**
 * The library RAG embedder. Lives in the HF cache like any model and is
 * served from the engine pool like any model (oMLX discovers it at startup,
 * /v1/embeddings counts against the memory guard) — but it is NOT a chat
 * model: it stays out of Crispin's chat registry, tiers, and the Models tab.
 */
export const EMBEDDING_MODEL = 'mlx-community/embeddinggemma-300m-6bit'

export interface RepoValidation {
  ok: boolean
  warning?: string
}

/**
 * Non-QAT Gemma 4 repos that are known-good despite the validator's rule:
 * the PLE quantization bug concerns the E-series; the 31B regular 4-bit quant
 * is explicitly accepted (curated in the ultra tier).
 */
export const NON_QAT_GEMMA_WHITELIST = new Set(['mlx-community/gemma-4-31b-it-4bit'])

/** Reject known-broken quants unless the user explicitly overrides. */
export function validateModelRepo(repoId: string): RepoValidation {
  const id = repoId.toLowerCase()
  if (NON_QAT_GEMMA_WHITELIST.has(repoId)) return { ok: true }
  if (id.includes('gemma-4') && !id.includes('qat')) {
    return {
      ok: false,
      warning:
        'Non-QAT MLX quants of Gemma 4 produce garbage output (PLE quantization bug). Use the *-qat-* variant instead.'
    }
  }
  return { ok: true }
}

// --- classification / fit (P2-5) --------------------------------------------

export type CatalogFamily = 'gemma' | 'qwen' | 'experimental'
export type ModelFit = 'perfect' | 'good' | 'risky' | 'unable'

const CURATED_REPOS = new Set(TIER_ORDER.flatMap((tier) => TIERS[tier].candidates))

export function isCuratedRepo(repoId: string): boolean {
  return CURATED_REPOS.has(canonicalRepoId(repoId))
}

/** Models grid column: curated repos go under their brand, everything else is Experimental. */
export function familyOf(repoId: string): CatalogFamily {
  if (!isCuratedRepo(repoId)) return 'experimental'
  return repoId.toLowerCase().includes('gemma') ? 'gemma' : 'qwen'
}

/** The tier a repo id is curated under (rename-aware); null when not curated. */
export function tierOfRepo(repoId: string): Tier | null {
  const id = canonicalRepoId(repoId)
  return TIER_ORDER.find((t) => TIERS[t].candidates.includes(id)) ?? null
}

/** The TierSpec a repo id is curated under (rename-aware); undefined when not. */
export function tierSpecFor(repoId: string): TierSpec | undefined {
  const tier = tierOfRepo(repoId)
  return tier ? TIERS[tier] : undefined
}

/** Visible-tool cap for a tier (builtin + MCP combined); undefined = no cap. */
export function toolBudgetForTier(tier: Tier): number | undefined {
  return TIERS[tier].maxVisibleTools
}

/**
 * TurboQuant KV-cache bits for a repo by its EFFECTIVE tier: curated repos
 * resolve through rename-aware tierOfRepo; anything else (a big experimental
 * download) falls back to classifyByParams, so it benefits too. Null = full-
 * precision KV. The `engine.kvQuant` override is applied by the caller
 * (model-service), not here — this is pure policy.
 */
export function kvQuantBitsFor(repoId: string, sizeBytes?: number | null): number | null {
  const tier = tierOfRepo(repoId) ?? classifyByParams(repoId, sizeBytes)
  return TIERS[tier].kvQuantBits ?? null
}

/**
 * First "<n>B" token in the repo basename ("26B-A4B"→26, "E2B"→2); the
 * lookahead rejects "4bit". Null when nothing parses.
 */
function paramsBFromName(repoId: string): number | null {
  const base = repoId.split('/').pop() ?? repoId
  const match = /(\d+(?:\.\d+)?)[bB](?![A-Za-z])/.exec(base)
  return match ? Number(match[1]) : null
}

/** Which tier an arbitrary (HF-downloaded) model belongs to, by parameter count. */
export function classifyByParams(repoId: string, sizeBytes?: number | null): Tier {
  // ≈0.55 GB per B parameters at 4-bit when the name doesn't say.
  const params = paramsBFromName(repoId) ?? (sizeBytes ? sizeBytes / 1e9 / 0.55 : null)
  if (params === null) return 'high' // unparseable and sizeless — middle of the road
  if (params <= 4) return 'low'
  if (params <= 8) return 'medium'
  if (params <= 12) return 'high'
  if (params <= 27) return 'extraHigh'
  return 'ultra'
}

/** Estimated load footprint in GB; null when not installed and the name doesn't parse. */
export function estimateGB(repoId: string, sizeBytes?: number | null): number | null {
  if (sizeBytes) return (sizeBytes / 1e9) * 1.1 // weights + ~10% runtime overhead
  const params = paramsBFromName(repoId)
  return params === null ? null : params * 0.55 + 0.6
}

/** Traffic-light fit against the engine budget and live available memory. */
export function fitFor(
  estGB: number,
  ram: { budgetGB: number; availableGB: number | null }
): ModelFit {
  if (estGB > ram.budgetGB) return 'unable'
  if (ram.availableGB !== null && estGB > ram.availableGB - 2) return 'risky'
  if (estGB > ram.budgetGB * 0.7) return 'good'
  return 'perfect'
}

// --- module-load consistency checks ------------------------------------------
// The curated tables are hand-maintained in lockstep; a missed edit must fail
// the very first dev launch, not degrade silently to a prettified name or a
// dangling alias. Pure static data: if this passes once it passes always.
for (const repoId of CURATED_REPOS) {
  if (!MODEL_DISPLAY_NAMES[repoId]) {
    throw new Error(`model-tiers: curated repo ${repoId} has no MODEL_DISPLAY_NAMES entry`)
  }
}
for (const [oldId, newId] of Object.entries(RENAMED_REPOS)) {
  if (!CURATED_REPOS.has(newId)) {
    throw new Error(`model-tiers: rename target ${newId} (from ${oldId}) is not a curated repo`)
  }
  if (CURATED_REPOS.has(oldId)) {
    throw new Error(`model-tiers: renamed repo ${oldId} must not stay in TIERS`)
  }
}
// KV-quant policy invariant: a set width must be a quant size oMLX accepts.
for (const tier of TIER_ORDER) {
  const bits = TIERS[tier].kvQuantBits
  if (bits !== undefined && bits !== 4 && bits !== 8) {
    throw new Error(`model-tiers: ${tier}.kvQuantBits must be 4 or 8 (got ${bits})`)
  }
}
