export type EmbedderDiscoverAction = 'done' | 'rediscover' | 'giveUp'

/**
 * One decision in the embedder-rediscovery loop (F2). oMLX discovers cache
 * models at spawn, so a running engine must be told to re-scan to serve a
 * freshly downloaded embedder. That re-scan is a non-destructive, in-place merge
 * (it preserves loaded models — see EngineClient.rediscover), so unlike the old
 * engine restart it need NOT be idle-gated: it can run with a generation in
 * flight without disturbing it. Returns 'rediscover' when there is an
 * undiscovered embedder on a running engine, 'done' when there is nothing to do,
 * and 'giveUp' on shutdown.
 */
export function embedderDiscoverAction(s: {
  disposed: boolean
  running: boolean
  alreadyDiscovered: boolean
}): EmbedderDiscoverAction {
  if (s.disposed) return 'giveUp'
  if (!s.running || s.alreadyDiscovered) return 'done'
  return 'rediscover'
}
