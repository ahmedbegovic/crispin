import type { SkillMeta } from '@shared/types'

export interface SystemPromptOptions {
  /** conversations.system_prompt — replaces the base persona when set. */
  customPrompt: string | null
  skills: SkillMeta[]
  webEnabled: boolean
  ragEnabled: boolean
}

const BASE_PERSONA =
  'You are Orion, a capable assistant running fully locally on the user’s Mac. ' +
  'Be direct and concise; use Markdown when it helps. ' +
  'You only know what is in this conversation and your training data — use the available tools for anything current or document-specific.'

export function buildSystemPrompt(opts: SystemPromptOptions): string {
  const sections: string[] = [opts.customPrompt?.trim() || BASE_PERSONA]

  sections.push(
    `Today is ${new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}.`
  )

  if (opts.skills.length > 0) {
    const list = opts.skills.map((s) => `- ${s.name}: ${s.description}`).join('\n')
    sections.push(
      `Skills available via the use_skill tool (call it to read the full instructions before relying on one):\n${list}`
    )
  }

  const citationTools = [
    ...(opts.webEnabled ? ['web_search and web_visit'] : []),
    ...(opts.ragEnabled ? ['rag_search'] : [])
  ]
  if (citationTools.length > 0) {
    sections.push(
      `Tool results from ${citationTools.join(' and ')} are numbered [n]. ` +
        'When your answer uses such a result, cite it inline with its [n] marker. ' +
        'Numbering restarts every assistant turn: only cite numbers from tool results ' +
        'in your current response, never [n] markers from earlier turns.'
    )
  }

  return sections.join('\n\n')
}

/** Messages for the fire-and-forget low-tier title generation. */
export function titleMessages(
  userText: string,
  assistantText: string
): Array<{ role: 'user'; content: string }> {
  return [
    {
      role: 'user',
      content:
        'Write a title for the conversation below: at most 8 words, no quotes, no trailing punctuation. Reply with ONLY the title.\n\n' +
        `User: ${userText.slice(0, 1000)}\n\nAssistant: ${assistantText.slice(0, 1000)}`
    }
  ]
}

/** Post-process a model-generated title into something usable. */
export function cleanTitle(raw: string): string {
  const title = raw
    .replaceAll('\n', ' ')
    .replace(/["'`*#]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/[.!,;:]+$/, '')
    .trim()
  return title.split(' ').slice(0, 8).join(' ').slice(0, 80)
}
