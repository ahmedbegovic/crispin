import { mkdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { extname, join, resolve, sep } from 'node:path'
import type { ChatMessage, Conversation } from '@shared/types'
import { handle } from '../ipc/router'
import type { ChatRepo } from '../services/chat/repo'
import type { ChatOrchestrator } from '../services/chat/orchestrator'
import type { ModelService } from '../services/model-service'
import { dataDir } from '../services/paths'

export interface ChatFeatureDeps {
  repo: ChatRepo
  orchestrator: ChatOrchestrator
  modelService: ModelService
}

/** Registers every chat.* IPC method. */
export function registerChatFeature(deps: ChatFeatureDeps): void {
  const { repo, orchestrator, modelService } = deps

  // conversationViewSchema requires contextLength — the composer's donut denominator.
  const viewOf = (conversationId: string): ReturnType<ChatRepo['view']> & {
    contextLength: number | null
  } => {
    const view = repo.view(conversationId)
    // contextForConversation owns the effective-tier resolution, so the donut
    // denominator can't drift from the tier the orchestrator generates with.
    return { ...view, contextLength: orchestrator.contextForConversation(view.conversation) }
  }

  handle('chat.list', (input) => ({
    conversations: repo.listConversations(input?.archived ?? false)
  }))

  handle('chat.create', ({ tier, family, collectionId, webEnabled }) => ({
    conversation: repo.createConversation({
      tier: tier ?? modelService.overview().defaults.chat,
      // No explicit tier = keep following featureDefaults.chat as it changes.
      tierPinned: tier !== undefined,
      // No explicit family = follow the global default family live (null).
      family: family ?? null,
      collectionId,
      webEnabled
    })
  }))

  handle('chat.get', ({ conversationId }) => viewOf(conversationId))

  handle('chat.send', (input) => orchestrator.send(input))

  handle('chat.abort', ({ conversationId }) => ({ ok: orchestrator.abort(conversationId) }))

  handle('chat.regenerate', ({ conversationId, messageId, tier, family, lengthHint, toneHint }) =>
    orchestrator.regenerate(conversationId, messageId, { tier, family, lengthHint, toneHint })
  )

  handle('chat.editResend', ({ conversationId, messageId, text }) =>
    orchestrator.editResend(conversationId, messageId, text)
  )

  handle('chat.switchBranch', ({ conversationId, messageId }) => {
    if (orchestrator.isActive(conversationId)) {
      throw new Error('Cannot switch branches while a generation is running')
    }
    repo.switchBranch(conversationId, messageId)
    return viewOf(conversationId)
  })

  handle('chat.update', ({ conversationId, ...fields }) => {
    repo.updateConversation(conversationId, fields)
    return { ok: true }
  })

  handle('chat.delete', ({ conversationId }) => {
    orchestrator.abort(conversationId)
    // The cascade erases the only record of copied image files, so unlink them
    // first. Only files inside our attachments dir: document attachments store
    // the user's ORIGINAL path and must never be deleted.
    const attachmentsDir = join(dataDir(), 'attachments')
    for (const path of repo.imageAttachmentPaths(conversationId)) {
      if (!resolve(path).startsWith(attachmentsDir + sep)) continue
      try {
        unlinkSync(path)
      } catch {
        // best-effort — an already-missing file changes nothing
      }
    }
    repo.deleteConversation(conversationId)
    return { ok: true }
  })

  handle('chat.search', ({ query, limit }) => ({
    results: repo.searchConversations(query, limit)
  }))

  handle('chat.export', ({ conversationId }) => {
    const { conversation, messages } = repo.view(conversationId)
    const dir = join(dataDir(), 'exports')
    mkdirSync(dir, { recursive: true })
    const path = join(dir, `${slugify(conversation.title)}-${conversation.id.slice(0, 8)}.md`)
    writeFileSync(path, conversationMarkdown(conversation, messages))
    return { path }
  })

  handle('chat.savePastedFile', ({ name, mime, dataBase64 }) => {
    const dir = join(dataDir(), 'attachments')
    mkdirSync(dir, { recursive: true })
    const ext = extFromMime(mime) || extname(name) || ''
    const path = join(dir, `${crypto.randomUUID()}${ext}`)
    writeFileSync(path, Buffer.from(dataBase64, 'base64'))
    return { path }
  })
}

const IMAGE_EXT_BY_MIME: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif'
}
const extFromMime = (mime: string): string => IMAGE_EXT_BY_MIME[mime] ?? ''

const slugify = (title: string): string =>
  title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'chat'

/** Render the active path to readable Markdown (tool round-trips omitted). */
function conversationMarkdown(conversation: Conversation, messages: ChatMessage[]): string {
  const lines: string[] = [`# ${conversation.title}`, '']
  for (const m of messages) {
    if (m.role !== 'user' && m.role !== 'assistant') continue
    lines.push(`## ${m.role === 'user' ? 'You' : 'Assistant'}`, '')
    for (const part of m.parts) {
      if (part.type === 'text') lines.push(part.text, '')
      else if (part.type === 'image') lines.push(`![image](${part.path})`, '')
      else if (part.type === 'sources') {
        lines.push('### Sources', '')
        for (const s of part.sources) lines.push(`${s.id}. [${s.title ?? s.url}](${s.url})`)
        lines.push('')
      }
    }
  }
  return lines.join('\n')
}
