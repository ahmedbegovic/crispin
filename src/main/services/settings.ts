import type { CrispinDatabase } from './db'

/**
 * Tiny typed access to the `settings` table (key → JSON value).
 * Use as `import * as settings from './settings'`.
 */

export function get<T>(db: CrispinDatabase, key: string, fallback: T): T {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
    | { value: string }
    | undefined
  if (!row) return fallback
  try {
    return JSON.parse(row.value) as T
  } catch {
    return fallback
  }
}

export function set(db: CrispinDatabase, key: string, value: unknown): void {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, JSON.stringify(value))
}
