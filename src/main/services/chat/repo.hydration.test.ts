import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { conversationSchema, chatMessageSchema } from '@shared/ipc'

// ../logger (pulled in via ../hydrate and ../db) imports electron.
vi.mock('../logger', () => ({
  scopedLogger: () => ({ info: () => {}, warn: () => {}, error: () => {} }),
  initLogging: () => {},
  log: { info: () => {}, warn: () => {}, error: () => {} }
}))

import { openDatabase } from '../db'
import { ChatRepo } from './repo'

let dir: string
let db: ReturnType<typeof openDatabase>
let repo: ChatRepo

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'crispin-repo-'))
  db = openDatabase(join(dir, 'test.db'))
  repo = new ChatRepo(db)
})

afterEach(() => {
  try {
    db.close()
  } catch {
    // already closed
  }
  rmSync(dir, { recursive: true, force: true })
})

describe('ChatRepo hydration — message parts', () => {
  it('drops a shape-invalid part, keeps the valid ones, and stays contract-valid', () => {
    const conv = repo.createConversation({ tier: 'low', tierPinned: false })
    const msgId = repo.insertMessage({
      conversationId: conv.id,
      parentId: null,
      role: 'assistant',
      parts: [{ type: 'text', text: 'ok' }]
    })
    // Corrupt the stored JSON: one valid text part + one with an unknown discriminator.
    db.prepare('UPDATE messages SET parts = ? WHERE id = ?').run(
      JSON.stringify([{ type: 'text', text: 'ok' }, { type: 'bogus' }]),
      msgId
    )
    const msg = repo.getMessage(msgId)
    expect(msg.parts).toEqual([{ type: 'text', text: 'ok' }])
    expect(chatMessageSchema.safeParse(msg).success).toBe(true)
  })
})

describe('ChatRepo hydration — conversation sampling', () => {
  it('nulls out-of-range stored sampling so the conversation stays contract-valid', () => {
    const conv = repo.createConversation({ tier: 'low', tierPinned: false })
    db.prepare('UPDATE conversations SET sampling = ? WHERE id = ?').run(
      JSON.stringify({ temperature: 99, topP: 7, topK: -1 }),
      conv.id
    )
    const reloaded = repo.getConversation(conv.id)
    expect(reloaded.sampling).toBeNull()
    expect(conversationSchema.safeParse(reloaded).success).toBe(true)
  })
})
