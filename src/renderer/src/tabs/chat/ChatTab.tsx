import { MessageSquare } from 'lucide-react'
import Placeholder from '@/components/Placeholder'

export default function ChatTab() {
  return (
    <Placeholder
      icon={MessageSquare}
      title="Chat"
      subtitle="Streaming chat with web search, image & document uploads, RAG over your library, skills and MCP tools."
      milestone="M2"
    />
  )
}
