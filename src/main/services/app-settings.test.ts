import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appSettingsSchema } from '@shared/ipc'

vi.mock('./logger', () => ({
  scopedLogger: () => ({ info: () => {}, warn: () => {}, error: () => {} }),
  initLogging: () => {},
  log: { info: () => {}, warn: () => {}, error: () => {} }
}))

import { openDatabase } from './db'
import * as settings from './settings'
import { AppSettingsService } from './app-settings'

let dir: string
let db: ReturnType<typeof openDatabase>

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'crispin-settings-'))
  db = openDatabase(join(dir, 'test.db'))
})

afterEach(() => {
  try {
    db.close()
  } catch {
    // already closed
  }
  rmSync(dir, { recursive: true, force: true })
})

describe('AppSettingsService.get — corrupt sub-objects degrade independently', () => {
  it('falls back per-field on stale/invalid stored values and stays contract-valid', () => {
    settings.set(db, 'profile', { userName: 5 }) // wrong type + missing assistantName
    settings.set(db, 'models.idleUnloadSeconds', -3) // below min(0)
    settings.set(db, 'news.topics', ['ai']) // valid — must be preserved

    const svc = new AppSettingsService({ db, broadcast: vi.fn() })
    const result = svc.get()

    expect(appSettingsSchema.safeParse(result).success).toBe(true)
    expect(result.profile).toEqual({ userName: '', assistantName: 'Crispin' })
    expect(result.idleUnloadSeconds).toBe(300)
    expect(result.newsTopics).toEqual(['ai'])
  })
})

describe('AppSettingsService.get — record settings drop only the bad entry', () => {
  it('keeps the valid global instruction when a stale perModule key is present', () => {
    // 'oldmod' is not a Feature; the old whole-object parseOr would discard
    // `global` and every valid perModule entry with it.
    settings.set(db, 'instructions', {
      global: 'Always cite sources.',
      perModule: { news: 'be brief', oldmod: 'gone' }
    })

    const result = new AppSettingsService({ db, broadcast: vi.fn() }).get()

    expect(appSettingsSchema.safeParse(result).success).toBe(true)
    expect(result.instructions.global).toBe('Always cite sources.')
    expect(result.instructions.perModule).toEqual({ news: 'be brief' }) // oldmod dropped
  })

  it('preserves a disabled optional module when a sibling module value is corrupt', () => {
    settings.set(db, 'modules.enabled', { news: false, badmod: 'not-a-bool' })

    const result = new AppSettingsService({ db, broadcast: vi.fn() }).get()

    expect(appSettingsSchema.safeParse(result).success).toBe(true)
    expect(result.modulesEnabled.news).toBe(false) // user's disable survives the bad sibling
  })

  it('keeps valid tier picks when a stale tier key is present', () => {
    settings.set(db, 'models.tierSelections', { low: 'mlx-community/foo-4bit', bogus: 'x' })

    const result = new AppSettingsService({ db, broadcast: vi.fn() }).get()

    expect(appSettingsSchema.safeParse(result).success).toBe(true)
    expect(result.tierSelections.low).toBeDefined() // valid pick preserved
    expect(result.tierSelections).not.toHaveProperty('bogus') // stale key dropped
  })

  it('drops only invalid newsTopics elements, keeping the valid strings', () => {
    settings.set(db, 'news.topics', ['ai', 5, 'ml']) // 5 is not a string

    const result = new AppSettingsService({ db, broadcast: vi.fn() }).get()

    expect(appSettingsSchema.safeParse(result).success).toBe(true)
    expect(result.newsTopics).toEqual(['ai', 'ml'])
  })
})

describe('AppSettingsService — defaultFamily', () => {
  it('defaults to gemma when unset and degrades to gemma on a corrupt value', () => {
    const fresh = new AppSettingsService({ db, broadcast: vi.fn() })
    expect(fresh.defaultFamily()).toBe('gemma')

    settings.set(db, 'models.defaultFamily', 'llama') // not a valid family
    const result = new AppSettingsService({ db, broadcast: vi.fn() }).get()
    expect(appSettingsSchema.safeParse(result).success).toBe(true)
    expect(result.defaultFamily).toBe('gemma')
  })

  it('round-trips a chosen family through update → get', () => {
    const svc = new AppSettingsService({ db, broadcast: vi.fn() })
    svc.update({ ...svc.get(), defaultFamily: 'qwen' })
    expect(new AppSettingsService({ db, broadcast: vi.fn() }).defaultFamily()).toBe('qwen')
  })
})
