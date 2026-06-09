import { Package } from 'lucide-react'
import Placeholder from '@/components/Placeholder'

export default function ModelsTab() {
  return (
    <Placeholder
      icon={Package}
      title="Models"
      subtitle="Download MLX models from Hugging Face, manage the six quality tiers, and control what's loaded in RAM."
      milestone="M1"
    />
  )
}
