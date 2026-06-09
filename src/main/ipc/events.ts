import { BrowserWindow } from 'electron'
import type { OrionEvent } from '@shared/ipc'

/** Push an event to every renderer over the single multiplexed channel. */
export function broadcast(event: OrionEvent): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('orion:event', event)
  }
}
