import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { scopedLogger } from '../logger'
import migration0001 from './migrations/0001_init.sql?raw'
import migration0002 from './migrations/0002_conversation_tier_pin.sql?raw'
import migration0003 from './migrations/0003_news_upgrade.sql?raw'
import migration0004 from './migrations/0004_research_source_image.sql?raw'
import migration0005 from './migrations/0005_agent_session_tier.sql?raw'
import migration0006 from './migrations/0006_chat_search_pin_sampling.sql?raw'

const MIGRATIONS: string[] = [
  migration0001,
  migration0002,
  migration0003,
  migration0004,
  migration0005,
  migration0006
]

export type CrispinDatabase = DatabaseSync

export function openDatabase(dbPath: string): CrispinDatabase {
  const log = scopedLogger('db')
  mkdirSync(dirname(dbPath), { recursive: true })
  const db = new DatabaseSync(dbPath, { enableForeignKeyConstraints: true })
  db.exec('PRAGMA journal_mode = WAL')
  runMigrations(db, MIGRATIONS, log)
  ensureChatSchema(db, log)
  log.info(`open at ${dbPath} (schema v${MIGRATIONS.length})`)
  return db
}

/**
 * Apply pending migrations in order, keyed by PRAGMA user_version. Each migration
 * runs in its own transaction and bumps user_version atomically; a failing
 * migration rolls back and rethrows, leaving user_version at the last good
 * version. Idempotent: re-running on an up-to-date DB never enters the loop.
 */
export function runMigrations(
  db: DatabaseSync,
  migrations: string[],
  log?: { info(message: string): void }
): void {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number }
  for (let v = row.user_version; v < migrations.length; v++) {
    log?.info(`applying migration ${v + 1}/${migrations.length}`)
    db.exec('BEGIN')
    try {
      db.exec(migrations[v])
      db.exec(`PRAGMA user_version = ${v + 1}`)
      db.exec('COMMIT')
    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    }
  }
}

/**
 * Idempotently ensure the 0.21 chat columns + FTS table exist, regardless of
 * user_version. A DB advanced to v6 by the (now-removed) benchmarks 0006
 * migration on a divergent branch would otherwise SKIP the chat 0006 migration
 * — its index never runs once user_version is already 6 — and the chat code
 * would then crash on the missing columns/table. No-op on correctly-migrated
 * DBs; logs (never throws) so a broken FTS build can't brick startup.
 */
function ensureChatSchema(db: DatabaseSync, log: { warn(message: string): void }): void {
  try {
    const cols = (table: string): Set<string> =>
      new Set(
        (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
          (c) => c.name
        )
      )
    const conv = cols('conversations')
    if (!conv.has('pinned'))
      db.exec('ALTER TABLE conversations ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0')
    if (!conv.has('sampling')) db.exec('ALTER TABLE conversations ADD COLUMN sampling TEXT')
    const msg = cols('messages')
    if (!msg.has('ttft_ms')) db.exec('ALTER TABLE messages ADD COLUMN ttft_ms INTEGER')
    if (!msg.has('gen_ms')) db.exec('ALTER TABLE messages ADD COLUMN gen_ms INTEGER')
    db.exec(
      "CREATE VIRTUAL TABLE IF NOT EXISTS chat_fts USING fts5(conversation_id UNINDEXED, message_id UNINDEXED, title, body, tokenize = 'unicode61 remove_diacritics 2')"
    )
  } catch (err) {
    log.warn(`ensureChatSchema: ${err instanceof Error ? err.message : err}`)
  }
}
