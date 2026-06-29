import type { MessagePart } from '@shared/types'

/**
 * Pure context-budget core, extracted from the chat orchestrator so the
 * deterministic truncation math can be unit-tested without the full chat
 * machinery. The orchestrator wires in the model's context length, output
 * reserve, and web-evidence reserve; everything here is pure.
 */

/** Rough token estimate for budgeting: ~4 chars/token + a flat per-image cost. */
export function estimateMessageTokens(parts: MessagePart[]): number {
  let chars = 0
  let images = 0
  for (const p of parts) {
    if (p.type === 'text' || p.type === 'thought' || p.type === 'compaction') chars += p.text.length
    else if (p.type === 'tool_call') chars += p.name.length + p.args.length + 16
    else if (p.type === 'tool_result') chars += p.result.length + 16
    else if (p.type === 'image') images += 1
  }
  return Math.ceil(chars / 4) + images * 900
}

/** Smallest history budget we ever leave, even on a tiny context window. */
const BUDGET_FLOOR = 2048
/** Flat margin for the system prompt and assembly overhead. */
const SYSTEM_MARGIN = 4096

/**
 * Tokens available for chat history = context window minus the per-request
 * output reserve, a flat system-prompt margin, and any web-evidence reserve
 * (the pipeline appends evidence to the trailing user turn after trimming).
 * Floored so a small window still keeps something.
 */
export function computeBudget(
  contextLength: number,
  outputReserve: number,
  evidenceReserve: number
): number {
  return Math.max(BUDGET_FLOOR, contextLength - outputReserve - SYSTEM_MARGIN - evidenceReserve)
}

/**
 * Trim the oldest turns so the kept window fits `budget` — a newest-first
 * greedy keep. Always keeps the newest message (even if it alone exceeds the
 * budget); trims a leading assistant turn so the window starts on a user turn
 * (unless only one message remains — keep-newest wins).
 */
export function trimToBudget<T extends { role: string; parts: MessagePart[] }>(
  path: T[],
  budget: number
): T[] {
  let total = 0
  const kept: T[] = []
  for (let i = path.length - 1; i >= 0; i--) {
    const cost = estimateMessageTokens(path[i].parts)
    if (kept.length > 0 && total + cost > budget) break
    total += cost
    kept.unshift(path[i])
  }
  while (kept.length > 1 && kept[0].role === 'assistant') kept.shift()
  return kept
}
