export interface ModuleDef {
  id: string
  label: string
  /** Core modules are always on — no toggle card, no placeholder. */
  core: boolean
  /** Optional modules only: enabled state until the user toggles. */
  defaultEnabled: boolean
  /** True = ships as a "coming in Version 3" placeholder page. */
  placeholder: boolean
  /** One-liner for placeholder pages and the Settings module cards. */
  description: string
}

export const MODULES = [
  {
    id: 'chat',
    label: 'Chat',
    core: true,
    defaultEnabled: true,
    placeholder: false,
    description: 'Talk to local models with attachments, web search and your library.'
  },
  {
    id: 'agent',
    label: 'Agent',
    core: true,
    defaultEnabled: true,
    placeholder: false,
    description: 'Hand tasks to a local agent with shell, files, web and skills.'
  },
  {
    id: 'code',
    label: 'Code',
    core: true,
    defaultEnabled: true,
    placeholder: false,
    description: 'Edit a workspace with Monaco, a terminal and an embedded agent.'
  },
  {
    id: 'research',
    label: 'Research',
    core: true,
    defaultEnabled: true,
    placeholder: false,
    description: 'Multi-round web research that ends in a cited report.'
  },
  {
    id: 'models',
    label: 'Models',
    core: true,
    defaultEnabled: true,
    placeholder: false,
    description: 'Download, load and assign the local models behind every module.'
  },
  {
    id: 'news',
    label: 'News',
    core: false,
    defaultEnabled: true,
    placeholder: false,
    description: 'RSS feeds fetched, extracted and summarized locally.'
  },
  {
    id: 'benchmarks',
    label: 'Benchmarks',
    core: false,
    defaultEnabled: false,
    placeholder: true,
    description: 'Compare local models head-to-head on your own tasks.'
  },
  {
    id: 'design',
    label: 'Design',
    core: false,
    defaultEnabled: false,
    placeholder: true,
    description: 'Generate and iterate on visual assets.'
  },
  {
    id: 'projects',
    label: 'Projects',
    core: false,
    defaultEnabled: false,
    placeholder: true,
    description: 'Group chats, files and runs around one piece of work.'
  },
  {
    id: 'collections',
    label: 'Collections',
    core: false,
    defaultEnabled: false,
    placeholder: true,
    description: 'Browse and curate the document collections behind RAG.'
  },
  {
    id: 'memory',
    label: 'Memory',
    core: false,
    defaultEnabled: false,
    placeholder: true,
    description: 'What the assistant remembers about you across sessions.'
  },
  {
    id: 'skills',
    label: 'Skills',
    core: false,
    defaultEnabled: false,
    placeholder: true,
    description: 'Author and manage skill packs.'
  },
  {
    id: 'connectors',
    label: 'Connectors',
    core: false,
    defaultEnabled: false,
    placeholder: true,
    description: 'Connect external services and tools via MCP.'
  }
] as const satisfies readonly ModuleDef[]

export type ModuleId = (typeof MODULES)[number]['id']

export const CORE_MODULES = MODULES.filter((m) => m.core)
export const OPTIONAL_MODULES = MODULES.filter((m) => !m.core)

/** Code-side defaults for the `modules.enabled` setting (optional modules only). */
export function defaultModulesEnabled(): Record<string, boolean> {
  return Object.fromEntries(OPTIONAL_MODULES.map((m) => [m.id, m.defaultEnabled]))
}

export function isModuleEnabled(
  module: ModuleDef,
  enabled: Record<string, boolean> | undefined
): boolean {
  if (module.core) return true
  return enabled?.[module.id] ?? module.defaultEnabled
}
