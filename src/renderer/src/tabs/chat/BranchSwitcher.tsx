import { ChevronLeft, ChevronRight } from 'lucide-react'
import type { ChatMessage } from '@shared/types'
import { useChatStore } from '@/stores/chat'
import { toastError } from '@/stores/toasts'

interface Props {
  message: ChatMessage
  disabled?: boolean
}

/** i/n arrows on any message whose parent has multiple children. */
export default function BranchSwitcher({ message, disabled = false }: Props) {
  const switchSibling = useChatStore((s) => s.switchSibling)
  if (message.siblingCount <= 1) return null

  const go = (direction: -1 | 1): void => {
    void switchSibling(message.conversationId, message, direction).catch(toastError)
  }

  return (
    <div className="flex items-center gap-0.5 text-[11px] text-zinc-500">
      <button
        onClick={() => go(-1)}
        disabled={disabled || message.siblingIndex === 0}
        className="rounded p-0.5 hover:bg-zinc-800 hover:text-zinc-200 disabled:opacity-30 disabled:hover:bg-transparent"
        title="Previous branch"
      >
        <ChevronLeft size={13} />
      </button>
      <span className="tabular-nums">
        {message.siblingIndex + 1}/{message.siblingCount}
      </span>
      <button
        onClick={() => go(1)}
        disabled={disabled || message.siblingIndex >= message.siblingCount - 1}
        className="rounded p-0.5 hover:bg-zinc-800 hover:text-zinc-200 disabled:opacity-30 disabled:hover:bg-transparent"
        title="Next branch"
      >
        <ChevronRight size={13} />
      </button>
    </div>
  )
}
