import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import type { OrionEvent } from '@shared/ipc'
import type { OrionDatabase } from './db'
import * as settings from './settings'
import { dataDir, opencodeBinary, sidecarDir, uvBinary } from './paths'
import type { EngineClient } from './engine-client'
import type { ProcessManager } from './process-manager'
import type { OpencodePool } from './opencode-pool'
import { scopedLogger } from './logger'

const execFileP = promisify(execFile)

const PIP_TIMEOUT_MS = 10 * 60_000
const FETCH_TIMEOUT_MS = 30_000

export type RuntimeComponent = 'engine' | 'tools' | 'opencode'

export interface RuntimesStatus {
  app: string
  engine: { omlx: string | null; pinned: boolean }
  tools: { packages: Record<string, string>; pinned: boolean }
  opencode: { version: string | null; customPath: string | null }
}

/** Key tools deps surfaced in Settings → Runtimes (also the -U upgrade set). */
const TOOLS_TOP_LEVEL = [
  'fastapi',
  'uvicorn',
  'httpx',
  'huggingface_hub',
  'lancedb',
  'trafilatura',
  'ddgs',
  'feedparser',
  'pymupdf4llm',
  'markitdown'
]

export interface RuntimeManagerDeps {
  db: OrionDatabase
  processManager: ProcessManager
  engine: EngineClient
  pool: OpencodePool
  broadcast: (event: OrionEvent) => void
}

/**
 * The pinned-venv marker is the whole trick: packaged spawns run
 * `uv run --project …` with UV_FROZEN=1, which re-syncs the venv to the
 * BUNDLED lock on every spawn — silently reverting any upgrade. The sidecar
 * command builders append `--no-sync` while the marker exists, and deleting
 * the marker (reset) makes the next spawn re-sync back to the bundled lock:
 * a mechanical, always-available rollback.
 */
export function pinMarkerPath(name: 'engine' | 'tools'): string {
  return join(dataDir(), 'venvs', name, '.orion-pinned')
}

export function isPinned(name: 'engine' | 'tools'): boolean {
  return existsSync(pinMarkerPath(name))
}

function venvDir(name: 'engine' | 'tools'): string {
  return app.isPackaged ? join(dataDir(), 'venvs', name) : join(sidecarDir(name), '.venv')
}

function venvPython(name: 'engine' | 'tools'): string {
  return join(venvDir(name), 'bin', 'python')
}

/** The opencode binary the pool should spawn — custom update first, else bundled. */
export function resolveOpencodeBinary(db: OrionDatabase): string {
  const custom = settings.get<string | null>(db, 'runtimes.opencodePath', null)
  return custom && existsSync(custom) ? custom : opencodeBinary()
}

export class RuntimeManager {
  private readonly log = scopedLogger('runtimes')
  /** One mutation at a time — pip installs must never interleave. */
  private busy = false

  constructor(private readonly deps: RuntimeManagerDeps) {}

  async status(): Promise<RuntimesStatus> {
    const [enginePackages, toolsPackages, opencodeVersion] = await Promise.all([
      this.pipList('engine'),
      this.pipList('tools'),
      this.opencodeVersion()
    ])
    const toolPkgs: Record<string, string> = {}
    for (const name of TOOLS_TOP_LEVEL) {
      const version = toolsPackages.get(name) ?? toolsPackages.get(name.replaceAll('_', '-'))
      if (version) toolPkgs[name] = version
    }
    return {
      app: app.getVersion(),
      engine: { omlx: enginePackages.get('omlx') ?? null, pinned: isPinned('engine') },
      tools: { packages: toolPkgs, pinned: isPinned('tools') },
      opencode: {
        version: opencodeVersion,
        customPath: settings.get<string | null>(this.deps.db, 'runtimes.opencodePath', null)
      }
    }
  }

