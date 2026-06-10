import { handle } from '../ipc/router'
import type { SkillsService } from '../services/skills'

/** Registers the skills.* IPC methods. */
export function registerSkillsFeature(skills: SkillsService): void {
  handle('skills.list', () => ({ skills: skills.list() }))
}
