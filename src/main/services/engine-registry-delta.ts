/** The fingerprinted slice of a registry entry — name + per-model output budget,
 *  exactly what registryKey() hashes to decide whether a respawn is required. */
export interface RegistryFingerprint {
  name: string
  maxTokens: number
}

export type RegistryDelta =
  /** Registries are identical — nothing to do. */
  | { kind: 'none'; added: [] }
  /** Only additions: every prior model is unchanged and present. A live
   *  rediscovery surfaces the new models without disturbing the loaded ones. */
  | { kind: 'additive'; added: string[] }
  /** A model was removed or an existing one's settings changed — only a respawn
   *  (which reloads the pool from the rewritten config) applies that cleanly. */
  | { kind: 'restart'; added: [] }

/**
 * Order-insensitive fingerprint of a registry — name + per-model output budget.
 * ttl/KV are deliberately excluded (they ride the next natural spawn, never force
 * a restart). This is the string ModelService stores as appliedRegistryKey, and
 * parseRegistryKey is its exact inverse.
 */
export function registryKey(entries: RegistryFingerprint[]): string {
  return JSON.stringify(
    entries.map((e): [string, number] => [e.name, e.maxTokens]).sort((a, b) => a[0].localeCompare(b[0]))
  )
}

/** Inverse of registryKey — parse a stored key back to its fingerprints. Throws on
 *  malformed input (caller treats that as "unknown previous state"). */
export function parseRegistryKey(key: string): RegistryFingerprint[] {
  return (JSON.parse(key) as [string, number][]).map(([name, maxTokens]) => ({ name, maxTokens }))
}

/**
 * Classify the change from `prev` to `next`. Additive-only (new downloads, the
 * common case) can ride a rediscovery; anything that drops or mutates an
 * existing entry falls back to a restart. Order-insensitive, matching registryKey.
 */
export function registryDelta(
  prev: RegistryFingerprint[],
  next: RegistryFingerprint[]
): RegistryDelta {
  const prevByName = new Map(prev.map((e) => [e.name, e.maxTokens]))
  const nextByName = new Map(next.map((e) => [e.name, e.maxTokens]))

  // Every prior model must still be present AND unchanged, or a respawn is due.
  for (const [name, maxTokens] of prevByName) {
    if (nextByName.get(name) !== maxTokens) return { kind: 'restart', added: [] }
  }

  const added = [...nextByName.keys()].filter((name) => !prevByName.has(name))
  if (added.length === 0) return { kind: 'none', added: [] }
  return { kind: 'additive', added }
}

/**
 * Diff the current registry against a stored appliedRegistryKey. A null or
 * unparseable key means the previous state is unknown — the safe answer is a
 * restart. Otherwise classifies via registryDelta.
 */
export function registryDeltaFromKey(
  appliedKey: string | null,
  entries: RegistryFingerprint[]
): RegistryDelta {
  if (appliedKey === null) return { kind: 'restart', added: [] }
  if (registryKey(entries) === appliedKey) return { kind: 'none', added: [] }
  let prev: RegistryFingerprint[]
  try {
    prev = parseRegistryKey(appliedKey)
  } catch {
    return { kind: 'restart', added: [] }
  }
  return registryDelta(prev, entries)
}