  async checkLatest(): Promise<{ omlx: string | null; opencode: string | null }> {
    const [omlx, opencode] = await Promise.all([
      this.latestOmlxTag().catch((err) => {
        this.log.warn(`omlx tag check failed: ${err instanceof Error ? err.message : err}`)
        return null
      }),
      this.latestOpencode().catch((err) => {
        this.log.warn(`opencode check failed: ${err instanceof Error ? err.message : err}`)
        return null
      })
    ])
    return { omlx, opencode: opencode?.version ?? null }
  }

  async update(component: RuntimeComponent, version?: string): Promise<void> {
    if (this.busy) throw new Error('Another runtime update is already running')
    this.busy = true
    try {
      if (component === 'engine') await this.updateEngine(version)
      else if (component === 'tools') await this.updateTools()
      else await this.updateOpencode(version)
      this.deps.broadcast({ type: 'runtimes.changed' })
    } finally {
      this.busy = false
    }
  }

  async reset(component: RuntimeComponent): Promise<void> {
    if (component === 'opencode') {
      settings.set(this.deps.db, 'runtimes.opencodePath', null)
      // Next prompt respawns servers with the bundled binary.
      await this.deps.pool.stopAll()
    } else {
      // Delete the marker → the next spawn re-syncs to the bundled lock.
      try {
        unlinkSync(pinMarkerPath(component))
      } catch {
        // not pinned — nothing to do
      }
      await this.deps.processManager.get(component)?.restart('runtime reset')
    }
    this.deps.broadcast({ type: 'runtimes.changed' })
  }

  // --- per-component updates ---------------------------------------------------

  private async updateEngine(version?: string): Promise<void> {
    const { url } = this.omlxGitSource()
    const tag = version ?? (await this.latestOmlxTag())
    if (!tag) throw new Error('No omlx version to install')
    if (!(await this.engineIdle())) {
      throw new Error('The engine is busy — wait for the generation to finish.')
    }
    const previous = (await this.pipList('engine')).get('omlx') ?? null
    this.toast(`Installing omlx ${tag}…`)
    await execFileP(
      uvBinary(),
      ['pip', 'install', '--python', venvPython('engine'), `omlx @ git+${url}@${tag}`],
      { timeout: PIP_TIMEOUT_MS }
    )
    this.writeMarker('engine', { package: 'omlx', version: tag, previous })
    await this.deps.processManager.get('engine')?.restart(`omlx updated to ${tag}`)
    this.toast(`omlx ${tag} installed — engine restarted.`)
  }

  private async updateTools(): Promise<void> {
    const previous = Object.fromEntries(await this.pipList('tools'))
    this.toast('Upgrading tools dependencies…')
    await execFileP(
      uvBinary(),
      ['pip', 'install', '--python', venvPython('tools'), '-U', ...TOOLS_TOP_LEVEL],
      { timeout: PIP_TIMEOUT_MS }
    )
    this.writeMarker('tools', { package: 'top-level', version: 'latest', previous })
    await this.deps.processManager.get('tools')?.restart('tools dependencies upgraded')
    this.toast('Tools dependencies upgraded — sidecar restarted.')
  }

  private async updateOpencode(version?: string): Promise<void> {
    const meta = await this.latestOpencode(version)
    if (!meta) throw new Error('Could not resolve the opencode release')
    this.toast(`Downloading opencode ${meta.version}…`)
    const res = await fetch(meta.tarball, { signal: AbortSignal.timeout(5 * 60_000) })
    if (!res.ok) throw new Error(`tarball download failed: HTTP ${res.status}`)
    const bytes = Buffer.from(await res.arrayBuffer())
    const sha1 = createHash('sha1').update(bytes).digest('hex')
    if (meta.shasum && sha1 !== meta.shasum) {
      throw new Error(`tarball checksum mismatch (got ${sha1}, registry says ${meta.shasum})`)
    }
    const targetDir = join(dataDir(), 'bin', 'opencode', meta.version)
    rmSync(targetDir, { recursive: true, force: true })
    mkdirSync(targetDir, { recursive: true })
    const tgz = join(targetDir, 'package.tgz')
    writeFileSync(tgz, bytes)
    await execFileP('tar', ['-xzf', tgz, '-C', targetDir], { timeout: 60_000 })
    unlinkSync(tgz)
    const binary = join(targetDir, 'package', 'bin', 'opencode')
    if (!existsSync(binary)) throw new Error('Extracted tarball carries no bin/opencode')
    chmodSync(binary, 0o755)
    settings.set(this.deps.db, 'runtimes.opencodePath', binary)
    // Live servers keep the old binary — stop them; the next prompt respawns.
    await this.deps.pool.stopAll()
    this.toast(`opencode ${meta.version} installed — agents respawn on the next prompt.`)
  }

