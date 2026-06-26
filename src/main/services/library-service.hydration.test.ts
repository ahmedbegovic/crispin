import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { collectionSchema, libraryDocSchema } from '@shared/ipc'

vi.mock('./logger', () => ({
  scopedLogger: () => ({ info: () => {}, warn: () => {}, error: () => {} }),
  initLogging: () => {},
  log: { info: () => {}, warn: () => {}, error: () => {} }
}))
vi.mock('./paths', () => ({ dataDir: () => '/tmp' }))

import { openDatabase } from './db'
import { LibraryService, type LibraryServiceDeps } from './library-service'

let dir: string
let db: ReturnType<typeof openDatabase>
let svc: LibraryService

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'crispin-lib-'))
  db = openDatabase(join(dir, 'test.db'))
  svc = new LibraryService({ db } as unknown as LibraryServiceDeps)
})

afterEach(() => {
  try {
    db.close()
  } catch {
    // already closed
  }
  rmSync(dir, { recursive: true, force: true })
})

describe('LibraryService list producers — hydration', () => {
  it('docs() drops a row whose status enum drifted, and stays contract-valid', () => {
    db.prepare("INSERT INTO collections (id, name, kind, created_at) VALUES ('c1', 'C', 'library', 1)").run()
    db.prepare(
      `INSERT INTO library_docs (id, collection_id, title, source, kind, status, error, chunk_count, created_at)
       VALUES ('d1', 'c1', 't', 's', 'txt', 'ready', NULL, 3, 2)`
    ).run()
    db.prepare(
      `INSERT INTO library_docs (id, collection_id, title, source, kind, status, error, chunk_count, created_at)
       VALUES ('d2', 'c1', 't', 's', 'txt', 'bogus', NULL, 0, 1)`
    ).run()

    const docs = svc.docs('c1')
    expect(docs.map((d) => d.id)).toEqual(['d1'])
    expect(z.array(libraryDocSchema).safeParse(docs).success).toBe(true)
  })

  it('collections() drops a row whose kind enum drifted, and stays contract-valid', () => {
    db.prepare("INSERT INTO collections (id, name, kind, created_at) VALUES ('c1', 'Good', 'library', 2)").run()
    db.prepare("INSERT INTO collections (id, name, kind, created_at) VALUES ('c2', 'Bad', 'bogus', 1)").run()

    const cols = svc.collections()
    expect(cols.map((c) => c.id)).toEqual(['c1'])
    expect(z.array(collectionSchema).safeParse(cols).success).toBe(true)
  })
})
