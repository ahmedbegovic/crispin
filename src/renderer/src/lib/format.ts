const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const

/** Human-readable byte count: 1234567 -> "1.2 MB". */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—'
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024
    unit += 1
  }
  const digits = unit === 0 || value >= 100 ? 0 : 1
  return `${value.toFixed(digits).replace(/\.0$/, '')} ${BYTE_UNITS[unit]}`
}

/** Compact duration: "120ms", "0.8s", "12s". */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—'
  if (ms < 1000) return `${Math.round(ms)}ms`
  return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`
}

/** Decode throughput, e.g. "38.0 tok/s"; null when not computable. */
export function formatTokensPerSec(tokens: number, ms: number): string | null {
  if (!Number.isFinite(tokens) || !Number.isFinite(ms) || ms <= 0) return null
  return `${(tokens / (ms / 1000)).toFixed(1)} tok/s`
}

/** Compact relative time: "just now", "5m ago", "3h ago", "2d ago". */
export function relativeTime(unixMs: number, now: number = Date.now()): string {
  const delta = now - unixMs
  if (delta < 60_000) return 'just now'
  const minutes = Math.floor(delta / 60_000)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d ago`
  if (days < 365) return `${Math.floor(days / 30)}mo ago`
  return `${Math.floor(days / 365)}y ago`
}

export type DateBucket = 'Today' | 'Yesterday' | 'Previous 7 Days' | 'Previous 30 Days' | 'Older'

/**
 * Which calendar-relative bucket a timestamp falls into, for grouping lists.
 * Bucketed by LOCAL midnight (not raw 24h windows), so "Yesterday" means the
 * previous calendar day regardless of the current time of day.
 */
export function dateBucket(unixMs: number, now: number = Date.now()): DateBucket {
  // Each bound is a real local midnight N calendar days back (not a fixed-ms
  // multiple), so DST-transition days don't shift the boundary by an hour.
  const startOfDayBack = (n: number): number => {
    const d = new Date(now)
    d.setHours(0, 0, 0, 0)
    d.setDate(d.getDate() - n)
    return d.getTime()
  }
  if (unixMs >= startOfDayBack(0)) return 'Today'
  if (unixMs >= startOfDayBack(1)) return 'Yesterday'
  if (unixMs >= startOfDayBack(7)) return 'Previous 7 Days'
  if (unixMs >= startOfDayBack(30)) return 'Previous 30 Days'
  return 'Older'
}