  // --- lookups -------------------------------------------------------------------

  /** Source of truth for the omlx repo: the engine pyproject's git pin. */
  private omlxGitSource(): { url: string; tag: string | null } {
    const pyproject = readFileSync(join(sidecarDir('engine'), 'pyproject.toml'), 'utf8')
    const match = /omlx\s*=\s*\{[^}]*git\s*=\s*"([^"]+)"[^}]*?(?:tag\s*=\s*"([^"]+)")?[^}]*\}/.exec(
      pyproject
    )
    if (!match) throw new Error('engine pyproject.toml carries no omlx git source')
    return { url: match[1], tag: match[2] ?? null }
  }

  private async latestOmlxTag(): Promise<string | null> {
    const { url } = this.omlxGitSource()
    const repo = /github\.com[/:]([^/]+\/[^/.]+)/.exec(url)?.[1]
    if (!repo) return null
    const res = await fetch(`https://api.github.com/repos/${repo}/tags?per_page=1`, {
      headers: { accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
    })
    if (!res.ok) throw new Error(`GitHub tags: HTTP ${res.status}`)
    const tags = (await res.json()) as Array<{ name?: string }>
    return tags[0]?.name ?? null
  }

  private async latestOpencode(
    version?: string
  ): Promise<{ version: string; tarball: string; shasum: string | null } | null> {
    const res = await fetch(
      `https://registry.npmjs.org/opencode-darwin-arm64/${version ?? 'latest'}`,
      { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) }
    )
    if (!res.ok) throw new Error(`npm registry: HTTP ${res.status}`)
    const meta = (await res.json()) as {
      version?: string
      dist?: { tarball?: string; shasum?: string }
    }
    if (!meta.version || !meta.dist?.tarball) return null
    return { version: meta.version, tarball: meta.dist.tarball, shasum: meta.dist.shasum ?? null }
  }

  private async pipList(name: 'engine' | 'tools'): Promise<Map<string, string>> {
    const python = venvPython(name)
    if (!existsSync(python)) return new Map()
    try {
      const { stdout } = await execFileP(
        uvBinary(),
        ['pip', 'list', '--format=json', '--python', python],
        { timeout: 60_000 }
      )
      const rows = JSON.parse(stdout) as Array<{ name: string; version: string }>
      return new Map(rows.map((r) => [r.name.toLowerCase(), r.version]))
    } catch (err) {
      this.log.warn(`pip list ${name} failed: ${err instanceof Error ? err.message : err}`)
      return new Map()
    }
  }

  private async opencodeVersion(): Promise<string | null> {
    try {
      const { stdout } = await execFileP(resolveOpencodeBinary(this.deps.db), ['--version'], {
        timeout: 15_000
      })
      return stdout.trim() || null
    } catch {
      return null
    }
  }

  private async engineIdle(): Promise<boolean> {
    if (this.deps.processManager.get('engine')?.snapshot().state !== 'running') return true
    try {
      const status = await this.deps.engine.status()
      return (status.numRunning ?? 0) === 0
    } catch {
      return false
    }
  }

  private writeMarker(
    name: 'engine' | 'tools',
    content: { package: string; version: string; previous: unknown }
  ): void {
    const path = pinMarkerPath(name)
    mkdirSync(join(dataDir(), 'venvs', name), { recursive: true })
    writeFileSync(path, JSON.stringify({ ...content, pinnedAt: Date.now() }, null, 2) + '\n')
  }

  private toast(message: string): void {
    this.deps.broadcast({ type: 'system.toast', level: 'info', message })
  }
}
