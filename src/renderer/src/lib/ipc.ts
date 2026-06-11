import type {
  CallResult,
  MethodInput,
  MethodName,
  MethodOutput,
  CrispinEvent,
  CrispinEventOf,
  CrispinEventType
} from '@shared/ipc'

type CallArgs<M extends MethodName> = MethodInput<M> extends undefined ? [] : [MethodInput<M>]

export async function call<M extends MethodName>(
  method: M,
  ...args: CallArgs<M>
): Promise<MethodOutput<M>> {
  const result = (await window.crispin.call(method, args[0])) as CallResult<MethodOutput<M>>
  if (!result.ok) throw new Error(result.error)
  return result.data
}

const listeners = new Map<CrispinEventType, Set<(event: CrispinEvent) => void>>()
let bridgeAttached = false

function ensureBridge(): void {
  if (bridgeAttached) return
  bridgeAttached = true
  window.crispin.onEvent((payload) => {
    const event = payload as CrispinEvent
    listeners.get(event.type)?.forEach((cb) => cb(event))
  })
}

export function onEvent<T extends CrispinEventType>(
  type: T,
  callback: (event: CrispinEventOf<T>) => void
): () => void {
  ensureBridge()
  let set = listeners.get(type)
  if (!set) {
    set = new Set()
    listeners.set(type, set)
  }
  const cb = callback as (event: CrispinEvent) => void
  set.add(cb)
  return () => {
    set.delete(cb)
  }
}
