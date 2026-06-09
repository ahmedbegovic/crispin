import type {
  CallResult,
  MethodInput,
  MethodName,
  MethodOutput,
  OrionEvent,
  OrionEventOf,
  OrionEventType
} from '@shared/ipc'

type CallArgs<M extends MethodName> = MethodInput<M> extends undefined ? [] : [MethodInput<M>]

export async function call<M extends MethodName>(
  method: M,
  ...args: CallArgs<M>
): Promise<MethodOutput<M>> {
  const result = (await window.orion.call(method, args[0])) as CallResult<MethodOutput<M>>
  if (!result.ok) throw new Error(result.error)
  return result.data
}

const listeners = new Map<OrionEventType, Set<(event: OrionEvent) => void>>()
let bridgeAttached = false

function ensureBridge(): void {
  if (bridgeAttached) return
  bridgeAttached = true
  window.orion.onEvent((payload) => {
    const event = payload as OrionEvent
    listeners.get(event.type)?.forEach((cb) => cb(event))
  })
}

export function onEvent<T extends OrionEventType>(
  type: T,
  callback: (event: OrionEventOf<T>) => void
): () => void {
  ensureBridge()
  let set = listeners.get(type)
  if (!set) {
    set = new Set()
    listeners.set(type, set)
  }
  const cb = callback as (event: OrionEvent) => void
  set.add(cb)
  return () => {
    set.delete(cb)
  }
}
