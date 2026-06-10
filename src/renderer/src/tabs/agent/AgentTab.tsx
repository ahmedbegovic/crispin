import { useEffect, useState } from 'react'
import { BookText, Bot, FolderOpen, Plus, Sparkles } from 'lucide-react'
import 'highlight.js/styles/github-dark.css'
import { useAgentStore } from '@/stores/agent'
import { toastError } from '@/stores/toasts'
import SessionSidebar from './SessionSidebar'
import Timeline from './Timeline'
import AgentComposer from './AgentComposer'
import PermissionModal from './PermissionModal'
import MemoryPanel from './MemoryPanel'
import SkillsPanel from './SkillsPanel'

export default function AgentTab() {
  const init = useAgentStore((s) => s.init)
  const selectInitialAgentSession = useAgentStore((s) => s.selectInitialAgentSession)
  const activeId = useAgentStore((s) => s.activeId)
  // The store holds Code-panel sessions too — this tab only ever shows its own.
  const session = useAgentStore((s) =>
    s.activeId !== null
      ? s.sessions.find((x) => x.id === s.activeId && x.tab === 'agent')
      : undefined
  )
  const create = useAgentStore((s) => s.create)
  const [memoryOpen, setMemoryOpen] = useState(false)
  const [skillsOpen, setSkillsOpen] = useState(false)

  useEffect(() => {
    // init() is a no-op guard when the Code panel ran it first, so always
    // chain the eager agent-tab select after it resolves.
    void init().then(selectInitialAgentSession).catch(toastError)
  }, [init, selectInitialAgentSession])

  return (
    <div className="flex h-full">
      <SessionSidebar />
      {session ? (
        <div className="flex min-w-0 flex-1 flex-col">
          {/* pt-12 clears the hiddenInset titlebar band (h-12, traffic lights centered). */}
          <header className="flex shrink-0 items-center gap-2.5 border-b border-zinc-800/80 px-6 pb-2.5 pt-12">
            <span className="shrink-0 truncate text-[13px] font-medium text-zinc-200">
              {session.title || 'New session'}
            </span>
            <span
              title={session.directory}
              className="flex min-w-0 items-center gap-1 text-[11px] text-zinc-600"
            >
              <FolderOpen size={11} className="shrink-0" />
              <span className="truncate">{session.directory}</span>
            </span>
            <div className="no-drag ml-auto flex shrink-0 items-center gap-0.5">
              <button
                onClick={() => setMemoryOpen(true)}
                title="Agent memory"
                className="rounded-md p-1.5 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
              >
                <BookText size={14} />
              </button>
              <button
                onClick={() => setSkillsOpen(true)}
                title="Agent skills"
                className="rounded-md p-1.5 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
              >
                <Sparkles size={14} />
              </button>
            </div>
          </header>
          <Timeline key={activeId} sessionId={session.id} />
          <AgentComposer key={`composer-${activeId}`} sessionId={session.id} />
        </div>
      ) : (
        <div className="flex min-w-0 flex-1 flex-col items-center justify-center gap-4">
          <Bot size={32} strokeWidth={1.5} className="text-zinc-700" />
          <div className="text-center">
            <h2 className="text-[14px] font-medium text-zinc-300">No agent session</h2>
            <p className="mt-1 text-[12px] text-zinc-600">
              Pick a folder and hand tasks to a local agent with shell, files, web and skills.
            </p>
          </div>
          <button
            onClick={() => void create().catch(toastError)}
            className="no-drag flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-1.5 text-[12px] font-medium text-white hover:bg-emerald-500"
          >
            <Plus size={14} />
            New session
          </button>
        </div>
      )}
      <PermissionModal />
      <MemoryPanel open={memoryOpen} onClose={() => setMemoryOpen(false)} />
      <SkillsPanel open={skillsOpen} onClose={() => setSkillsOpen(false)} />
    </div>
  )
}
