import type { ChatMessage } from '@shared/types'

export type ChatRunPhase =
  | 'idle'
  | 'starting'
  | 'loadingModel'
  | 'waitingFirstToken'
  | 'generating'
  | 'stopping'

type MessageWithParts = Pick<ChatMessage, 'parts'> | null | undefined
interface ChatRunPhaseContext {
  modelLoad?: boolean
  stopping?: boolean
}

export function chatRunPhase(
  streamingId: string | undefined,
  message?: MessageWithParts,
  ctx?: ChatRunPhaseContext
): ChatRunPhase {
  if (streamingId === undefined) return 'idle'
  if (ctx?.stopping) return 'stopping'
  if (ctx?.modelLoad) return 'loadingModel'
  if (streamingId === '') return 'starting'
  return message && message.parts.length > 0 ? 'generating' : 'waitingFirstToken'
}

export const CHAT_RUN_PHASE_LABELS: Record<ChatRunPhase, string> = {
  idle: '',
  starting: 'Starting local run…',
  loadingModel: 'Loading model…',
  waitingFirstToken: 'Thinking…',
  generating: 'Generating…',
  stopping: 'Stopping…'
}

export function chatRunPhaseLabel(phase: ChatRunPhase): string {
  return CHAT_RUN_PHASE_LABELS[phase]
}
