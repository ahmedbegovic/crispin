import type { SourceRef } from '@shared/types'

/**
 * Advisory citation-grounding pass over a finished synthesis answer. For every
 * source the answer cites with its [n] marker, lightly span-matches the citing
 * sentence(s) against the source's snippet to flag claims that don't appear to
 * be supported. NEVER strips or rewrites citations — it only annotates
 * SourceRef.grounded for the renderer's source cards. Sources the answer never
 * cited are marked grounded:false (the model didn't use them).
 */

const tokenize = (text: string): Set<string> =>
  new Set(text.toLowerCase().match(/[a-z0-9]{3,}/g) ?? [])

const jaccard = (a: Set<string>, b: Set<string>): number => {
  if (a.size === 0 || b.size === 0) return 0
  let inter = 0
  for (const t of a) if (b.has(t)) inter++
  return inter / (a.size + b.size - inter)
}

/** The sentence(s) of the answer that cite [id]. */
const citingText = (answer: string, id: number): string => {
  const marker = `[${id}]`
  return answer
    .split(/(?<=[.!?])\s+/)
    .filter((s) => s.includes(marker))
    .join(' ')
}

/** Lenient overlap threshold — this is a soft "looks supported" signal. */
const GROUNDED_THRESHOLD = 0.06

export function verifyCitations(answerText: string, sources: SourceRef[]): SourceRef[] {
  const cited = new Set<number>()
  for (const m of answerText.matchAll(/\[(\d+)\]/g)) cited.add(Number(m[1]))
  return sources.map((s) => {
    if (!cited.has(s.id)) return { ...s, grounded: false }
    // Cited but no snippet to check against → trust the citation.
    if (!s.snippet) return { ...s, grounded: true }
    const overlap = jaccard(tokenize(citingText(answerText, s.id)), tokenize(s.snippet))
    return { ...s, grounded: overlap >= GROUNDED_THRESHOLD }
  })
}
