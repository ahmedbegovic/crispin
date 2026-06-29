import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// ../logger (pulled in via ../hydrate and ../db) imports electron.
vi.mock('../logger', () => ({
  scopedLogger: () => ({ info: () => {}, warn: () => {}, error: () => {} }),
  initLogging: () => {},
  log: { info: () => {}, warn: () => {}, error: () => {} }
}))

import { openDatabase } from '../db'
import { ChatRepo } from './repo'
import type { MessagePart, MessageRole } from '@shared/types'

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

const newConv = (): string => repo.createConversation({ tier: 'low', tierPinned: false }).id
const text = (t: string): MessagePart[] => [{ type: 'text', text: t }]
const add = (conv: string, parent: string | null, role: MessageRole, t: string): string =>
  repo.insertMessage({ conversationId: conv, parentId: parent, role, parts: text(t) })
const pathIds = (conv: string): string[] => repo.activePath(conv).map((m) => m.id)
const firstText = (m: { parts: MessagePart[] }): string => {
  const p = m.parts[0]
  return p && p.type === 'text' ? p.text : ''
}
const pathTexts = (conv: string): string[] => repo.activePath(conv).map(firstText)

describe('deleteMessageSubtree', () => {
  it('deletes a message and its descendants, re-threading the head onto the parent', () => {
    const conv = newConv()
    const m1 = add(conv, null, 'user', 'one')
    const m2 = add(conv, m1, 'assistant', 'two')
    const m3 = add(conv, m2, 'user', 'three')
    const m4 = add(conv, m3, 'assistant', 'four')
    repo.setHead(conv, m4)

    repo.deleteMessageSubtree(conv, m3)

    expect(pathIds(conv)).toEqual([m1, m2])
    expect(() => repo.getMessage(m3)).toThrow()
    expect(() => repo.getMessage(m4)).toThrow()
  })

  it('leaves the active head alone when an inactive sibling branch is deleted', () => {
    const conv = newConv()
    const m1 = add(conv, null, 'user', 'q')
    const a = add(conv, m1, 'assistant', 'answer A')
    const b = add(conv, m1, 'assistant', 'answer B') // sibling branch
    repo.setHead(conv, b)

    repo.deleteMessageSubtree(conv, a)

    expect(pathIds(conv)).toEqual([m1, b])
    expect(() => repo.getMessage(a)).toThrow()
  })

  it('keeps a surviving root branch reachable when the active root is deleted', () => {
    // Two root branches (e.g. an edit-resend of the first message forks a root).
    const conv = newConv()
    const rootA = add(conv, null, 'user', 'first version')
    const a2 = add(conv, rootA, 'assistant', 'reply A')
    const rootB = add(conv, null, 'user', 'edited version')
    const b2 = add(conv, rootB, 'assistant', 'reply B')
    repo.setHead(conv, b2) // active branch = root B

    repo.deleteMessageSubtree(conv, rootB)

    // root A must NOT be stranded behind a null head
    expect(pathIds(conv)).toEqual([rootA, a2])
    expect(repo.getConversation(conv).headMessageId).toBe(a2)
  })

  it('empties the conversation when the only root message is deleted', () => {
    const conv = newConv()
    const m1 = add(conv, null, 'user', 'q')
    add(conv, m1, 'assistant', 'a')
    repo.setHead(conv, m1) // head at root; the assistant is in its subtree

    repo.deleteMessageSubtree(conv, m1)

    expect(repo.activePath(conv)).toEqual([])
    expect(repo.getConversation(conv).headMessageId).toBeNull()
  })

  it('removes the deleted bodies from full-text search', () => {
    const conv = newConv()
    repo.updateConversation(conv, { title: 'Tree test' })
    const m1 = add(conv, null, 'user', 'pineapple upside down')
    repo.setHead(conv, m1)
    expect(repo.searchConversations('pineapple')).toHaveLength(1)

    repo.deleteMessageSubtree(conv, m1)

    expect(repo.searchConversations('pineapple')).toHaveLength(0)
  })

  it('rejects a message that belongs to another conversation', () => {
    const a = newConv()
    const b = newConv()
    const m = add(a, null, 'user', 'x')
    expect(() => repo.deleteMessageSubtree(b, m)).toThrow(/does not belong/)
  })

  it('returns the deleted subtree’s copied image paths (attachments + image parts)', () => {
    const conv = newConv()
    const m1 = repo.insertMessage({
      conversationId: conv,
      parentId: null,
      role: 'user',
      parts: [{ type: 'image', path: '/tmp/in-part.png', mime: 'image/png' }]
    })
    repo.insertAttachment({ messageId: m1, kind: 'image', path: '/tmp/in-attach.png', mime: 'image/png' })
    repo.setHead(conv, m1)

    const paths = repo.deleteMessageSubtree(conv, m1)

    expect([...paths].sort()).toEqual(['/tmp/in-attach.png', '/tmp/in-part.png'])
  })
})

