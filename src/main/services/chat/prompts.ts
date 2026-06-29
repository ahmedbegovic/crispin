import type { SkillMeta } from '@shared/types'
import { untrustedWebInstruction } from './untrusted-web'

export interface SystemPromptOptions {
  /** conversations.system_prompt — replaces the base persona when set. */
  customPrompt: string | null
  skills: SkillMeta[]
  webEnabled: boolean
  ragEnabled: boolean
  /** Settings → Profile; empty strings fall back to defaults. */
  userName: string
  assistantName: string
  /** Settings → Instructions (global + this module's), in priority order. */
  instructions: string[]
}

const basePersona = (assistantName: string): string =>
  `You are ${assistantName}, a capable assistant running fully locally on the user’s Mac. ` +
  'Be direct and concise; use Markdown when it helps. ' +
  'You only know what is in this conversation and your training data — use the available tools for anything current or document-specific.'

/** Keep skill listings terse — full instructions come from use_skill. */
const SKILL_DESCRIPTION_LIMIT = 120
const clipDescription = (text: string): string => {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > SKILL_DESCRIPTION_LIMIT
    ? `${flat.slice(0, SKILL_DESCRIPTION_LIMIT - 1)}…`
    : flat
}

export function buildSystemPrompt(opts: SystemPromptOptions): string {
  const assistantName = opts.assistantName.trim() || 'Crispin'
  const sections: string[] = [opts.customPrompt?.trim() || basePersona(assistantName)]

  const userName = opts.userName.trim()
  if (userName) sections.push(`The user's name is ${userName}.`)

  if (opts.skills.length > 0) {
    const list = opts.skills.map((s) => `- ${s.name}: ${clipDescription(s.description)}`).join('\n')
    sections.push(
      `Skills available via the use_skill tool (call it to read the full instructions before relying on one):\n${list}`
    )
  }

  if (opts.webEnabled) {
    sections.push(
      'When the user asks for photos or pictures, call image_search and embed the best ' +
        'results directly in your reply as Markdown images (![title](image_url)) — they ' +
        'render inline. Never claim you cannot provide images.'
    )
  }
  // Always present, even when web is off: replayed history can still contain
  // fenced web results from an earlier turn, so the guard must not disappear
  // when web is toggled off (it also keeps the prefix stable across toggles).
  sections.push(untrustedWebInstruction())

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

  for (const instruction of opts.instructions) {
    const text = instruction.trim()
    if (text) sections.push(text)
  }

  // Volatile-last: the daily-changing date is appended after the stable
  // persona/skills/instructions so it never invalidates the engine's prefix
  // cache for everything above it (cache-stable prompt ordering).
  sections.push(
    `Today is ${new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}.`
  )

  return sections.join('\n\n')
}

/**
 * Instant title for a brand-new conversation: the first question, stripped of
 * leading markdown, reduced to its first sentence when substantial, flattened
 * and truncated. MUST stay pure/deterministic — the refinement's never-overwrite
 * guard compares the live title against this exact output. The LLM refinement
 * only ever replaces this string.
 */
export function instantTitle(text: string): string {
  const flat = text
    // Drop a leading markdown marker (heading, quote, list bullet, code fence).
    .replace(/^\s*(?:#{1,6}|>|[-*+]|\d+[.)]|`{1,3})\s*/, '')
    .replaceAll('\n', ' ')
    // Strip inline markdown punctuation so the title reads as prose.
    .replace(/[*_`#>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  // Prefer the first sentence, but only if it's substantial (avoid "Hi.").
  const sentence = /^.*?[.!?](?=\s|$)/.exec(flat)?.[0]?.trim()
  const base = sentence && sentence.length >= 16 ? sentence : flat
  return base.length > 60 ? `${base.slice(0, 59).trimEnd()}…` : base
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

/** Messages for an on-demand conversation summary (summarize + compact reuse it). */
export function summaryMessages(transcript: string): Array<{ role: 'user'; content: string }> {
  return [
    {
      role: 'user',
      content:
        'Summarize the conversation below so someone can quickly understand it. Capture the ' +
        'main questions, answers, decisions, and any important facts, names, numbers, or ' +
        'context. Use short bullet points or brief paragraphs. Be faithful — do not invent ' +
        'anything or add commentary. Reply with ONLY the summary.\n\n---\n' +
        transcript +
        '\n---'
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
