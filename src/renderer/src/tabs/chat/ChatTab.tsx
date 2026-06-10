import { useEffect } from 'react'
import { MessageSquare, Plus } from 'lucide-react'
import 'highlight.js/styles/github-dark.css'
import { useChatStore } from '@/stores/chat'
import { useLibraryStore } from '@/stores/library'
import { useMcpStore } from '@/stores/mcp'
import { toastError } from '@/stores/toasts'
import ConversationSidebar from './ConversationSidebar'
import Thread from './Thread'
import Composer from './Composer'

export default function ChatTab() {
  const init = useChatStore((s) => s.init)
  const initLibrary = useLibraryStore((s) => s.init)
  const initMcp = useMcpStore((s) => s.init)
  const activeId = useChatStore((s) => s.activeId)
  const conversation = useChatStore((s) =>
    s.activeId !== null ? s.conversationById[s.activeId] : undefined
  )
  const create = useChatStore((s) => s.create)

  useEffect(() => {
    void init().catch(toastError)
    void initLibrary().catch(toastError)
    void initMcp().catch(toastError)
  }, [init, initLibrary, initMcp])

  return (
    <div className="flex h-full">
      <ConversationSidebar />
      {activeId !== null && conversation ? (
        <div className="flex min-w-0 flex-1 flex-col">
          <Thread key={activeId} conversationId={activeId} />
          <Composer key={`composer-${activeId}`} conversation={conversation} />
        </div>
      ) : activeId !== null ? (
        // Selected but chat.get hasn't resolved yet — don't flash the empty CTA.
        <div className="flex min-w-0 flex-1 items-center justify-center text-[13px] text-zinc-600">
          Loading…
        </div>
      ) : (
        <div className="flex min-w-0 flex-1 flex-col items-center justify-center gap-4">
          <MessageSquare size={32} strokeWidth={1.5} className="text-zinc-700" />
          <div className="text-center">
            <h2 className="text-[14px] font-medium text-zinc-300">No conversation selected</h2>
            <p className="mt-1 text-[12px] text-zinc-600">
              Start a chat with a local model — attach files, search the web, query your library.
            </p>
          </div>
          <button
            onClick={() => void create().catch(toastError)}
            className="flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-1.5 text-[12px] font-medium text-white hover:bg-emerald-500"
          >
            <Plus size={14} />
            New chat
          </button>
        </div>
      )}
    </div>
  )
}
