import { Bot } from 'lucide-react'
import Placeholder from '@/components/Placeholder'

export default function AgentTab() {
  return (
    <Placeholder
      icon={Bot}
      title="Agent"
      subtitle="Hand a task to an opencode-powered agent with shell, files, web, MCP, skills and persistent memory."
      milestone="M3"
    />
  )
}
