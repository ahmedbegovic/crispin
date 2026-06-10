import { memo } from 'react'
import { Brain, ChevronDown } from 'lucide-react'

interface Props {
  text: string
  /** True while this part is still receiving stream deltas. */
  active: boolean
}

/** Collapsed-by-default reasoning segment (gemma thought channel). */
const ThoughtBlock = memo(function ThoughtBlock({ text, active }: Props) {
  return (
    <details className="group/thought my-2 rounded-lg border border-zinc-800/80 bg-zinc-900/40">
      <summary className="flex cursor-pointer list-none items-center gap-1.5 px-3 py-1.5 text-[11.5px] text-zinc-500 hover:text-zinc-300 [&::-webkit-details-marker]:hidden">
        <Brain size={12} className={active ? 'animate-pulse text-amber-400' : ''} />
        {active ? 'Thinking…' : 'Thoughts'}
        <ChevronDown
          size={12}
          className="text-zinc-600 transition-transform group-open/thought:rotate-180"
        />
      </summary>
      <div className="select-text whitespace-pre-wrap border-t border-zinc-800/80 px-3 py-2 text-[12px] leading-relaxed text-zinc-500">
        {text}
      </div>
    </details>
  )
})

export default ThoughtBlock
