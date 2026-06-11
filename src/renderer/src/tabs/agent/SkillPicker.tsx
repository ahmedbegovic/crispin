import { Sparkles } from 'lucide-react'
import type { SkillMeta } from '@shared/types'

interface Props {
  skills: SkillMeta[]
  highlight: number
  onHover: (index: number) => void
  onPick: (skill: SkillMeta) => void
}

/**
 * Claude-Desktop-style popup anchored above the composer (the parent supplies
 * a `relative` wrapper). Keyboard handling lives in useSlashSkills.
 */
export default function SkillPicker({ skills, highlight, onHover, onPick }: Props) {
  return (
    <div className="absolute bottom-full left-0 right-0 z-20 mb-1.5 max-h-64 overflow-y-auto rounded-lg border border-zinc-700/80 bg-zinc-900 py-1 shadow-xl">
      {skills.map((skill, index) => (
        <button
          key={skill.name}
          onMouseEnter={() => onHover(index)}
          // mousedown beats the textarea blur — click would land too late.
          onMouseDown={(e) => {
            e.preventDefault()
            onPick(skill)
          }}
          className={`flex w-full items-start gap-2 px-3 py-1.5 text-left ${
            index === highlight ? 'bg-zinc-800' : ''
          }`}
        >
          <Sparkles
            size={12}
            className={`mt-0.5 shrink-0 ${skill.agentEnabled ? 'text-emerald-400' : 'text-zinc-600'}`}
          />
          <span className="min-w-0 flex-1">
            <span className="flex items-baseline gap-2">
              <span className="text-[12.5px] font-medium text-zinc-200">/{skill.name}</span>
              {!skill.agentEnabled && (
                <span className="text-[10px] text-zinc-600">not enabled for agents</span>
              )}
            </span>
            <span
              className={`block truncate text-[11px] ${
                skill.agentEnabled ? 'text-zinc-500' : 'text-zinc-700'
              }`}
            >
              {skill.description}
            </span>
          </span>
        </button>
      ))}
    </div>
  )
}
