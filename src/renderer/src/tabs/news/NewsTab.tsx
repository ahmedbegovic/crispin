import { Newspaper } from 'lucide-react'
import Placeholder from '@/components/Placeholder'

export default function NewsTab() {
  return (
    <Placeholder
      icon={Newspaper}
      title="News"
      subtitle="Your sources, fetched and summarized locally by the small utility model."
      milestone="M6"
    />
  )
}
