import { contextBridge, ipcRenderer } from 'electron'

const api = {
  call: (method: string, input: unknown): Promise<unknown> =>
    ipcRenderer.invoke('orion:call', method, input),
  onEvent: (callback: (event: unknown) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: unknown): void => callback(payload)
    ipcRenderer.on('orion:event', listener)
    return () => {
      ipcRenderer.removeListener('orion:event', listener)
    }
  }
}

contextBridge.exposeInMainWorld('orion', api)

export type OrionBridge = typeof api
