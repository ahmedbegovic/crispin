import type {
  ChatMessage,
  ChatSearchHit,
  Conversation,
  ConversationMeta,
  Family,
  MessagePart,
  MessageRole,
  ModelSampling,
  Tier
} from '@shared/types'
import { messagePartSchema, samplingSchema } from '@shared/ipc'
import type { CrispinDatabase } from '../db'
import { parseArrayDropInvalid, parseOr } from '../hydrate'

interface ConversationRow {
  id: string
  title: string
  system_prompt: string | null
  head_message_id: string | null
  default_tier: Tier
  tier_pinned: number
  family: Family | null
  collection_id: string | null
  web_enabled: number
  archived: number
  pinned: number
  sampling: string | null
  created_at: number
  updated_at: number
}

interface MessageRow {
  id: string
  conversation_id: string
  parent_id: string | null
  role: MessageRole
  parts: string
  model_id: string | null
  tokens_in: number | null
  tokens_out: number | null
  ttft_ms: number | null
  gen_ms: number | null
  created_at: number
}

const parseSampling = (json: string | null): ModelSampling | null => {
  if (!json) return null
  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch {
    return null
  }
  // Out-of-bounds/garbage stored sampling → null (= follow the model's
  // recommended sampling), so it can't fail conversationSchema downstream.
  return parseOr(samplingSchema.nullable(), raw, null, 'chat.sampling')
}

const rowToConversation = (row: ConversationRow): Conversation => ({
  id: row.id,
  title: row.title,
  systemPrompt: row.system_prompt,
  headMessageId: row.head_message_id,
  defaultTier: row.default_tier,
  tierPinned: row.tier_pinned === 1,
  family: row.family,
  collectionId: row.collection_id,
  webEnabled: row.web_enabled === 1,
  archived: row.archived === 1,
  pinned: row.pinned === 1,
  sampling: parseSampling(row.sampling),
  createdAt: row.created_at,
  updatedAt: row.updated_at
})

const parseParts = (json: string): MessagePart[] => {
  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch {
    return []
  }
  // Drop shape-invalid parts (keep the valid ones) so one corrupt part can't
  // make the whole conversation refuse to open (dev output.parse) or ship a
  // malformed part to the renderer's part.type switch (prod).
  return parseArrayDropInvalid(messagePartSchema, raw, 'chat.parts')
}

/** Searchable text of a message = its text parts (no thoughts/tools/images). */
const bodyOfParts = (parts: MessagePart[]): string =>
  parts
    .filter((p): p is Extract<MessagePart, { type: 'text' }> => p.type === 'text')
    .map((p) => p.text)
    .join('\n')
    .trim()

export interface InsertMessageInput {
  conversationId: string
  parentId: string | null
  role: MessageRole
  parts: MessagePart[]
  modelId?: string | null
}

/** All chat SQL lives here: conversations CRUD + the message tree + FTS search. */
export class ChatRepo {
  /** False when the chat_fts virtual table is missing (degrade, don't crash). */
  private ftsReady = false

  constructor(private readonly db: CrispinDatabase) {
    this.ftsReady =
      this.db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'chat_fts'").get() !== undefined
    if (this.ftsReady) {
      try {
        this.backfillChatFts()
      } catch {
        this.ftsReady = false
      }
    }
  }

  // --- conversations ----------------------------------------------------------

