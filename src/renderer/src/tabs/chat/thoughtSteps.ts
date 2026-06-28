export interface ThoughtStep {
  /** A short title pulled from a markdown / bold / numbered lead-in, else null. */
  heading: string | null
  /** The step's prose (may be empty when the block was only a heading). */
  body: string
}

/** Strip inline markdown punctuation from an extracted heading. */
function cleanHeading(s: string): string {
  return s.replace(/[*_`#]/g, '').replace(/\s+/g, ' ').trim()
}

const join = (a: string, b: string): string => [a, b].filter(Boolean).join('\n').trim()

function parseBlock(block: string): ThoughtStep {
  const nl = block.indexOf('\n')
  const firstLine = (nl === -1 ? block : block.slice(0, nl)).trim()
  const rest = nl === -1 ? '' : block.slice(nl + 1).trim()

  // "## Heading"
  let m = /^#{1,6}\s+(.+)$/.exec(firstLine)
  if (m) return { heading: cleanHeading(m[1]), body: rest }

  // "**Heading**" or "**Heading:** body" — a CLOSED bold lead-in only, so a
  // half-streamed "**Heading" stays body until its closer arrives.
  m = /^\*\*(.+?)\*\*:?\s*(.*)$/.exec(firstLine)
  if (m) return { heading: cleanHeading(m[1]), body: join(m[2], rest) }

  // "1. Heading" / "2) Heading" / "- Heading" — only when there is body below,
  // so a plain one-line bullet stays prose.
  m = /^(?:\d+[.)]|[-*+])\s+(.+)$/.exec(firstLine)
  if (m && rest) return { heading: cleanHeading(m[1]), body: rest }

  // "Short Title: body" — a capitalized lead-in under ~40 chars.
  m = /^([A-Z][^.:!?\n]{2,40}):\s+(\S.*)$/.exec(firstLine)
  if (m) return { heading: cleanHeading(m[1]), body: join(m[2], rest) }

  return { heading: null, body: block.trim() }
}

/**
 * Split a free-form reasoning string into ordered steps, entirely render-side.
 * Paragraph breaks are the baseline; a leading markdown header, closed bold
 * lead-in, numbered/bullet item, or "Title:" prefix becomes a step heading.
 * Tolerant of partial input mid-stream and never throws — worst case is a single
 * heading-less step (no worse than the old flat blob).
 */
export function segmentThought(text: string): ThoughtStep[] {
  const trimmed = text.trim()
  if (!trimmed) return []
  return trimmed
    .split(/\n[ \t]*\n+/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map(parseBlock)
}
