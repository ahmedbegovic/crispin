import { useEffect, useMemo, useState, type KeyboardEvent } from 'react'
import type { SkillMeta } from '@shared/types'
import { call } from '@/lib/ipc'

/** `/token` while still typing the token — args after a space close the picker. */
const SLASH_TOKEN = /^\/([\w-]*)$/
/** Submit-time shape: /skill-name [args…] */
const SLASH_COMMAND = /^\/([\w-]+)(?:\s+([\s\S]+))?$/

export interface SlashSkills {
  open: boolean
  skills: SkillMeta[]
  highlight: number
  setHighlight: (index: number) => void
  /** Insert the picked skill, keeping the composer in args-typing position. */
  pick: (skill: SkillMeta) => void
  /** Run BEFORE the composer's own Enter handling; true = key consumed. */
  onKeyDown: (e: KeyboardEvent<HTMLTextAreaElement>) => boolean
  /**
   * `/skill args` → the templated prompt opencode's skill tool triggers on
   * (the /command endpoint runs config commands, not skills). Unknown slash
   * tokens pass through untouched.
   */
  transformForSubmit: (text: string) => string
}

export function useSlashSkills(text: string, setText: (text: string) => void): SlashSkills {
  const [all, setAll] = useState<SkillMeta[]>([])
  const [highlight, setHighlight] = useState(0)
  const [dismissed, setDismissed] = useState(false)

  useEffect(() => {
    void call('skills.list')
      .then((r) => setAll(r.skills))
      .catch(() => {})
  }, [])

  const match = SLASH_TOKEN.exec(text)
  const filter = match?.[1].toLowerCase() ?? null

  const skills = useMemo(() => {
    if (filter === null) return []
    return all
      .filter((s) => s.name.toLowerCase().includes(filter))
      .sort((a, b) => a.name.localeCompare(b.name))
  }, [all, filter])

  const open = !dismissed && filter !== null && skills.length > 0

  // Every text change re-arms the picker and re-clamps the highlight.
  useEffect(() => {
    setDismissed(false)
    setHighlight(0)
  }, [text])

  const pick = (skill: SkillMeta): void => {
    setText(`/${skill.name} `)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (!open) return false
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setHighlight((h) => (h + 1) % skills.length)
      return true
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      setHighlight((h) => (h - 1 + skills.length) % skills.length)
      return true
    }
    if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault()
      const skill = skills[Math.min(highlight, skills.length - 1)]
      if (skill) pick(skill)
      return true
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      setDismissed(true)
      return true
    }
    return false
  }

  const transformForSubmit = (input: string): string => {
    const command = SLASH_COMMAND.exec(input.trim())
    if (!command) return input
    const skill = all.find((s) => s.name.toLowerCase() === command[1].toLowerCase())
    if (!skill) return input
    const args = command[2]?.trim()
    return args ? `Use the "${skill.name}" skill: ${args}` : `Use the "${skill.name}" skill.`
  }

  return { open, skills, highlight, setHighlight, pick, onKeyDown, transformForSubmit }
}
