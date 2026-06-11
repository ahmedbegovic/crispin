import type { Feature, Tier } from './types'

export type ModelCapability = 'text' | 'vision' | 'audio' | 'video'

export interface TierSpec {
  /** Ordered candidate HF repo ids; first installed+supported one wins. */
  candidates: string[]
  caps: ModelCapability[]
  /** Approximate weights footprint on disk / in memory at 4-bit, GB. */
  approxGB: number
  /**
   * Display fallback when the real context_length (read from the installed
   * snapshot's config.json) is unknown. Nothing enforces this as a cap.
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
    defaultCtx: 8192
  },
  medium: {
    candidates: ['mlx-community/gemma-4-E4B-it-qat-4bit', 'mlx-community/Qwen3.5-4B-4bit'],
    caps: ['text', 'vision', 'audio'],
    approxGB: 5,
    defaultCtx: 16384
  },
  high: {
    candidates: [
      'mlx-community/Qwen3.5-9B-MLX-4bit',
      'mlx-community/gemma-4-12B-it-qat-4bit'
    ],
    caps: ['text', 'vision'],
    approxGB: 7,
    defaultCtx: 32768
  },
  extraHigh: {
    candidates: ['mlx-community/gemma-4-26B-A4B-it-qat-4bit'],
    caps: ['text', 'vision'],
    approxGB: 15,
    defaultCtx: 32768
  },
  ultra: {
    // KV cache stays at oMLX defaults (TurboQuant KV quant not enabled yet),
    // so the 32k output cap and noCoload are what keep these inside the
    // budget. The 31B (~18.4 GB weights) only fits machines above 24 GB —
    // the fit badge tells that story honestly.
    candidates: ['mlx-community/Qwen3.6-27B-4bit', 'mlx-community/gemma-4-31b-it-4bit'],
    caps: ['text', 'vision', 'video'],
    approxGB: 16.5,
    defaultCtx: 32768,
    maxOutputTokens: 32768,
    noCoload: true
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

/** Curated short names; repos outside the tier table get a prettified id. */
const MODEL_DISPLAY_NAMES: Record<string, string> = {
  'mlx-community/gemma-4-E2B-it-qat-4bit': 'Gemma 4 E2B',
  'mlx-community/gemma-4-E4B-it-qat-4bit': 'Gemma 4 E4B',
  'mlx-community/gemma-4-12B-it-qat-4bit': 'Gemma 4 12B',
  'mlx-community/gemma-4-26B-A4B-it-qat-4bit': 'Gemma 4 26B',
  'mlx-community/gemma-4-31b-it-4bit': 'Gemma 4 31B',
  'mlx-community/Qwen3.5-2B-4bit': 'Qwen 3.5 2B',
  'mlx-community/Qwen3.5-4B-4bit': 'Qwen 3.5 4B',
  'mlx-community/Qwen3.5-9B-MLX-4bit': 'Qwen 3.5 9B',
  'mlx-community/Qwen3.6-27B-4bit': 'Qwen 3.6 27B'
}

/** Human name for a repo id — quant/format suffixes stripped, org dropped. */
export function modelDisplayName(repoId: string): string {
  const curated = MODEL_DISPLAY_NAMES[repoId]
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
 * model: it stays out of Orion's chat registry, tiers, and the Models tab.
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
  return CURATED_REPOS.has(repoId)
}

/** Models grid column: curated repos go under their brand, everything else is Experimental. */
export function familyOf(repoId: string): CatalogFamily {
  if (!CURATED_REPOS.has(repoId)) return 'experimental'
  return repoId.toLowerCase().includes('gemma') ? 'gemma' : 'qwen'
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
