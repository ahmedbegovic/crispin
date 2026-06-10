import { statSync } from 'node:fs'
import { BrowserWindow, dialog } from 'electron'
import { handle } from '../ipc/router'
import type { OrionDatabase } from '../services/db'
import * as settings from '../services/settings'
import type { WorkspaceFs } from '../services/workspace-fs'
import type { TermService } from '../services/term-service'

export interface CodeFeatureDeps {
  db: OrionDatabase
  workspaceFs: WorkspaceFs
  terms: TermService
}

/** Registers every code.* and term.* IPC method. */
export function registerCodeFeature(deps: CodeFeatureDeps): void {
  const { db, workspaceFs, terms } = deps

  handle('code.pickWorkspace', async () => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    const options: Electron.OpenDialogOptions = {
      properties: ['openDirectory', 'createDirectory']
    }
    const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
    const path = result.canceled ? null : (result.filePaths[0] ?? null)
    if (path) settings.set(db, 'code.lastWorkspace', path)
    return { path }
  })

  handle('code.lastWorkspace', () => {
    const path = settings.get<string | null>(db, 'code.lastWorkspace', null)
    if (!path) return { path: null }
    try {
      return { path: statSync(path).isDirectory() ? path : null }
    } catch {
      return { path: null }
    }
  })

  handle('code.openWorkspace', ({ root }) => ({ entries: workspaceFs.openWorkspace(root) }))

  handle('code.closeWorkspace', async ({ root }) => {
    await workspaceFs.closeWorkspace(root)
    return { ok: true }
  })

  handle('code.listDir', ({ root, dir }) => ({ entries: workspaceFs.listDir(root, dir) }))

  handle('code.readFile', ({ root, path }) => workspaceFs.readFile(root, path))

  handle('code.writeFile', ({ root, path, content, expectedMtime }) =>
    workspaceFs.writeFile(root, path, content, expectedMtime)
  )

  handle('term.create', ({ cwd, cols, rows }) => ({ termId: terms.create(cwd, cols, rows) }))

  handle('term.write', ({ termId, data }) => {
    terms.write(termId, data)
    return { ok: true }
  })

  handle('term.resize', ({ termId, cols, rows }) => {
    terms.resize(termId, cols, rows)
    return { ok: true }
  })

  handle('term.kill', ({ termId }) => {
    terms.kill(termId)
    return { ok: true }
  })
}
