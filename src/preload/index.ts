import { contextBridge, ipcRenderer, webUtils } from 'electron'

const api = {
  call: (method: string, input: unknown): Promise<unknown> =>
    ipcRenderer.invoke('orion:call', method, input),
  onEvent: (callback: (event: unknown) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: unknown): void => callback(payload)
    ipcRenderer.on('orion:event', listener)
    return () => {
      ipcRenderer.removeListener('orion:event', listener)
    }
  },
  /**
   * File.path is gone since Electron 32 — this is the only way the sandboxed
   * renderer can resolve a dropped/picked File to a filesystem path.
   */
  getPathForFile: (file: File): string => webUtils.getPathForFile(file)
}

contextBridge.exposeInMainWorld('orion', api)

export type OrionBridge = typeof api
