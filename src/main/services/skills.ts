import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SkillMeta } from '@shared/types'
import { dataDir } from './paths'
import { scopedLogger } from './logger'

/**
 * Skills are user-authored prompt packs: <dataDir>/skills/<name>/SKILL.md with
 * `---\nname:\ndescription:\n---` frontmatter. The system prompt lists only
 * name+description (progressive disclosure); the use_skill tool returns the body.
 */
export class SkillsService {
  private readonly dir = join(dataDir(), 'skills')
  private readonly log = scopedLogger('skills')

  init(): void {
    mkdirSync(this.dir, { recursive: true })
  }

  list(): SkillMeta[] {
    let entries: string[]
    try {
      entries = readdirSync(this.dir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
    } catch {
      return []
    }
    const skills: SkillMeta[] = []
    for (const name of entries) {
      const file = join(this.dir, name, 'SKILL.md')
      if (!existsSync(file)) continue
      try {
        const { frontmatter } = splitFrontmatter(readFileSync(file, 'utf8'))
        skills.push({
          name: frontmatter.name || name,
          description: frontmatter.description || ''
        })
      } catch (err) {
        this.log.warn(`skipping skill ${name}: ${err instanceof Error ? err.message : err}`)
      }
    }
    return skills.sort((a, b) => a.name.localeCompare(b.name))
  }

  /** Full SKILL.md body (frontmatter stripped), or null when unknown. */
  useSkill(name: string): string | null {
    // Frontmatter name wins over directory name, so resolve via list().
    const meta = this.list().find((s) => s.name === name)
    if (!meta) return null
    for (const dirName of readdirSync(this.dir)) {
      const file = join(this.dir, dirName, 'SKILL.md')
      if (!existsSync(file)) continue
      const { frontmatter, body } = splitFrontmatter(readFileSync(file, 'utf8'))
      if ((frontmatter.name || dirName) === name) return body.trim()
    }
    return null
  }
}

function splitFrontmatter(content: string): {
  frontmatter: Record<string, string>
  body: string
} {
  // A UTF-8 BOM (Windows-authored SKILL.md) would defeat the ^--- anchor.
  content = content.replace(/^\uFEFF/, '')
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(content)
  if (!match) return { frontmatter: {}, body: content }
  const frontmatter: Record<string, string> = {}
  for (const line of match[1].split(/\r?\n/)) {
    const colon = line.indexOf(':')
    if (colon < 0) continue
    const key = line.slice(0, colon).trim()
    const value = line
      .slice(colon + 1)
      .trim()
      .replace(/^["']|["']$/g, '')
    if (key) frontmatter[key] = value
  }
  return { frontmatter, body: content.slice(match[0].length) }
}
