import { app, BrowserWindow, shell } from 'electron'
import { join } from 'node:path'
import { initLogging, log } from './services/logger'
import { openDatabase, type OrionDatabase } from './services/db'
import { allocatePort } from './services/ports'
import { ProcessManager } from './services/process-manager'
import { ToolsClient } from './services/tools-client'
import { dataDir, sidecarDir, uvBinary, uvEnvFor } from './services/paths'
import { attachRouter, handle } from './ipc/router'
import { broadcast } from './ipc/events'

app.setName('Orion')

if (!app.requestSingleInstanceLock()) {
  app.quit()
}

let win: BrowserWindow | null = null
let db: OrionDatabase | null = null

const processManager = new ProcessManager((snapshot) =>
  broadcast({ type: 'system.processState', process: snapshot })
)

const ports = { tools: 0 }

export const toolsClient = new ToolsClient(() => `http://127.0.0.1:${ports.tools}`)

async function createWindow(): Promise<void> {
  win = new BrowserWindow({
    width: 1360,
    height: 880,
    minWidth: 1080,
    minHeight: 700,
    show: false,
    title: 'Orion',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 13 },
    backgroundColor: '#0c0c0e',
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.cjs'),
      sandbox: true,
      contextIsolation: true
    }
  })

  win.on('ready-to-show', () => win?.show())
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    await win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    await win.loadFile(join(import.meta.dirname, '../renderer/index.html'))
  }
}

function registerIpcHandlers(): void {
  handle('system.status', () => ({
    version: app.getVersion(),
    dataDir: dataDir(),
    processes: processManager.snapshots()
  }))

  handle('system.restartProcess', async ({ name }) => {
    const proc = processManager.get(name)
    if (!proc) throw new Error(`No such process: ${name}`)
    await proc.restart('user request')
    return { ok: true }
  })

  handle('system.openLogs', async () => {
    await shell.openPath(join(dataDir(), 'logs'))
    return { ok: true }
  })
}

function registerSidecars(): void {
  processManager.register({
    name: 'tools',
    port: () => ports.tools || null,
    healthUrl: () => `http://127.0.0.1:${ports.tools}/healthz`,
    startTimeoutMs: 60_000, // first uv run may resolve the venv
    command: async () => {
      ports.tools = await allocatePort(47622)
      const dir = sidecarDir('tools')
      return {
        cmd: uvBinary(),
        args: ['run', '--project', dir, 'python', '-m', 'orion_tools', '--port', String(ports.tools)],
        cwd: dir,
        env: uvEnvFor('tools')
      }
    }
  })
}

app.whenReady().then(async () => {
  initLogging()
  log.info(`Orion ${app.getVersion()} starting (packaged: ${app.isPackaged})`)

  db = openDatabase(join(dataDir(), 'orion.db'))

  registerSidecars()
  registerIpcHandlers()
  attachRouter()

  await createWindow()

  void processManager.get('tools')?.start()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow()
  })
})

app.on('window-all-closed', () => {
  app.quit()
})

let quitting = false
app.on('before-quit', (event) => {
  if (quitting) return
  event.preventDefault()
  quitting = true
  void (async () => {
    try {
      await processManager.shutdown()
      db?.close()
    } catch (err) {
      log.warn(`shutdown error: ${err instanceof Error ? err.message : err}`)
    } finally {
      app.exit(0)
    }
  })()
})

export function getDb(): OrionDatabase {
  if (!db) throw new Error('Database not open yet')
  return db
}
