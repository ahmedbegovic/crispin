import { unlinkSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
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

  handle('chat.list', (input) => ({
    conversations: repo.listConversations(input?.archived ?? false)
  }))

  handle('chat.create', ({ tier, collectionId, webEnabled }) => ({
    conversation: repo.createConversation({
      tier: tier ?? modelService.overview().defaults.chat,
      collectionId,
      webEnabled
    })
  }))

  handle('chat.get', ({ conversationId }) => repo.view(conversationId))

  handle('chat.send', (input) => orchestrator.send(input))

  handle('chat.abort', ({ conversationId }) => ({ ok: orchestrator.abort(conversationId) }))

  handle('chat.regenerate', ({ conversationId, messageId }) =>
    orchestrator.regenerate(conversationId, messageId)
  )

  handle('chat.editResend', ({ conversationId, messageId, text }) =>
    orchestrator.editResend(conversationId, messageId, text)
  )

  handle('chat.switchBranch', ({ conversationId, messageId }) => {
    if (orchestrator.isActive(conversationId)) {
      throw new Error('Cannot switch branches while a generation is running')
    }
    repo.switchBranch(conversationId, messageId)
    return repo.view(conversationId)
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
}
