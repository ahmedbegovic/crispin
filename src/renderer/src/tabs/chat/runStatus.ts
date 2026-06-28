import type { ChatMessage } from '@shared/types'

export type ChatRunPhase = 'idle' | 'starting' | 'waitingFirstToken' | 'generating'

type MessageWithParts = Pick<ChatMessage, 'parts'> | null | undefined

export function chatRunPhase(
  streamingId: string | undefined,
  message?: MessageWithParts
): ChatRunPhase {
  if (streamingId === undefined) return 'idle'
  if (streamingId === '') return 'starting'
  return message && message.parts.length > 0 ? 'generating' : 'waitingFirstToken'
}

export const CHAT_RUN_PHASE_LABELS: Record<ChatRunPhase, string> = {
  idle: '',
  starting: 'Starting local run...',
  waitingFirstToken: 'Loading local model...',
  generating: 'Generating...'
}

export function chatRunPhaseLabel(phase: ChatRunPhase): string {
  return CHAT_RUN_PHASE_LABELS[phase]
}
