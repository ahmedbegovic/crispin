import { app, BrowserWindow } from 'electron'
import { crispinEventSchema, type CrispinEvent } from '@shared/ipc'
import { scopedLogger } from '../services/logger'

const log = scopedLogger('ipc')

/**
 * Validate one outbound event against the contract. Returns whether it matched
 * (so it is unit-testable without a window) and logs the first divergence. The
 * event half of the contract is otherwise never runtime-checked on either side;
 * this is its only backstop.
 */
export function checkEvent(event: unknown): boolean {
  const result = crispinEventSchema.safeParse(event)
  if (!result.success) {
    const type = (event as { type?: unknown } | null)?.type
    const issue = result.error.issues[0]
    const detail = issue ? `${issue.path.join('.')} ${issue.message}` : 'invalid'
    log.warn(`event ${String(type)} failed schema: ${detail}`)
  }
  return result.success
}

/** Push an event to every renderer over the single multiplexed channel. */
export function broadcast(event: CrispinEvent): void {
  // Dev-only, mirroring the router's output-parse policy (router.ts): surface
  // our own outbound-shape drift loudly in dev, but NEVER drop or throw — these
  // fire mid-generation (chat.delta / chat.done) and a thrown parse would abort
  // a live stream. A packaged build trusts its own shapes.
  if (!app.isPackaged) checkEvent(event)
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('crispin:event', event)
  }
}
