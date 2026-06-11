import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { AppSettings } from '@shared/ipc'
import type { InstalledModel } from '@shared/types'
import { TIERS, TIER_ORDER, modelDisplayName, type TierSpec } from '@shared/model-tiers'
import { engineModelId } from './engine-client'
import { dataDir, nodeRunner, resourcesDir } from './paths'

export interface OpencodeConfigOptions {
  enginePort: number
  toolsPort: number
  /** Installed chat models (modelService.overview().installed). */
  models: InstalledModel[]
  /** Rendered Settings profile + instructions markdown; '' = nothing to inject. */
  instructionsText: string
}

/** Settings → Profile/Instructions rendered for opencode's instructions array. */
export function renderInstructionsText(settings: AppSettings): string {
  const parts: string[] = []
  const userName = settings.profile.userName.trim()
  if (userName) parts.push(`The user's name is ${userName}.`)
  const assistantName = settings.profile.assistantName.trim()
  if (assistantName && assistantName !== 'Orion') {
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
  const tier = TIER_ORDER.find((t) => TIERS[t].candidates.includes(repoId))
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
    opts.instructionsText
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
        // Only ultra carries a cap (maxOutputTokens) — its fp16 KV growth on a
        // runaway generation is what would blow the RAM budget.
        output: spec?.maxOutputTokens ?? m.contextLength ?? 32768
      }
    }
  }
  const config = {
    $schema: 'https://opencode.ai/config.json',
    provider: {
      orion: {
        npm: '@ai-sdk/openai-compatible',
        name: 'Orion Local',
        options: { baseURL: `http://127.0.0.1:${opts.enginePort}/v1` },
        models
      }
    },
    mcp: {
      // The key prefixes the tool names (orion_web_web_search). It must stay
      // hyphen-free: gemma emits tool calls for hyphenated names in a mangled
      // format the engine's gemma parser cannot parse (verified live).
      orion_web: {
        type: 'local',
        // Packaged: the app's own Electron binary in Node mode — users cannot
        // be assumed to have node on PATH.
        command: [nodeRunner().command, join(resourcesDir(), 'orion-web-mcp.mjs')],
        environment: {
          ORION_TOOLS_URL: `http://127.0.0.1:${opts.toolsPort}`,
          ...nodeRunner().env
        },
        enabled: true
      }
    },
    instructions: [join(dataDir(), 'memory', '*.md')],
    permission: { edit: 'ask', bash: 'ask', webfetch: 'allow' }
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
