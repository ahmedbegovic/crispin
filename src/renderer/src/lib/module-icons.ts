import {
  Bot,
  Brain,
  Code2,
  FolderKanban,
  Gauge,
  Library,
  MessageSquare,
  Newspaper,
  Package,
  Palette,
  Plug,
  Sparkles,
  Telescope,
  type LucideIcon
} from 'lucide-react'
import type { ModuleId } from '@shared/modules'

/** Icons stay renderer-side; shared/modules.ts must not import lucide. */
export const MODULE_ICONS: Record<ModuleId, LucideIcon> = {
  chat: MessageSquare,
  agent: Bot,
  code: Code2,
  research: Telescope,
  models: Package,
  news: Newspaper,
  benchmarks: Gauge,
  design: Palette,
  projects: FolderKanban,
  collections: Library,
  memory: Brain,
  skills: Sparkles,
  connectors: Plug
}
