import { lazy, Suspense, useEffect, useState, type ComponentType, type ReactElement } from 'react'
import { Settings, type LucideIcon } from 'lucide-react'
import { isModuleEnabled, MODULES, type ModuleDef } from '@shared/modules'
import { MODULE_ICONS } from './lib/module-icons'
import { useSystemStore } from './stores/system'
import { useSettingsStore } from './stores/settings'
import { useUiStore } from './stores/ui'
import StatusBar from './components/StatusBar'
import Toasts from './components/Toasts'
import Placeholder from './components/Placeholder'
import ChatTab from './tabs/chat/ChatTab'
import AgentTab from './tabs/agent/AgentTab'
import ResearchTab from './tabs/research/ResearchTab'
import ModelsTab from './tabs/models/ModelsTab'
import NewsTab from './tabs/news/NewsTab'
import SettingsTab from './tabs/settings/SettingsTab'

// Lazy so monaco + xterm (and their worker chunks) load on first Code-tab
// activation instead of being evaluated at app boot.
const CodeTab = lazy(() => import('./tabs/code/CodeTab'))

/** Real implementations; everything else renders a Version-3 placeholder. */
const MODULE_COMPONENTS: Partial<Record<string, ComponentType>> = {
  chat: ChatTab,
  agent: AgentTab,
  code: CodeTab,
  research: ResearchTab,
  models: ModelsTab,
  news: NewsTab
}

function PlaceholderModule({ module }: { module: ModuleDef }) {
  return (
    <div className="relative h-full">
      <div className="drag-region absolute inset-x-0 top-0 h-12" />
      <Placeholder
        icon={MODULE_ICONS[module.id as keyof typeof MODULE_ICONS]}
        title={module.label}
        subtitle={module.description}
        milestone="Version 3"
      />
    </div>
  )
}

export default function App() {
  const active = useUiStore((s) => s.activeTab)
  const setActive = useUiStore((s) => s.setActiveTab)
  // Tabs mount lazily on first activation (so e.g. AgentTab's init doesn't
  // spawn an opencode server at boot) and stay mounted afterwards.
  const [visited, setVisited] = useState<Set<string>>(() => new Set(['chat']))
  const init = useSystemStore((s) => s.init)
  const initSettings = useSettingsStore((s) => s.init)
  const modulesEnabled = useSettingsStore((s) => s.settings?.modulesEnabled)

  useEffect(() => {
    void init()
    void initSettings()
  }, [init, initSettings])

  const visible = MODULES.filter((m) => isModuleEnabled(m, modulesEnabled))

  // Disabling the active tab's module strands the view — fall back to chat.
  useEffect(() => {
    if (active !== 'settings' && !visible.some((m) => m.id === active)) setActive('chat')
  }, [active, visible, setActive])

  const activate = (id: string): void => {
    setActive(id)
    setVisited((prev) => (prev.has(id) ? prev : new Set(prev).add(id)))
  }

  const railButton = (id: string, label: string, Icon: LucideIcon): ReactElement => (
    <button
      key={id}
      onClick={() => activate(id)}
      className={`no-drag flex w-full flex-col items-center gap-1 rounded-lg py-2.5 text-[10px] font-medium transition-colors ${
        id === active
          ? 'bg-zinc-800 text-zinc-100'
          : 'text-zinc-500 hover:bg-zinc-900 hover:text-zinc-300'
      }`}
    >
      <Icon size={19} strokeWidth={1.8} />
      {label}
    </button>
  )

  return (
    <div className="flex h-full flex-col">
      <div className="flex min-h-0 flex-1">
        {/* Left rail */}
        {/* 81px keeps the right border clear of the Tahoe-size traffic lights. */}
        <nav className="flex w-[81px] shrink-0 flex-col border-r border-zinc-800/80 bg-zinc-950">
          <div className="drag-region h-12 shrink-0" />
          <div className="scrollbar-none flex min-h-0 flex-1 flex-col items-center gap-1 overflow-y-auto px-2">
            {visible.map((m) => railButton(m.id, m.label, MODULE_ICONS[m.id]))}
          </div>
          {/* Settings pinned below the scroller, Discord-style. */}
          <div className="shrink-0 border-t border-zinc-800/80 px-2 py-1.5">
            {railButton('settings', 'Settings', Settings)}
          </div>
        </nav>

        {/* Main area: visited tabs stay mounted so state survives switching.
            No app-level drag overlay — each tab renders its own h-12 drag-region
            header band so header controls stay clickable. */}
        <main className="relative min-w-0 flex-1 bg-zinc-925" style={{ backgroundColor: '#101013' }}>
          {[...visible.map((m) => m.id), 'settings' as const]
            .filter((id) => visited.has(id))
            .map((id) => {
              const module = MODULES.find((m) => m.id === id)
              const Tab = id === 'settings' ? SettingsTab : MODULE_COMPONENTS[id]
              return (
                <div key={id} className={`h-full ${id === active ? 'block' : 'hidden'}`}>
                  <Suspense fallback={null}>
                    {Tab ? <Tab /> : module && <PlaceholderModule module={module} />}
                  </Suspense>
                </div>
              )
            })}
        </main>
      </div>
      <StatusBar />
      <Toasts />
    </div>
  )
}
