import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { scopedLogger } from '../logger'
import migration0001 from './migrations/0001_init.sql?raw'

const MIGRATIONS: string[] = [migration0001]

export type OrionDatabase = DatabaseSync

export function openDatabase(dbPath: string): OrionDatabase {
  const log = scopedLogger('db')
  mkdirSync(dirname(dbPath), { recursive: true })
  const db = new DatabaseSync(dbPath, { enableForeignKeyConstraints: true })
  db.exec('PRAGMA journal_mode = WAL')

  const row = db.prepare('PRAGMA user_version').get() as { user_version: number }
  for (let v = row.user_version; v < MIGRATIONS.length; v++) {
    log.info(`applying migration ${v + 1}/${MIGRATIONS.length}`)
    db.exec('BEGIN')
    try {
      db.exec(MIGRATIONS[v])
      db.exec(`PRAGMA user_version = ${v + 1}`)
      db.exec('COMMIT')
    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    }
  }
  log.info(`open at ${dbPath} (schema v${MIGRATIONS.length})`)
  return db
}