describe('duplicateConversation', () => {
  it('forks the active path + settings into an independent new conversation', () => {
    const conv = newConv()
    repo.updateConversation(conv, { title: 'Original', systemPrompt: 'be brief' })
    const m1 = add(conv, null, 'user', 'hello')
    const m2 = add(conv, m1, 'assistant', 'hi there')
    repo.setHead(conv, m2)

    const dupId = repo.duplicateConversation(conv, { title: 'Copy of Original' })
    const dup = repo.getConversation(dupId)

    expect(dupId).not.toBe(conv)
    expect(dup.title).toBe('Copy of Original')
    expect(dup.systemPrompt).toBe('be brief')
    expect(pathTexts(dupId)).toEqual(['hello', 'hi there'])
    // independent ids — editing one chat must not touch the other
    expect(pathIds(dupId).some((id) => id === m1 || id === m2)).toBe(false)
  })

  it('truncates the fork at uptoMessageId (inclusive)', () => {
    const conv = newConv()
    const m1 = add(conv, null, 'user', 'q1')
    const m2 = add(conv, m1, 'assistant', 'a1')
    const m3 = add(conv, m2, 'user', 'q2')
    repo.setHead(conv, m3)

    const dupId = repo.duplicateConversation(conv, { uptoMessageId: m2, title: 'Copy' })

    expect(pathTexts(dupId)).toEqual(['q1', 'a1'])
  })

  it('indexes the duplicated bodies so both conversations are searchable', () => {
    const conv = newConv()
    const m1 = add(conv, null, 'user', 'watermelon')
    repo.setHead(conv, m1)

    const dupId = repo.duplicateConversation(conv, { title: 'Copy' })

    expect(
      repo
        .searchConversations('watermelon')
        .map((h) => h.conversationId)
        .sort()
    ).toEqual([conv, dupId].sort())
  })
})

describe('compactConversation', () => {
  it('replaces older turns with a summary, re-threads the kept tail, preserves the old branch', () => {
    const conv = newConv()
    const m1 = add(conv, null, 'user', 'q1')
    const m2 = add(conv, m1, 'assistant', 'a1')
    const m3 = add(conv, m2, 'user', 'q2')
    const m4 = add(conv, m3, 'assistant', 'a2')
    repo.setHead(conv, m4)

    // Keep the last two (m3, m4); summarize m1+m2.
    const summaryId = repo.compactConversation(conv, {
      summary: 'they discussed q1',
      keepFromMessageId: m3
    })

    expect(pathIds(conv)).toEqual([summaryId, m3, m4])
    const first = repo.activePath(conv)[0].parts[0]
    expect(first.type).toBe('compaction')
    // the head is unchanged; the older turns survive off the active path
    expect(repo.getConversation(conv).headMessageId).toBe(m4)
    expect(repo.getMessage(m1).id).toBe(m1)
    expect(repo.getMessage(m2).id).toBe(m2)
  })

  it('makes the summary the head when nothing is kept', () => {
    const conv = newConv()
    const m1 = add(conv, null, 'user', 'q')
    const m2 = add(conv, m1, 'assistant', 'a')
    repo.setHead(conv, m2)

    const summaryId = repo.compactConversation(conv, { summary: 's', keepFromMessageId: null })

    expect(pathIds(conv)).toEqual([summaryId])
    expect(repo.getConversation(conv).headMessageId).toBe(summaryId)
  })
})

describe('imagePathInUse (shared-image refcount)', () => {
  it('stays true while any conversation references the image, false once none do', () => {
    const conv = newConv()
    const m1 = repo.insertMessage({
      conversationId: conv,
      parentId: null,
      role: 'user',
      parts: [{ type: 'image', path: '/tmp/shared.png', mime: 'image/png' }]
    })
    repo.setHead(conv, m1)
    const dupId = repo.duplicateConversation(conv, { title: 'Copy' })

    expect(repo.imagePathInUse('/tmp/shared.png')).toBe(true)
    // delete the original — the duplicate still references the shared file
    repo.deleteMessageSubtree(conv, m1)
    expect(repo.imagePathInUse('/tmp/shared.png')).toBe(true)
    // delete the duplicate too — now nothing references it
    repo.deleteMessageSubtree(dupId, repo.activePath(dupId)[0].id)
    expect(repo.imagePathInUse('/tmp/shared.png')).toBe(false)
  })
})
