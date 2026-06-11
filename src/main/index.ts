import { app, BrowserWindow, net, protocol, shell } from 'electron'
import { execSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { initLogging, log } from './services/logger'
import { openDatabase, type OrionDatabase } from './services/db'
import { allocatePort } from './services/ports'
import { ProcessManager } from './services/process-manager'
import { ToolsClient } from './services/tools-client'
import { EngineClient } from './services/engine-client'
import { RamGuard } from './services/ram-guard'
import { MacosMemory } from './services/macos-memory'
import { ModelService } from './services/model-service'
import {
  dataDir,
  opencodeBinary,
  resourcesRoot,
  sidecarDir,
  uvBinary,
  uvEnvFor
} from './services/paths'
import { ChatRepo } from './services/chat/repo'
import { ChatOrchestrator } from './services/chat/orchestrator'
import { LibraryService } from './services/library-service'
import { ResearchOrchestrator } from './services/research-orchestrator'
import { NewsScheduler } from './services/news-scheduler'
import { McpManager } from './services/mcp-manager'
import { SkillsService } from './services/skills'
import { AppSettingsService } from './services/app-settings'
import { renderInstructionsText } from './services/opencode-config'
import { OpencodePool } from './services/opencode-pool'
import { AgentService } from './services/agent-service'
import { WorkspaceFs } from './services/workspace-fs'
import { TermService } from './services/term-service'
import { registerModelsFeature } from './features/models'
import { registerSettingsFeature } from './features/settings'
import { registerChatFeature } from './features/chat'
import { registerLibraryFeature } from './features/library'
import { registerMcpFeature } from './features/mcp'
import { registerSkillsFeature } from './features/skills'
import { registerAgentFeature } from './features/agent'
import { registerCodeFeature } from './features/code'
import { registerResearchFeature } from './features/research'
import { registerNewsFeature } from './features/news'
import { attachRouter, handle } from './ipc/router'
import { broadcast } from './ipc/events'

app.setName('Orion')

// Must run before app ready: chat markdown references copied attachments as
// orion-attachment://<name>, served strictly from dataDir()/attachments.
protocol.registerSchemesAsPrivileged([
  { scheme: 'orion-attachment', privileges: { secure: true, stream: true } }
])

if (!app.requestSingleInstanceLock()) {
  app.quit()
}

let win: BrowserWindow | null = null
let db: OrionDatabase | null = null
let modelService: ModelService | null = null
let orchestrator: ChatOrchestrator | null = null
let libraryService: LibraryService | null = null
let researchOrchestrator: ResearchOrchestrator | null = null
let newsScheduler: NewsScheduler | null = null
let mcpManager: McpManager | null = null
let opencodePool: OpencodePool | null = null
let workspaceFs: WorkspaceFs | null = null
let termService: TermService | null = null

// Live child pids persisted to runtime.json so a crashed app's orphans can be
// swept at the next boot (a clean quit kills the process groups itself).
const livePids = new Map<string, number>()
const runtimePath = (): string => join(dataDir(), 'runtime.json')
function persistRuntime(): void {
  try {
    writeFileSync(runtimePath(), JSON.stringify({ pids: Object.fromEntries(livePids) }) + '\n')
  } catch {
    // best-effort — never let bookkeeping break supervision
  }
}

function sweepStaleProcesses(): void {
  try {
    const saved = JSON.parse(readFileSync(runtimePath(), 'utf8')) as {
      pids?: Record<string, number>
    }
    // Pids get recycled — only kill ones whose command is something the
    // supervisor itself spawns. Substring matches (e.g. /orion/i) would hit
    // our own Electron helpers and, in dev, anything with the repo path in argv.
    const ours = [
      `${uvBinary()} run --project ${join(resourcesRoot(), 'sidecars')}`, // tools/engine wrappers
      opencodeBinary() // opencode servers (absolute path in both modes)
    ]
    for (const [name, pid] of Object.entries(saved.pids ?? {})) {
      try {
        const cmd = execSync(`ps -p ${pid} -o command=`, { encoding: 'utf8' }).trim()
        if (!ours.some((prefix) => cmd.startsWith(prefix))) continue
        // Every supervised child leads its own group (detached spawn) — if the
        // group kill misses, the pid was never ours; no kill(pid) fallback.
        process.kill(-pid, 'SIGKILL')
        log.warn(`swept stale ${name} process (pid ${pid}) from a previous run`)
      } catch {
        // not running anymore
      }
    }
  } catch {
    // no runtime file yet
  }
  persistRuntime()
}

const processManager = new ProcessManager((snapshot) => {
  // Track every live child, whatever its state — pid is non-null exactly while
  // one is alive (onExit nulls it first). Keying on 'running' would drop the
  // long packaged-first-run uv sync and the engine's 'unhealthy' cold loads
  // from runtime.json, leaving unsweepable orphans after a crash there.
  if (snapshot.pid !== null) {
    livePids.set(snapshot.name, snapshot.pid)
  } else {
    livePids.delete(snapshot.name)
  }
  persistRuntime()
  broadcast({ type: 'system.processState', process: snapshot })
  // The exact event the news drain's waitForTools polls for — its ~30s budget
  // loses to the packaged first boot (uv sync, up to 600s); the kick is
  // idempotent (single-flight guards + conditional GETs) and covers restarts.
  if (snapshot.name === 'tools' && snapshot.state === 'running') {
    void newsScheduler?.refresh()
  }
})

const ports = { tools: 0, engine: 0 }

export const toolsClient = new ToolsClient(() => `http://127.0.0.1:${ports.tools}`)
export const engineClient = new EngineClient(() => `http://127.0.0.1:${ports.engine}`)

const macosMemory = new MacosMemory()
const ramGuard = new RamGuard(macosMemory)

/** Renderer pings (throttled) land here; the model service's idle sweep reads it. */
let lastAppActivityAt = Date.now()

async function createWindow(): Promise<void> {
  win = new BrowserWindow({
    width: 1360,
    height: 880,
    minWidth: 1080,
    minHeight: 700,
    show: false,
    title: 'Orion',
    titleBarStyle: 'hiddenInset',
    // Centered in the 48px titlebar band every column's content clears (pt-12).
    trafficLightPosition: { x: 12, y: 17 },
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
  // A sandboxed iframe (the research report) may navigate ITSELF on a plain
  // link click — never load the web inside the app; hand it to the browser.
  win.webContents.on('will-frame-navigate', (event) => {
    if (!event.isMainFrame && /^https?:/i.test(event.url)) {
      event.preventDefault()
      void shell.openExternal(event.url)
    }
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
    // A restart outside the pool would leave the server without an SSE pump
    // (permission asks lost) and outside the LRU/idle lifecycle.
    if (name.startsWith('opencode:')) {
      throw new Error('opencode servers are managed by the agent pool')
    }
    const proc = processManager.get(name)
    if (!proc) throw new Error(`No such process: ${name}`)
    await proc.restart('user request')
    return { ok: true }
  })

  handle('system.openLogs', async () => {
    await shell.openPath(join(dataDir(), 'logs'))
    return { ok: true }
  })

  handle('system.activity', () => {
    lastAppActivityAt = Date.now()
    return { ok: true }
  })
}

function registerSidecars(): void {
  processManager.register({
    name: 'tools',
    port: () => ports.tools || null,
    healthUrl: () => `http://127.0.0.1:${ports.tools}/healthz`,
    // Packaged first run uv-syncs the venv (and may download a Python).
    startTimeoutMs: app.isPackaged ? 600_000 : 60_000,
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

  // Serve chat-attachment images to the renderer; the prefix check jails the
  // lookup inside the attachments dir whatever the URL says.
  const attachmentsDir = join(dataDir(), 'attachments')
  protocol.handle('orion-attachment', (request) => {
    const rel = decodeURIComponent(request.url.replace(/^orion-attachment:\/*/i, ''))
    const target = resolve(attachmentsDir, rel)
    if (!target.startsWith(attachmentsDir + sep)) {
      return new Response('forbidden', { status: 403 })
    }
    return net.fetch(pathToFileURL(target).toString())
  })

  macosMemory.start()
  sweepStaleProcesses()
  registerSidecars()
  registerIpcHandlers()

  const appSettings = new AppSettingsService({ db, broadcast })
  registerSettingsFeature(appSettings)

  modelService = new ModelService({
    db,
    tools: toolsClient,
    engine: engineClient,
    ramGuard,
    processManager,
    appSettings,
    getEnginePort: () => ports.engine,
    getLastAppActivityAt: () => lastAppActivityAt,
    // Constructed later in this function — lazy reads through the module lets.
    isResearchActive: () => researchOrchestrator?.hasActiveRuns() ?? false,
    isNewsBusy: () => newsScheduler?.isBusy() ?? false,
    broadcast
  })
  registerModelsFeature({ processManager, modelService, engineClient, ports })

  const chatRepo = new ChatRepo(db)
  const skillsService = new SkillsService()
  skillsService.init()
  mcpManager = new McpManager(db)
  const models = modelService
  libraryService = new LibraryService({
    db,
    tools: toolsClient,
    processManager,
    getEnginePort: () => ports.engine,
    hasRegistryModels: () => models.hasRegistryModels(),
    broadcast
  })
  libraryService.init()
  orchestrator = new ChatOrchestrator({
    db,
    repo: chatRepo,
    engine: engineClient,
    tools: toolsClient,
    modelService,
    mcp: mcpManager,
    skills: skillsService,
    library: libraryService,
    appSettings,
    broadcast
  })
  registerChatFeature({ repo: chatRepo, orchestrator, modelService })
  registerLibraryFeature(libraryService)
  registerMcpFeature(mcpManager)
  registerSkillsFeature(skillsService)

  researchOrchestrator = new ResearchOrchestrator({
    db,
    engine: engineClient,
    tools: toolsClient,
    modelService,
    library: libraryService,
    appSettings,
    broadcast
  })
  registerResearchFeature(researchOrchestrator)

  newsScheduler = new NewsScheduler({
    db,
    tools: toolsClient,
    engine: engineClient,
    modelService,
    appSettings,
    broadcast
  })
  registerNewsFeature(newsScheduler)

  opencodePool = new OpencodePool({
    processManager,
    getEnginePort: () => ports.engine,
    getToolsPort: () => ports.tools,
    installedModels: () => models.overview().installed,
    getInstructionsText: () => renderInstructionsText(appSettings.get())
  })
  const agentService = new AgentService({ db, pool: opencodePool, modelService, broadcast })
  agentService.init()
  registerAgentFeature(agentService)

  workspaceFs = new WorkspaceFs({ broadcast })
  termService = new TermService({ broadcast })
  registerCodeFeature({ db, workspaceFs, terms: termService })

  attachRouter()

  await createWindow()

  void processManager.get('tools')?.start()
  void modelService.init()
  researchOrchestrator.init()
  newsScheduler.init()

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
      // PTYs and fs watchers live entirely in main — kill them first so
      // nothing keeps streaming term.data/fsChanged into a closing window.
      termService?.dispose()
      await workspaceFs?.dispose()
      macosMemory.stop()
      modelService?.dispose()
      // Chat/research/news/library/MCP teardown must precede the sidecar
      // shutdown: abort in-flight generations and stop ingest pollers before
      // their servers die.
      orchestrator?.dispose()
      researchOrchestrator?.dispose()
      newsScheduler?.dispose()
      libraryService?.dispose()
      await mcpManager?.dispose()
      // The pool's idle timer and opencode servers must stop before the
      // supervisor shutdown so nothing tries to respawn mid-quit.
      await opencodePool?.dispose()
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
