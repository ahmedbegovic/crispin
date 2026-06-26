import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// ../logger imports `electron`, which can't load outside an Electron process —
// replace it so the db module graph loads under a plain Node test runner.
vi.mock('../logger', () => ({
  scopedLogger: () => ({ info: () => {}, warn: () => {}, error: () => {} }),
  initLogging: () => {},
  log: { info: () => {}, warn: () => {}, error: () => {} }
}))

import { openDatabase, runMigrations } from './index'
import m1 from './migrations/0001_init.sql?raw'
import m2 from './migrations/0002_conversation_tier_pin.sql?raw'
import m3 from './migrations/0003_news_upgrade.sql?raw'
import m4 from './migrations/0004_research_source_image.sql?raw'
import m5 from './migrations/0005_agent_session_tier.sql?raw'

// The current schema version (= MIGRATIONS.length). Bump when adding a migration.
const SCHEMA_VERSION = 8

let dir: string
let dbPath: string
const opened: DatabaseSync[] = []

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'crispin-db-'))
  dbPath = join(dir, 'test.db')
})

afterEach(() => {
  for (const db of opened.splice(0)) {
    try {
      db.close()
    } catch {
      // already closed
    }
  }
  rmSync(dir, { recursive: true, force: true })
})

const track = (db: DatabaseSync): DatabaseSync => {
  opened.push(db)
  return db
}

const userVersion = (db: DatabaseSync): number =>
  (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version

const columns = (db: DatabaseSync, table: string): Set<string> =>
  new Set(
    (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name)
  )

const objectExists = (db: DatabaseSync, name: string): boolean =>
  db.prepare('SELECT 1 FROM sqlite_master WHERE name = ?').get(name) !== undefined

describe('openDatabase — migration runner', () => {
  it('migrates a fresh database to the current schema version', () => {
    const db = track(openDatabase(dbPath))
    expect(userVersion(db)).toBe(SCHEMA_VERSION)

    for (const table of [
      'settings',
      'conversations',
      'messages',
      'attachments',
      'collections',
      'library_docs',
      'research_runs',
      'research_steps',
      'research_sources',
      'news_sources',
      'news_items',
      'model_downloads',
      'agent_sessions',
      'mcp_servers',
      'chat_fts'
    ]) {
      expect(objectExists(db, table)).toBe(true)
    }

    const conv = columns(db, 'conversations')
    expect(conv.has('tier_pinned')).toBe(true) // 0002
    expect(conv.has('pinned')).toBe(true) // 0006
    expect(conv.has('sampling')).toBe(true) // 0006
    expect(conv.has('family')).toBe(true) // 0007
    expect(columns(db, 'agent_sessions').has('family')).toBe(true) // 0008
    const msg = columns(db, 'messages')
    expect(msg.has('ttft_ms')).toBe(true) // 0006
    expect(msg.has('gen_ms')).toBe(true) // 0006
  })

  it('is idempotent on reopen and preserves data (never re-initializes)', () => {
    const db1 = openDatabase(dbPath)
    db1.exec("INSERT INTO conversations (id, created_at, updated_at) VALUES ('c1', 1, 1)")
    db1.close()

    const db2 = track(openDatabase(dbPath))
    expect(userVersion(db2)).toBe(SCHEMA_VERSION) // unchanged
    expect(db2.prepare("SELECT id FROM conversations WHERE id = 'c1'").get()).toEqual({ id: 'c1' })
  })

  it('resumes from a partially-migrated database, preserving existing rows', () => {
    // Old DB at user_version 1 (only 0001 applied) with a row.
    const seed = new DatabaseSync(dbPath)
    seed.exec(m1)
    seed.exec("INSERT INTO conversations (id, created_at, updated_at) VALUES ('old', 1, 1)")
    seed.exec('PRAGMA user_version = 1')
    seed.close()

    const db = track(openDatabase(dbPath))
    expect(userVersion(db)).toBe(SCHEMA_VERSION)
    expect(db.prepare("SELECT id FROM conversations WHERE id = 'old'").get()).toEqual({ id: 'old' })
    expect(columns(db, 'conversations').has('pinned')).toBe(true) // 0006 ran during resume
    expect(columns(db, 'conversations').has('family')).toBe(true) // 0007 ran during resume
  })

  it('ensureChatSchema backfills chat columns/FTS when a divergent DB reached v6 without them', () => {
    // Simulate the removed-benchmarks-0006 scenario: 0001–0005 applied, NOT the
    // chat 0006, but user_version force-bumped to 6 so the loop skips 0006.
    const seed = new DatabaseSync(dbPath)
    for (const m of [m1, m2, m3, m4, m5]) seed.exec(m)
    expect(columns(seed, 'conversations').has('pinned')).toBe(false) // 0006 not applied yet
    expect(objectExists(seed, 'chat_fts')).toBe(false)
    seed.exec('PRAGMA user_version = 6')
    seed.close()

    const db = track(openDatabase(dbPath))
    // The loop runs 0007/0008 (6 → 8) but the chat 0006 it jumped over stays
    // unapplied — pinned/sampling/FTS come from the ensureChatSchema backstop.
    expect(userVersion(db)).toBe(SCHEMA_VERSION)
    const conv = columns(db, 'conversations')
    expect(conv.has('pinned')).toBe(true) // backfilled by ensureChatSchema
    expect(conv.has('sampling')).toBe(true)
    expect(conv.has('family')).toBe(true) // 0007 ran in the loop
    expect(columns(db, 'agent_sessions').has('family')).toBe(true) // 0008 ran in the loop
    const msg = columns(db, 'messages')
    expect(msg.has('ttft_ms')).toBe(true)
    expect(msg.has('gen_ms')).toBe(true)
    expect(objectExists(db, 'chat_fts')).toBe(true)
  })

  it('enforces ON DELETE CASCADE (FK option + schema declarations)', () => {
    const db = track(openDatabase(dbPath))
    expect(db.prepare('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 }) // index.ts:26 option
    db.exec("INSERT INTO conversations (id, created_at, updated_at) VALUES ('c1', 1, 1)")
    db.exec("INSERT INTO messages (id, conversation_id, role, created_at) VALUES ('m1', 'c1', 'user', 1)")
    db.exec("INSERT INTO attachments (id, message_id, kind, path) VALUES ('a1', 'm1', 'image', '/x')")
    db.exec("DELETE FROM conversations WHERE id = 'c1'")
    expect(db.prepare('SELECT COUNT(*) AS n FROM messages').get()).toEqual({ n: 0 })
    expect(db.prepare('SELECT COUNT(*) AS n FROM attachments').get()).toEqual({ n: 0 }) // transitive cascade
  })
})

describe('runMigrations — transaction atomicity', () => {
  it('rolls a failing migration back in full and leaves user_version at the last good version', () => {
    const db = track(new DatabaseSync(':memory:'))
    expect(() =>
      runMigrations(db, ['CREATE TABLE ok (x);', 'CREATE TABLE rolledback (x); THIS IS NOT VALID SQL;'])
    ).toThrow()
    expect(userVersion(db)).toBe(1) // first migration committed; second rolled back, version not bumped
    expect(objectExists(db, 'ok')).toBe(true) // committed migration survives
    // The failing migration's earlier statement must be UNDONE. This is the
    // assertion that actually proves each migration runs in its OWN transaction
    // — it passes only when the runner wraps in BEGIN/COMMIT/ROLLBACK.
    expect(objectExists(db, 'rolledback')).toBe(false)
  })
})
