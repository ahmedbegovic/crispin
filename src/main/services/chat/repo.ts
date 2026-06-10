import type {
  ChatMessage,
  Conversation,
  ConversationMeta,
  MessagePart,
  MessageRole,
  Tier
} from '@shared/types'
import type { OrionDatabase } from '../db'

interface ConversationRow {
  id: string
  title: string
  system_prompt: string | null
  head_message_id: string | null
  default_tier: Tier
  collection_id: string | null
  web_enabled: number
  archived: number
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
  created_at: number
}

const rowToConversation = (row: ConversationRow): Conversation => ({
  id: row.id,
  title: row.title,
  systemPrompt: row.system_prompt,
  headMessageId: row.head_message_id,
  defaultTier: row.default_tier,
  collectionId: row.collection_id,
  webEnabled: row.web_enabled === 1,
  archived: row.archived === 1,
  createdAt: row.created_at,
  updatedAt: row.updated_at
})

const parseParts = (json: string): MessagePart[] => {
  try {
    return JSON.parse(json) as MessagePart[]
  } catch {
    return []
  }
}

export interface InsertMessageInput {
  conversationId: string
  parentId: string | null
  role: MessageRole
  parts: MessagePart[]
  modelId?: string | null
}

/** All chat SQL lives here: conversations CRUD + the message tree. */
export class ChatRepo {
  constructor(private readonly db: OrionDatabase) {}

  // --- conversations ----------------------------------------------------------

  listConversations(archived: boolean): ConversationMeta[] {
    const rows = this.db
      .prepare('SELECT * FROM conversations WHERE archived = ? ORDER BY updated_at DESC')
      .all(archived ? 1 : 0) as unknown as ConversationRow[]
    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      archived: r.archived === 1,
      updatedAt: r.updated_at
    }))
  }

  createConversation(input: {
    tier: Tier
    collectionId?: string | null
    webEnabled?: boolean
  }): Conversation {
    const now = Date.now()
    const id = crypto.randomUUID()
    this.db
      .prepare(
        `INSERT INTO conversations (id, default_tier, collection_id, web_enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(id, input.tier, input.collectionId ?? null, input.webEnabled ? 1 : 0, now, now)
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
      defaultTier?: Tier
      collectionId?: string | null
      webEnabled?: boolean
      archived?: boolean
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
    if (fields.defaultTier !== undefined) set('default_tier', fields.defaultTier)
    if (fields.collectionId !== undefined) set('collection_id', fields.collectionId)
    if (fields.webEnabled !== undefined) set('web_enabled', fields.webEnabled ? 1 : 0)
    if (fields.archived !== undefined) set('archived', fields.archived ? 1 : 0)
    set('updated_at', Date.now())
    values.push(id)
    this.db.prepare(`UPDATE conversations SET ${sets.join(', ')} WHERE id = ?`).run(...values)
  }

  deleteConversation(id: string): void {
    this.db.prepare('DELETE FROM conversations WHERE id = ?').run(id) // messages cascade
  }

  setTitle(id: string, title: string): void {
    this.db.prepare('UPDATE conversations SET title = ? WHERE id = ?').run(title, id)
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
    tokens?: { tokensIn: number | null; tokensOut: number | null }
  ): void {
    if (tokens) {
      this.db
        .prepare('UPDATE messages SET parts = ?, tokens_in = ?, tokens_out = ? WHERE id = ?')
        .run(JSON.stringify(parts), tokens.tokensIn, tokens.tokensOut, messageId)
    } else {
      this.db.prepare('UPDATE messages SET parts = ? WHERE id = ?').run(JSON.stringify(parts), messageId)
    }
  }

  setHead(conversationId: string, messageId: string | null): void {
    this.db
      .prepare('UPDATE conversations SET head_message_id = ?, updated_at = ? WHERE id = ?')
      .run(messageId, Date.now(), conversationId)
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
      createdAt: row.created_at,
      siblingIndex,
      siblingCount: siblings.length,
      siblingIds: siblings.map((s) => s.id)
    }
  }
}
