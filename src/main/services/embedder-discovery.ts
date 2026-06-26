export type EmbedderDiscoverAction = 'done' | 'restart' | 'wait' | 'giveUp'

/**
 * One decision in the embedder-rediscovery loop (F2). oMLX discovers cache
 * models at spawn only, so a running engine must restart to serve a freshly
 * downloaded embedder — but that restart must NEVER fire mid-generation, which
 * would kill another surface's in-flight stream (the same hazard load()'s
 * restart is idle-gated against). So this returns 'wait' (poll again) until the
 * engine is idle, 'restart' once it is, 'done' when there is nothing to do, and
 * 'giveUp' on shutdown or after the busy-wait deadline.
 */
export function embedderDiscoverAction(s: {
  disposed: boolean
  running: boolean
  alreadyDiscovered: boolean
  idle: boolean
  timedOut: boolean
}): EmbedderDiscoverAction {
  if (s.disposed) return 'giveUp'
  if (!s.running || s.alreadyDiscovered) return 'done'
  if (s.idle) return 'restart'
  if (s.timedOut) return 'giveUp'
  return 'wait'
}
