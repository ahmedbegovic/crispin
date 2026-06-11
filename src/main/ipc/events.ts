import { BrowserWindow } from 'electron'
import type { CrispinEvent } from '@shared/ipc'

/** Push an event to every renderer over the single multiplexed channel. */
export function broadcast(event: CrispinEvent): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('crispin:event', event)
  }
}
