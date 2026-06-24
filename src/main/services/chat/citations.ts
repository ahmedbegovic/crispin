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

/**
 * Fraction of the citing claim's content words that appear in the source — an
 * ASYMMETRIC containment measure, not symmetric Jaccard. The claim is a sentence
 * or two while a visited page's snippet can be ~1500 chars; Jaccard's
 * `|a|+|b|-inter` denominator is dominated by the snippet, so even a fully
 * supported claim scored ~0.03 and was wrongly flagged ungrounded.
 */
const containment = (claim: Set<string>, source: Set<string>): number => {
  if (claim.size === 0 || source.size === 0) return 0
  let inter = 0
  for (const t of claim) if (source.has(t)) inter++
  return inter / claim.size
}

/** The sentence(s) of the answer that cite [id]. */
const citingText = (answer: string, id: number): string => {
  const marker = `[${id}]`
  const sentences = answer.split(/(?<=[.!?])\s+/)
  // A citation often trails its claim PAST the terminal punctuation ("...blue.
  // [3]"), so the marker lands at the start of the next fragment. Re-attach a
  // fragment's leading citation markers to the preceding sentence, else grounding
  // would score the claim against the following (unrelated) sentence.
  const merged: string[] = []
  for (const s of sentences) {
    const lead = /^\s*((?:\[\d+\]\s*)+)/.exec(s)
    if (lead && merged.length > 0) {
      merged[merged.length - 1] += ` ${lead[1].trim()}`
      merged.push(s.slice(lead[0].length))
    } else {
      merged.push(s)
    }
  }
  return merged.filter((s) => s.includes(marker)).join(' ')
}

/** Soft "looks supported" threshold over the containment ratio; advisory only,
 *  and deliberately lenient so the signal errs toward grounded rather than
 *  dimming a source on weak token overlap. */
const GROUNDED_THRESHOLD = 0.4

export function verifyCitations(answerText: string, sources: SourceRef[]): SourceRef[] {
  const cited = new Set<number>()
  for (const m of answerText.matchAll(/\[(\d+)\]/g)) cited.add(Number(m[1]))
  return sources.map((s) => {
    if (!cited.has(s.id)) return { ...s, grounded: false }
    // Cited but no snippet to check against → trust the citation.
    if (!s.snippet) return { ...s, grounded: true }
    const overlap = containment(tokenize(citingText(answerText, s.id)), tokenize(s.snippet))
    return { ...s, grounded: overlap >= GROUNDED_THRESHOLD }
  })
}
