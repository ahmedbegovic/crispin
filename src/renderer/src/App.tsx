import { useEffect, useState, type ComponentType } from 'react'
import {
  Bot,
  Code2,
  MessageSquare,
  Newspaper,
  Package,
  Telescope,
  type LucideIcon
} from 'lucide-react'
import { useSystemStore } from './stores/system'
import StatusBar from './components/StatusBar'
import ChatTab from './tabs/chat/ChatTab'
import AgentTab from './tabs/agent/AgentTab'
import CodeTab from './tabs/code/CodeTab'
import ResearchTab from './tabs/research/ResearchTab'
import ModelsTab from './tabs/models/ModelsTab'
import NewsTab from './tabs/news/NewsTab'

type TabId = 'chat' | 'agent' | 'code' | 'research' | 'models' | 'news'

interface TabDef {
  id: TabId
  label: string
  icon: LucideIcon
  component: ComponentType
}

const TABS: TabDef[] = [
  { id: 'chat', label: 'Chat', icon: MessageSquare, component: ChatTab },
  { id: 'agent', label: 'Agent', icon: Bot, component: AgentTab },
  { id: 'code', label: 'Code', icon: Code2, component: CodeTab },
  { id: 'research', label: 'Research', icon: Telescope, component: ResearchTab },
  { id: 'models', label: 'Models', icon: Package, component: ModelsTab },
  { id: 'news', label: 'News', icon: Newspaper, component: NewsTab }
]

export default function App() {
  const [active, setActive] = useState<TabId>('chat')
  const init = useSystemStore((s) => s.init)

  useEffect(() => {
    void init()
  }, [init])

  return (
    <div className="flex h-full flex-col">
      <div className="flex min-h-0 flex-1">
        {/* Left rail */}
        <nav className="flex w-[76px] shrink-0 flex-col border-r border-zinc-800/80 bg-zinc-950">
          <div className="drag-region h-12 shrink-0" />
          <div className="flex flex-1 flex-col items-center gap-1 px-2">
            {TABS.map(({ id, label, icon: Icon }) => {
              const selected = id === active
              return (
                <button
                  key={id}
                  onClick={() => setActive(id)}
                  className={`no-drag flex w-full flex-col items-center gap-1 rounded-lg py-2.5 text-[10px] font-medium transition-colors ${
                    selected
                      ? 'bg-zinc-800 text-zinc-100'
                      : 'text-zinc-500 hover:bg-zinc-900 hover:text-zinc-300'
                  }`}
                >
                  <Icon size={19} strokeWidth={1.8} />
                  {label}
                </button>
              )
            })}
          </div>
        </nav>

        {/* Main area: keep every tab mounted so state survives switching */}
        <main className="relative min-w-0 flex-1 bg-zinc-925" style={{ backgroundColor: '#101013' }}>
          <div className="drag-region absolute inset-x-0 top-0 z-10 h-9" />
          {TABS.map(({ id, component: Tab }) => (
            <div key={id} className={`h-full ${id === active ? 'block' : 'hidden'}`}>
              <Tab />
            </div>
          ))}
        </main>
      </div>
      <StatusBar />
    </div>
  )
}
