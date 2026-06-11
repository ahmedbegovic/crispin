import { app } from 'electron'
import { join } from 'node:path'

/** Repo root in dev; Resources/ in the packaged .app. */
export function resourcesRoot(): string {
  return app.isPackaged ? process.resourcesPath : app.getAppPath()
}

export function sidecarDir(name: 'engine' | 'tools'): string {
  return join(resourcesRoot(), 'sidecars', name)
}

export function dataDir(): string {
  return app.getPath('userData')
}

/** Bundled static assets (MCP shims etc.): resources/ in dev, Resources/ packaged. */
export function resourcesDir(): string {
  return app.isPackaged ? process.resourcesPath : join(app.getAppPath(), 'resources')
}

/**
 * uv binary: dev uses PATH; packaged app ships a pinned binary in Resources/bin.
 * Sidecar venvs live outside the read-only .app (created by first-run bootstrap).
 */
export function uvBinary(): string {
  return app.isPackaged ? join(process.resourcesPath, 'bin', 'uv') : 'uv'
}

export function uvEnvFor(name: 'engine' | 'tools'): Record<string, string> {
  if (!app.isPackaged) return {}
  return {
    // Use the shipped lockfile verbatim — an implicit re-lock would write
    // uv.lock into the signed (possibly read-only) bundle. predist runs
    // `uv lock --check`, so staleness fails at dist time, not on user machines.
    UV_FROZEN: '1',
    UV_PROJECT_ENVIRONMENT: join(dataDir(), 'venvs', name),
    UV_PYTHON_INSTALL_DIR: join(dataDir(), 'uv', 'python'),
    // The sidecar sources run straight from Resources/ — keep CPython from
    // writing __pycache__ into the bundle (same seal-breaking problem).
    PYTHONDONTWRITEBYTECODE: '1'
  }
}

/**
 * The real opencode executable (the .bin symlink does not survive packing,
 * and binaries cannot execute from inside app.asar — it ships unpacked).
 */
export function opencodeBinary(): string {
  const rel = join('node_modules', 'opencode-darwin-arm64', 'bin', 'opencode')
  return app.isPackaged
    ? join(process.resourcesPath, 'app.asar.unpacked', rel)
    : join(app.getAppPath(), rel)
}

/**
 * How to run a bundled Node script (the crispin-web MCP shim): dev relies on
 * PATH, the packaged app reuses its own Electron binary in Node mode — users
 * cannot be assumed to have node installed.
 */
export function nodeRunner(): { command: string; env: Record<string, string> } {
  return app.isPackaged
    ? { command: process.execPath, env: { ELECTRON_RUN_AS_NODE: '1' } }
    : { command: 'node', env: {} }
}
