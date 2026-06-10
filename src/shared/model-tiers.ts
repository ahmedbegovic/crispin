import type { Feature, Tier } from './types'

export type ModelCapability = 'text' | 'vision' | 'audio' | 'video'

export interface TierSpec {
  /** Ordered candidate HF repo ids; first installed+supported one wins. */
  candidates: string[]
  caps: ModelCapability[]
  /** Approximate weights footprint on disk / in memory at 4-bit, GB. */
  approxGB: number
  defaultCtx: number
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
    candidates: ['mlx-community/gemma-4-E2B-it-qat-4bit'],
    caps: ['text', 'vision', 'audio'],
    approxGB: 3,
    defaultCtx: 8192
  },
  medium: {
    candidates: ['mlx-community/gemma-4-E4B-it-qat-4bit'],
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
    // KV stays fp16: vllm-mlx only quantizes KV under continuous batching,
    // which cannot generate with gemma-4 — so the 32k ctx cap and noCoload
    // are what keep this one inside the budget.
    candidates: ['mlx-community/Qwen3.6-27B-4bit'],
    caps: ['text', 'vision', 'video'],
    approxGB: 16.5,
    defaultCtx: 32768,
    noCoload: true
  }
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
 * The library RAG embedder. Lives in the HF cache like any model but is
 * NOT a chat model: it must stay out of the engine chat registry and its
 * memory budget (served via /v1/embeddings, which bypasses the registry).
 */
export const EMBEDDING_MODEL = 'mlx-community/embeddinggemma-300m-6bit'

export interface RepoValidation {
  ok: boolean
  warning?: string
}

/** Reject known-broken quants unless the user explicitly overrides. */
export function validateModelRepo(repoId: string): RepoValidation {
  const id = repoId.toLowerCase()
  if (id.includes('gemma-4') && !id.includes('qat')) {
    return {
      ok: false,
      warning:
        'Non-QAT MLX quants of Gemma 4 produce garbage output (PLE quantization bug). Use the *-qat-* variant instead.'
    }
  }
  return { ok: true }
}
