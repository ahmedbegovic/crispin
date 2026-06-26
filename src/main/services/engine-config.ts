import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { dataDir } from './paths'

export interface EngineConfigModel {
  /** Canonical HF repo id; run_engine maps to oMLX's '--' form. */
  name: string
  /** Per-model output budget: ctx-bounded for small tiers, 32k for ultra. */
  maxTokens: number
  /** Engine-side idle auto-unload; null disables it. */
  ttlSeconds: number | null
  /** TurboQuant KV-cache bits (oMLX per-model setting); null = full-precision KV. */
  kvQuantBits: number | null
}

export interface EngineConfigOptions {
  port: number
  models: EngineConfigModel[]
  budgetGB: number
  /** Crispin-owned paged SSD KV-cache dir (relocates oMLX's prefix cache). */
  cacheDir: string
  /** Hard cap on the paged SSD cache, GB — replaces oMLX's "auto" (≈10% of free disk). */
  cacheMaxSizeGB: number
}

export function engineConfigPath(): string {
  return join(dataDir(), 'engine', 'engine-config.json')
}

/** Crispin-managed oMLX paged-SSD cache directory (capped + clearable). */
export function omlxCacheDir(): string {
  return join(dataDir(), 'engine', 'omlx-cache')
}

/**
 * Write the engine config — the contract between Electron main (writer) and
 * run_engine.py (reader). Rewritten at every engine spawn so the port and
 * per-model settings are always current. oMLX discovers models from the HF
 * cache itself; the models list here only carries Crispin's per-model settings
 * (and fingerprints restarts via registryKey).
 */
/** One model's oMLX wire settings. Keys mirror run_engine.py's model_settings.json
 *  entry exactly — the contract both the spawn-time merge and the live
 *  rediscovery push (POST /v1/models/discover) write. */
export interface EngineModelWireSettings {
  name: string
  max_tokens: number
  enable_thinking: boolean
  ttl_seconds: number | null
  turboquant_kv_enabled: boolean
  turboquant_kv_bits: number
  turboquant_skip_last: boolean
}

/**
 * Build a model's oMLX wire settings. The single source of truth for the
 * per-model entry so the engine-config write (read by run_engine at spawn) and
 * the live rediscovery push can never disagree about a model's budget/KV policy.
 */
export function engineModelSettings(m: EngineConfigModel): EngineModelWireSettings {
  return {
    name: m.name,
    max_tokens: m.maxTokens,
    // Parsed into reasoning_content server-side — safe for OpenAI clients
    // (opencode) and wanted by the Chat tab's thought blocks.
    enable_thinking: true,
    ttl_seconds: m.ttlSeconds,
    // TurboQuant KV-cache quant. ALWAYS written (a Crispin-managed key, like
    // the others above) so flipping it off clears a prior `true` from the
    // shared model_settings.json instead of leaving it stale. bits/skip_last
    // are inert when disabled.
    turboquant_kv_enabled: m.kvQuantBits != null,
    turboquant_kv_bits: m.kvQuantBits ?? 4,
    turboquant_skip_last: true
  }
}

export function writeEngineConfig(opts: EngineConfigOptions): string {
  const config = {
    port: opts.port,
    memory_budget_gb: opts.budgetGB,
    cache: { dir: opts.cacheDir, max_size_gb: opts.cacheMaxSizeGB },
    models: opts.models.map(engineModelSettings)
  }
  const path = engineConfigPath()
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(config, null, 2) + '\n')
  return path
}
