import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { AppSettings } from '@shared/ipc'
import type { InstalledModel } from '@shared/types'
import {
  TIERS,
  maxOutputTokensFor,
  modelDisplayName,
  tierOfRepo,
  type TierSpec
} from '@shared/model-tiers'
import { engineModelId } from './engine-client'
import { dataDir, nodeRunner, resourcesDir } from './paths'

/** What consult_model can reach: tier -> active model (engine id) + footprint. */
export interface ConsultTierMap {
  [tier: string]: { modelId: string; estGB: number; label: string }
}

export interface OpencodeConfigOptions {
  enginePort: number
  toolsPort: number
  /** Installed chat models (modelService.overview().installed). */
  models: InstalledModel[]
  /** Rendered Settings profile + instructions markdown; '' = nothing to inject. */
  instructionsText: string
  /** Cross-model consultation env for the MCP server (P2-14). */
  consult: { tierMap: ConsultTierMap; budgetGB: number }
}

/** Settings → Profile/Instructions rendered for opencode's instructions array. */
export function renderInstructionsText(settings: AppSettings): string {
  const parts: string[] = []
  const userName = settings.profile.userName.trim()
  if (userName) parts.push(`The user's name is ${userName}.`)
  const assistantName = settings.profile.assistantName.trim()
  if (assistantName && assistantName !== 'Crispin') {
    parts.push(`The user calls this assistant ${assistantName}.`)
  }
  const global = settings.instructions.global.trim()
  if (global) parts.push(global)
  for (const [module, label] of [
    ['agent', 'Agent'],
    ['code', 'Code']
  ] as const) {
    const text = settings.instructions.perModule[module]?.trim()
    if (text) parts.push(`When working in the ${label} module:\n${text}`)
  }
  return parts.join('\n\n')
}

const tierSpecFor = (repoId: string): TierSpec | undefined => {
  const tier = tierOfRepo(repoId) // rename-aware: old-id snapshots keep their tier's limits
  return tier ? TIERS[tier] : undefined
}

export function opencodeConfigPath(): string {
  return join(dataDir(), 'opencode', 'opencode.json')
}

/**
 * Order-insensitive fingerprint of everything the generated config depends
 * on — a running server whose key drifted is serving a stale config (engine
 * port moved, model installed/removed) and must be respawned before use.
 */
export function opencodeConfigKey(opts: OpencodeConfigOptions): string {
  return JSON.stringify([
    opts.enginePort,
    opts.toolsPort,
    opts.models.map((m) => [m.repoId, m.contextLength]).sort(),
    // Instructions ride the config (instructions.md) — edited Settings must
    // respawn stale servers exactly like a moved port.
    opts.instructionsText,
    // The consult tier map rides MCP env — tier selection changes must
    // respawn servers so consult_model sees the new active models.
    Object.entries(opts.consult.tierMap)
      .map(([tier, t]) => [tier, t.modelId])
      .sort()
  ])
}

/**
 * Write the opencode config — the contract between Electron main (writer) and
 * the `opencode serve` pool servers (readers, via OPENCODE_CONFIG). Rewritten
 * at every server spawn so ports and the model list are always current.
 * opencode merge-loads ~/.config/opencode/* first; this file wins for the
 * keys it sets. Pure function of its inputs.
 */
export function writeOpencodeConfig(opts: OpencodeConfigOptions): string {
  const models: Record<string, unknown> = {}
  for (const m of opts.models) {
    const spec = tierSpecFor(m.repoId)
    // Keyed by the ENGINE id: opencode forwards the key verbatim as the
    // OpenAI model param, and oMLX knows models by their flattened form.
    models[engineModelId(m.repoId)] = {
      name: modelDisplayName(m.repoId),
      limit: {
        context: m.contextLength ?? spec?.defaultCtx ?? 32768,
        // Only the big models carry an output cap (ultra tier + the 35B-A3B
        // override) — their fp16 KV growth on a runaway generation is what would
        // blow the RAM budget. maxOutputTokensFor consults the per-model override.
        output: maxOutputTokensFor(m.repoId) ?? m.contextLength ?? 32768
      }
    }
  }
  const config = {
    $schema: 'https://opencode.ai/config.json',
    provider: {
      crispin: {
        npm: '@ai-sdk/openai-compatible',
        name: 'Crispin Local',
        options: { baseURL: `http://127.0.0.1:${opts.enginePort}/v1` },
        models
      }
    },
    mcp: {
      // The key prefixes the tool names (crispin_web_web_search). It must stay
      // hyphen-free: gemma emits tool calls for hyphenated names in a mangled
      // format the engine's gemma parser cannot parse (verified live).
      crispin_web: {
        type: 'local',
        // Packaged: the app's own Electron binary in Node mode — users cannot
        // be assumed to have node on PATH.
        command: [nodeRunner().command, join(resourcesDir(), 'crispin-web-mcp.mjs')],
        environment: {
          CRISPIN_TOOLS_URL: `http://127.0.0.1:${opts.toolsPort}`,
          // Cross-model consultation (crispin_web_consult_model / _list_tiers).
          CRISPIN_ENGINE_URL: `http://127.0.0.1:${opts.enginePort}`,
          CRISPIN_TIER_MAP: JSON.stringify(opts.consult.tierMap),
          CRISPIN_ENGINE_BUDGET_GB: String(opts.consult.budgetGB),
          ...nodeRunner().env
        },
        enabled: true
      }
    },
    instructions: [join(dataDir(), 'memory', '*.md')],
    // Top-level = Normal mode. The named agents below carry the other
    // permission modes; agent-service picks one per prompt (P2-13).
    permission: { edit: 'ask', bash: 'ask', webfetch: 'allow' },
    agent: {
      // Built-in plan agent — pin edit deny explicitly (belt and braces;
      // agent-service also auto-rejects edit asks in plan mode).
      plan: {
        permission: { edit: 'deny', bash: 'ask', webfetch: 'allow' }
      },
      acceptEdits: {
        mode: 'primary',
        description: 'Edits land without asking; shell commands still ask.',
        permission: { edit: 'allow', bash: 'ask', webfetch: 'allow' }
      },
      auto: {
        mode: 'primary',
        description: 'Everything pre-approved — edits, shell and web.',
        permission: { edit: 'allow', bash: 'allow', webfetch: 'allow' }
      }
    }
  }
  const path = opencodeConfigPath()
  mkdirSync(dirname(path), { recursive: true })
  if (opts.instructionsText.trim()) {
    const instructionsPath = join(dirname(path), 'instructions.md')
    atomicWrite(instructionsPath, opts.instructionsText.trim() + '\n')
    config.instructions.push(instructionsPath)
  }
  // Write-temp-then-rename (atomic on APFS): both pool slots read this one
  // path at boot, and a reader must never observe a truncated file — losing
  // the permission block would drop the edit/bash ask gate for that server.
  atomicWrite(path, JSON.stringify(config, null, 2) + '\n')
  return path
}

function atomicWrite(path: string, content: string): void {
  const tmp = `${path}.${crypto.randomUUID()}.tmp`
  writeFileSync(tmp, content)
  renameSync(tmp, path)
}
