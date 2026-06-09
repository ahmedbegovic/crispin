import log from 'electron-log/main'
import { app } from 'electron'
import { join } from 'node:path'

export function initLogging(): void {
  log.initialize()
  log.transports.file.resolvePathFn = (vars) =>
    join(app.getPath('userData'), 'logs', vars.fileName ?? 'main.log')
  log.transports.file.maxSize = 5 * 1024 * 1024
  log.transports.console.format = '[{h}:{i}:{s}.{ms}] [{scope}] {text}'
}

export function scopedLogger(scope: string) {
  return log.scope(scope)
}

export { log }
