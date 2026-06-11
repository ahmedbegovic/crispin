import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
  type Stats
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'
import type { SkillMeta } from '@shared/types'
import { dataDir, resourcesDir } from './paths'
import { scopedLogger } from './logger'

/** Bump when the bundled packs change — marker-carrying installs get refreshed. */
const BUNDLED_PACK_VERSION = 1
const BUNDLED_MARKER = '.crispin-bundled'

/**
 * Skills are user-authored prompt packs: <dataDir>/skills/<name>/SKILL.md with
 * `---\nname:\ndescription:\n---` frontmatter. The system prompt lists only
 * name+description (progressive disclosure); the use_skill tool returns the body.
 */
export class SkillsService {
  private readonly dir = join(dataDir(), 'skills')
  /** opencode discovers skills here; enabling = symlinking ours in. */
  private readonly opencodeDir = join(homedir(), '.config', 'opencode', 'skills')
  private readonly log = scopedLogger('skills')

  init(): void {
    mkdirSync(this.dir, { recursive: true })
    this.installBundledPacks()
  }

  /**
   * Copy the bundled packs (resources/skills/*) into the user dir. The
   * `.crispin-bundled` marker is what distinguishes "ours" from user-authored:
   * marker-carrying dirs refresh when the pack version bumps; dirs WITHOUT a
   * marker (user-created or user-adopted) are never touched.
   */
  private installBundledPacks(): void {
    const source = join(resourcesDir(), 'skills')
    let packs: string[]
    try {
      packs = readdirSync(source, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
    } catch {
      return // no bundled packs in this build
    }
    for (const name of packs) {
      const target = join(this.dir, name)
      const marker = join(target, BUNDLED_MARKER)
      try {
        const firstInstall = !existsSync(target)
        if (!firstInstall) {
          if (!existsSync(marker)) continue // user-authored — hands off
          const installed = JSON.parse(readFileSync(marker, 'utf8')) as { version?: number }
          if ((installed.version ?? 0) >= BUNDLED_PACK_VERSION) continue
          rmSync(target, { recursive: true, force: true })
        }
        cpSync(join(source, name), target, { recursive: true })
        writeFileSync(marker, JSON.stringify({ version: BUNDLED_PACK_VERSION }) + '\n')
        // Enable for Agent/Code on first install only — a user who disabled a
        // pack must not find it re-enabled by an update.
        if (firstInstall) {
          try {
            this.setAgentEnabled(name, true)
          } catch (err) {
            this.log.warn(`could not enable bundled skill ${name}: ${err instanceof Error ? err.message : err}`)
          }
        }
      } catch (err) {
        this.log.warn(`bundled skill ${name} install failed: ${err instanceof Error ? err.message : err}`)
      }
    }
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
        const skillName = frontmatter.name || name
        skills.push({
          name: skillName,
          description: frontmatter.description || '',
          agentEnabled: this.isAgentEnabled(skillName)
        })
      } catch (err) {
        this.log.warn(`skipping skill ${name}: ${err instanceof Error ? err.message : err}`)
      }
    }
    return skills.sort((a, b) => a.name.localeCompare(b.name))
  }

  /** Full SKILL.md body (frontmatter stripped), or null when unknown. */
  useSkill(name: string): string | null {
    const dir = this.dirFor(name)
    if (!dir) return null
    const { body } = splitFrontmatter(readFileSync(join(dir, 'SKILL.md'), 'utf8'))
    return body.trim()
  }

  /** Symlinks the skill into (or out of) opencode's skills dir for Agent/Code tabs. */
  setAgentEnabled(name: string, enabled: boolean): void {
    // Frontmatter names feed the link path — keep them to a single segment.
    if (basename(name) !== name || name === '.' || name === '..') {
      throw new Error(`Invalid skill name: ${name}`)
    }
    const link = join(this.opencodeDir, name)
    if (!enabled) {
      // Remove only a symlink that resolves into our skills dir — never a
      // directory or link the user placed there themselves.
      if (this.isAgentEnabled(name)) unlinkSync(link)
      return
    }
    const dir = this.dirFor(name)
    if (!dir) throw new Error(`No such skill: ${name}`)
    mkdirSync(this.opencodeDir, { recursive: true })
    let stat: Stats | null = null
    try {
      stat = lstatSync(link)
    } catch {
      // nothing at the link path
    }
    if (stat) {
      if (!stat.isSymbolicLink()) throw new Error(`${link} already exists and is not a symlink`)
      // Re-point only OUR stale links — a user-managed symlink (e.g. into a
      // personal dotfiles skills repo) must never be silently destroyed,
      // especially now that installBundledPacks() auto-enables 20 packs.
      const target = resolve(dirname(link), readlinkSync(link))
      if (!target.startsWith(this.dir + sep)) {
        throw new Error(`${link} points outside Crispin's skills — not re-pointing a user-managed link`)
      }
      unlinkSync(link)
    }
    symlinkSync(dir, link, 'dir')
  }

  /** True when ~/.config/opencode/skills/<name> is a symlink into our skills dir. */
  private isAgentEnabled(name: string): boolean {
    const link = join(this.opencodeDir, name)
    try {
      if (!lstatSync(link).isSymbolicLink()) return false
      // readlink (not realpath) so stale links to deleted skills still match.
      return resolve(dirname(link), readlinkSync(link)).startsWith(this.dir + sep)
    } catch {
      return false
    }
  }

  /** Skill directory for an effective name — frontmatter name wins over directory name. */
  private dirFor(name: string): string | null {
    for (const dirName of readdirSync(this.dir)) {
      const file = join(this.dir, dirName, 'SKILL.md')
      if (!existsSync(file)) continue
      const { frontmatter } = splitFrontmatter(readFileSync(file, 'utf8'))
      if ((frontmatter.name || dirName) === name) return join(this.dir, dirName)
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
