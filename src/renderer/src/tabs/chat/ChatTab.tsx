import { useEffect } from 'react'
import { MessageSquare, Plus } from 'lucide-react'
import 'highlight.js/styles/github-dark.css'
import 'katex/dist/katex.min.css'
import { useChatStore } from '@/stores/chat'
import { useLibraryStore } from '@/stores/library'
import { useMcpStore } from '@/stores/mcp'
import { useChatPrefs, chatPrefsVars } from '@/stores/chatPrefs'
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
  const textSize = useChatPrefs((s) => s.textSize)
  const width = useChatPrefs((s) => s.width)

  useEffect(() => {
    void init().catch(toastError)
    void initLibrary().catch(toastError)
    void initMcp().catch(toastError)
  }, [init, initLibrary, initMcp])

  return (
    // --chat-fs / --chat-lh / --chat-measure cascade to the thread + composer;
    // reading the prefs here means the memoized MarkdownPart never re-renders.
    <div className="flex h-full" style={chatPrefsVars(textSize, width)}>
      <ConversationSidebar />
      {/* ThreadHeader is the draggable titlebar band for an open conversation;
          the no-conversation / loading states keep their own absolute strip. */}
      {activeId !== null && conversation ? (
        <div className="relative flex min-w-0 flex-1 flex-col border-l border-zinc-800/60 bg-[#15151a]">
          <Thread key={activeId} conversationId={activeId} />
          <Composer key={`composer-${activeId}`} conversation={conversation} />
        </div>
      ) : activeId !== null ? (
        // Selected but chat.get hasn't resolved yet — don't flash the empty CTA.
        <div className="relative flex min-w-0 flex-1 items-center justify-center border-l border-zinc-800/60 bg-[#15151a] text-[13px] text-zinc-600">
          <div className="drag-region absolute inset-x-0 top-0 h-12" />
          Loading…
        </div>
      ) : (
        <div className="relative flex min-w-0 flex-1 flex-col items-center justify-center gap-4 border-l border-zinc-800/60 bg-[#15151a]">
          <div className="drag-region absolute inset-x-0 top-0 h-12" />
          <MessageSquare size={32} strokeWidth={1.5} className="text-zinc-700" />
          <div className="text-center">
            <h2 className="text-[15px] font-medium text-zinc-200">Start a conversation</h2>
            <p className="mt-1 max-w-sm text-[12px] text-zinc-600">
              Chat with a local model — attach files, search the web, or query your library.
            </p>
          </div>
          <button
            onClick={() => void create().catch(toastError)}
            className="press flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-1.5 text-[12px] font-medium text-white hover:bg-emerald-500"
          >
            <Plus size={14} />
            New chat
          </button>
        </div>
      )}
    </div>
  )
}
