import { ipcMain } from 'electron'
import {
  contract,
  type CallResult,
  type MethodInput,
  type MethodName,
  type MethodOutput
} from '@shared/ipc'
import { scopedLogger } from '../services/logger'

type Handler<M extends MethodName> = (
  input: MethodInput<M>
) => Promise<MethodOutput<M>> | MethodOutput<M>

const handlers = new Map<MethodName, Handler<MethodName>>()

export function handle<M extends MethodName>(method: M, fn: Handler<M>): void {
  handlers.set(method, fn as Handler<MethodName>)
}

export function attachRouter(): void {
  const log = scopedLogger('ipc')
  ipcMain.handle(
    'crispin:call',
    async (_event, method: string, input: unknown): Promise<CallResult<unknown>> => {
      try {
        const def = contract[method as MethodName]
        const fn = handlers.get(method as MethodName)
        if (!def || !fn) throw new Error(`Unknown IPC method: ${method}`)
        const parsed = def.input.parse(input)
        const data = await fn(parsed as never)
        return { ok: true, data }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        log.warn(`${method} failed: ${message}`)
        return { ok: false, error: message }
      }
    }
  )
}