  listConversations(archived: boolean): ConversationMeta[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM conversations WHERE archived = ? ORDER BY pinned DESC, updated_at DESC'
      )
      .all(archived ? 1 : 0) as unknown as ConversationRow[]
    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      archived: r.archived === 1,
      pinned: r.pinned === 1,
      updatedAt: r.updated_at
    }))
  }

  createConversation(input: {
    tier: Tier
    /** False = follow featureDefaults.chat live; picking a tier later pins it. */
    tierPinned: boolean
    /** Pinned family; null/undefined = follow the global default family live. */
    family?: Family | null
    collectionId?: string | null
    webEnabled?: boolean
  }): Conversation {
    const now = Date.now()
    const id = crypto.randomUUID()
    this.db
      .prepare(
        `INSERT INTO conversations (id, default_tier, tier_pinned, family, collection_id, web_enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.tier,
        input.tierPinned ? 1 : 0,
        input.family ?? null,
        input.collectionId ?? null,
        input.webEnabled ? 1 : 0,
        now,
        now
      )
    // Don't index the default 'New chat' placeholder title — it would make a
    // search for "new"/"chat" match every still-untitled conversation. The real
    // title is indexed when instantTitle/refinement sets it (updateConversation).
    return this.getConversation(id)
  }

  getConversation(id: string): Conversation {
    const row = this.db.prepare('SELECT * FROM conversations WHERE id = ?').get(id) as
      | ConversationRow
      | undefined
    if (!row) throw new Error(`No such conversation: ${id}`)
    return rowToConversation(row)
  }

  updateConversation(
    id: string,
    fields: {
      title?: string
      systemPrompt?: string | null
      /** A tier pins the conversation; null un-pins (follow featureDefaults.chat). */
      defaultTier?: Tier | null
      /** A family pins the conversation; null un-pins (follow the global default). */
      family?: Family | null
      collectionId?: string | null
      webEnabled?: boolean
      archived?: boolean
      pinned?: boolean
      /** null reverts to the model's recommended sampling. */
      sampling?: ModelSampling | null
    }
  ): void {
    const sets: string[] = []
    const values: Array<string | number | null> = []
    const set = (column: string, value: string | number | null): void => {
      sets.push(`${column} = ?`)
      values.push(value)
    }
    if (fields.title !== undefined) set('title', fields.title)
    if (fields.systemPrompt !== undefined) set('system_prompt', fields.systemPrompt)
    if (fields.defaultTier !== undefined) {
      if (fields.defaultTier === null) {
        set('tier_pinned', 0)
      } else {
        set('default_tier', fields.defaultTier)
        set('tier_pinned', 1)
      }
    }
    if (fields.family !== undefined) set('family', fields.family)
    if (fields.collectionId !== undefined) set('collection_id', fields.collectionId)
    if (fields.webEnabled !== undefined) set('web_enabled', fields.webEnabled ? 1 : 0)
    if (fields.archived !== undefined) set('archived', fields.archived ? 1 : 0)
    if (fields.pinned !== undefined) set('pinned', fields.pinned ? 1 : 0)
    if (fields.sampling !== undefined) {
      set('sampling', fields.sampling === null ? null : JSON.stringify(fields.sampling))
    }
    set('updated_at', Date.now())
    values.push(id)
    this.db.prepare(`UPDATE conversations SET ${sets.join(', ')} WHERE id = ?`).run(...values)
    if (fields.title !== undefined) this.ftsSetTitle(id, fields.title)
  }

  deleteConversation(id: string): void {
    // Guard like every other FTS touch: when FTS5 is unavailable the table is
    // absent and prepare() would throw, aborting the delete and orphaning the
    // already-unlinked image files. The conversation/messages delete must run.
    if (this.ftsReady)
      this.db.prepare('DELETE FROM chat_fts WHERE conversation_id = ?').run(id) // not FK-cascaded
    this.db.prepare('DELETE FROM conversations WHERE id = ?').run(id) // messages cascade
  }

  setTitle(id: string, title: string): void {
    this.db.prepare('UPDATE conversations SET title = ? WHERE id = ?').run(title, id)
    this.ftsSetTitle(id, title)
  }

  // --- message tree -----------------------------------------------------------

  insertMessage(input: InsertMessageInput): string {
    const id = crypto.randomUUID()
    this.db
      .prepare(
        `INSERT INTO messages (id, conversation_id, parent_id, role, parts, model_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.conversationId,
        input.parentId,
        input.role,
        JSON.stringify(input.parts),
        input.modelId ?? null,
        Date.now()
      )
    this.ftsIndexBody(id, input.conversationId, bodyOfParts(input.parts))
    return id
  }

  getMessage(id: string): ChatMessage & { parts: MessagePart[] } {
    const row = this.db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as
      | MessageRow
      | undefined
    if (!row) throw new Error(`No such message: ${id}`)
    return this.toMessage(row)
  }

  /** Incremental part persistence during streaming + finalize. */
  updateParts(
    messageId: string,
    parts: MessagePart[],
    tokens?: { tokensIn: number | null; tokensOut: number | null },
    timing?: { ttftMs: number | null; genMs: number | null }
  ): void {
    if (tokens) {
      if (timing) {
        this.db
          .prepare(
            'UPDATE messages SET parts = ?, tokens_in = ?, tokens_out = ?, ttft_ms = ?, gen_ms = ? WHERE id = ?'
          )
          .run(
            JSON.stringify(parts),
            tokens.tokensIn,
            tokens.tokensOut,
            timing.ttftMs,
            timing.genMs,
            messageId
          )
      } else {
        this.db
          .prepare('UPDATE messages SET parts = ?, tokens_in = ?, tokens_out = ? WHERE id = ?')
          .run(JSON.stringify(parts), tokens.tokensIn, tokens.tokensOut, messageId)
      }
      // Re-index FTS only at finalize (tokens present) — not on every streaming flush.
      this.ftsReindexMessage(messageId, parts)
    } else {
      this.db
        .prepare('UPDATE messages SET parts = ? WHERE id = ?')
        .run(JSON.stringify(parts), messageId)
    }
  }

  setHead(conversationId: string, messageId: string | null): void {
    this.db
      .prepare('UPDATE conversations SET head_message_id = ?, updated_at = ? WHERE id = ?')
      .run(messageId, Date.now(), conversationId)
  }

  /**
   * Reset a dangling head (its message row is gone) to the newest message in the
   * conversation, or null when empty. No-op when the head is valid.
   */
  repairHead(conversationId: string): void {
    const row = this.db
      .prepare('SELECT head_message_id FROM conversations WHERE id = ?')
      .get(conversationId) as { head_message_id: string | null } | undefined
    if (!row || row.head_message_id === null) return
    const exists = this.db.prepare('SELECT 1 FROM messages WHERE id = ?').get(row.head_message_id)
    if (exists) return
    const newest = this.db
      .prepare(
        'SELECT id FROM messages WHERE conversation_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1'
      )
      .get(conversationId) as { id: string } | undefined
    this.setHead(conversationId, newest?.id ?? null)
  }

  /** Active path root→head. Walks parent links; head is the source of truth. */
  activePath(conversationId: string): Array<ChatMessage & { parts: MessagePart[] }> {
    const conversation = this.getConversation(conversationId)
    const byId = this.db.prepare('SELECT * FROM messages WHERE id = ?')
    const path: MessageRow[] = []
    let cursor = conversation.headMessageId
    while (cursor) {
      const row = byId.get(cursor) as MessageRow | undefined
      if (!row) break // dangling head — tolerate rather than crash the view
      path.push(row)
      cursor = row.parent_id
    }
    path.reverse()
    return path.map((r) => this.toMessage(r))
  }

  view(conversationId: string): { conversation: Conversation; messages: ChatMessage[] } {
    this.repairHead(conversationId)
    return {
      conversation: this.getConversation(conversationId),
      messages: this.activePath(conversationId)
    }
  }

  /**
   * Move the head to the newest leaf under messageId: repeatedly descend into
   * the newest child. rowid breaks created_at ties (same-ms inserts).
   */
  switchBranch(conversationId: string, messageId: string): void {
    const message = this.getMessage(messageId)
    if (message.conversationId !== conversationId) {
      throw new Error('Message does not belong to this conversation')
    }
    const newestChild = this.db.prepare(
      'SELECT id FROM messages WHERE parent_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1'
    )
    let leaf = messageId
    for (;;) {
      const child = newestChild.get(leaf) as { id: string } | undefined
      if (!child) break
      leaf = child.id
    }
    this.setHead(conversationId, leaf)
  }

  // --- full-text search (FTS5) -------------------------------------------------

  /** Search titles + message bodies; returns at most one hit per conversation. */
  searchConversations(query: string, limit = 20): ChatSearchHit[] {
    if (!this.ftsReady) return []
    // Split on every non-alphanumeric run, exactly as the unicode61 tokenizer
    // does when indexing. Stripping intra-word separators instead (don't→dont,
    // state-of-the-art→stateoftheart) yields a token no indexed row starts with —
    // the index emitted don/t and state/of/the/art — so those terms silently
    // matched nothing. Lowercasing also neutralizes FTS5's AND/OR/NOT/NEAR
    // operators (uppercase-only); the tokenizer case-folds too, so recall is
    // unaffected. Resulting tokens are pure alphanumeric, so none can be FTS5 syntax.
    const tokens = query
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter(Boolean)
    if (tokens.length === 0) return []
    // AND the terms; prefix-match the final one for as-you-type search.
    const match = tokens.map((t, i) => (i === tokens.length - 1 ? `${t}*` : t)).join(' ')

    // Stream matches best-first and keep ONE hit per conversation, stopping once
    // we have `limit` distinct conversations. A bounded SQL LIMIT here silently
    // dropped conversations whose best message ranked past the window when a few
    // long threads each matched many messages; .iterate() reads only as far as
    // needed to fill the limit, so no matching conversation is starved.
    const stmt = this.db.prepare(
      `SELECT conversation_id AS cid, message_id AS mid,
              snippet(chat_fts, -1, '<b>', '</b>', '…', 12) AS snip,
              bm25(chat_fts) AS rank
       FROM chat_fts WHERE chat_fts MATCH ? ORDER BY rank`
    )
    const seen = new Set<string>()
    const hits: ChatSearchHit[] = []
    const convStmt = this.db.prepare(
      'SELECT title, pinned, updated_at FROM conversations WHERE id = ?'
    )
    for (const row of stmt.iterate(match)) {
      const r = row as { cid: string; mid: string | null; snip: string; rank: number }
      if (seen.has(r.cid)) continue
      seen.add(r.cid)
      const conv = convStmt.get(r.cid) as
        | { title: string; pinned: number; updated_at: number }
        | undefined
      if (!conv) continue
      hits.push({
        conversationId: r.cid,
        messageId: r.mid,
        title: conv.title,
        snippet: r.snip,
        pinned: conv.pinned === 1,
        updatedAt: conv.updated_at
      })
      if (hits.length >= limit) break
    }
    return hits
  }

  /** One-shot population of chat_fts for conversations/messages created before 0006. */
  backfillChatFts(): void {
    const count = this.db.prepare('SELECT count(*) AS c FROM chat_fts').get() as { c: number }
    if (count.c > 0) return
    const convs = this.db.prepare('SELECT id, title FROM conversations').all() as unknown as Array<{
      id: string
      title: string
    }>
    if (convs.length === 0) return
    // Atomic: titles + bodies commit together, so an interrupted backfill rolls
    // back (chat_fts stays empty) and retries next start — a row-count guard
    // alone would treat a titles-only partial as "done" and never index bodies.
    this.db.exec('BEGIN')
    try {
      for (const c of convs) this.ftsSetTitle(c.id, c.title)
      const msgs = this.db
        .prepare('SELECT id, conversation_id, parts FROM messages')
        .all() as unknown as Array<{ id: string; conversation_id: string; parts: string }>
      for (const m of msgs)
        this.ftsIndexBody(m.id, m.conversation_id, bodyOfParts(parseParts(m.parts)))
      this.db.exec('COMMIT')
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }
  }

  /** Replace a conversation's title row (message_id IS NULL) in chat_fts. */
  private ftsSetTitle(conversationId: string, title: string): void {
    if (!this.ftsReady) return
    this.db
      .prepare('DELETE FROM chat_fts WHERE conversation_id = ? AND message_id IS NULL')
      .run(conversationId)
    if (title.trim()) {
      this.db
        .prepare('INSERT INTO chat_fts (conversation_id, message_id, title, body) VALUES (?, ?, ?, ?)')
        .run(conversationId, null, title, '')
    }
  }

  /** Replace a message's body row in chat_fts (no-op for empty bodies). */
  private ftsIndexBody(messageId: string, conversationId: string, body: string): void {
    if (!this.ftsReady) return
    this.db.prepare('DELETE FROM chat_fts WHERE message_id = ?').run(messageId)
    if (body) {
      this.db
        .prepare('INSERT INTO chat_fts (conversation_id, message_id, title, body) VALUES (?, ?, ?, ?)')
        .run(conversationId, messageId, '', body)
    }
  }

  private ftsReindexMessage(messageId: string, parts: MessagePart[]): void {
    if (!this.ftsReady) return
    const row = this.db
      .prepare('SELECT conversation_id FROM messages WHERE id = ?')
      .get(messageId) as { conversation_id: string } | undefined
    if (!row) return
    this.ftsIndexBody(messageId, row.conversation_id, bodyOfParts(parts))
  }

  // --- attachments --------------------------------------------------------------

  insertAttachment(input: {
    messageId: string
    kind: 'image' | 'document'
    path: string
    mime: string | null
    libraryDocId?: string | null
  }): void {
    this.db
      .prepare(
        'INSERT INTO attachments (id, message_id, kind, path, mime, library_doc_id) VALUES (?, ?, ?, ?, ?, ?)'
      )
      .run(
        crypto.randomUUID(),
        input.messageId,
        input.kind,
        input.path,
        input.mime,
        input.libraryDocId ?? null
      )
  }

  /**
   * Copied image file paths recorded for a conversation — attachments rows
   * plus image parts (both record the same copy; the union tolerates either
   * going stale). Deleting the conversation cascades away the only record of
   * these, so callers must collect them BEFORE deleteConversation.
   */
  imageAttachmentPaths(conversationId: string): string[] {
    const paths = new Set<string>()
    const rows = this.db
      .prepare(
        `SELECT a.path FROM attachments a JOIN messages m ON a.message_id = m.id
         WHERE m.conversation_id = ? AND a.kind = 'image'`
      )
      .all(conversationId) as unknown as Array<{ path: string }>
    for (const row of rows) paths.add(row.path)
    const messages = this.db
      .prepare('SELECT parts FROM messages WHERE conversation_id = ?')
      .all(conversationId) as unknown as Array<{ parts: string }>
    for (const message of messages) {
      for (const part of parseParts(message.parts)) {
        if (part.type === 'image') paths.add(part.path)
      }
    }
    return [...paths]
  }

  // --- helpers --------------------------------------------------------------------

  private toMessage(row: MessageRow): ChatMessage & { parts: MessagePart[] } {
    const siblings = this.db
      .prepare(
        `SELECT id FROM messages WHERE conversation_id = ? AND parent_id IS ?
         ORDER BY created_at, rowid`
      )
      .all(row.conversation_id, row.parent_id) as unknown as Array<{ id: string }>
    const siblingIndex = Math.max(
      0,
      siblings.findIndex((s) => s.id === row.id)
    )
    return {
      id: row.id,
      conversationId: row.conversation_id,
      parentId: row.parent_id,
      role: row.role,
      parts: parseParts(row.parts),
      modelId: row.model_id,
      tokensIn: row.tokens_in,
      tokensOut: row.tokens_out,
      ttftMs: row.ttft_ms,
      genMs: row.gen_ms,
      createdAt: row.created_at,
      siblingIndex,
      siblingCount: siblings.length,
      siblingIds: siblings.map((s) => s.id)
    }
  }
}
