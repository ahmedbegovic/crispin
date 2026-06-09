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
    UV_PROJECT_ENVIRONMENT: join(dataDir(), 'venvs', name),
    UV_PYTHON_INSTALL_DIR: join(dataDir(), 'uv', 'python')
  }
}
