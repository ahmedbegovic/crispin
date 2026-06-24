import { useEffect, useRef, useState, type ReactNode } from 'react'

/**
 * Models routinely emit node labels with unquoted parens or comparison
 * operators — `A{Is x <= y?}`, `B[mid = (lo+hi)//2]` — which Mermaid's parser
 * rejects outright. Quote the inside of `[...]` / `{...}` node labels when they
 * contain such chars and aren't already quoted. We only touch labels that
 * would otherwise fail (valid diagrams pass through unchanged) and skip
 * compound shapes (`[[..]]`, `[(..)]`, `{{..}}`) whose inner edge is a bracket.
 */
function quoteRiskyLabels(src: string): string {
  // Only flowchart/graph use `id[..]`/`id{..}` NODE syntax. On class/state/ER
  // diagrams `{...}` is a member block (and `[..]` array types etc.), not a
  // label — quoting it would corrupt a valid diagram, so bail out for any
  // non-flowchart diagram type.
  const kind = src.trimStart().split(/\s/, 1)[0]
  if (kind !== 'flowchart' && kind !== 'graph') return src
  const quote = (id: string, open: string, inner: string, close: string, breakers: RegExp): string => {
    const t = inner.trim()
    if (!t || /^".*"$/.test(t)) return `${id}${open}${inner}${close}` // already quoted
    // Compound shapes ([[..]], [(..)], {{..}}) capture an inner starting with a
    // bracket — skip those; a label merely ending in ")" (e.g. "mid (Found)")
    // is an ordinary label that DOES need quoting.
    if (/^[[({]/.test(t)) return `${id}${open}${inner}${close}`
    if (!breakers.test(t)) return `${id}${open}${inner}${close}` // nothing that breaks the parse
    return `${id}${open}"${t.replace(/"/g, "'")}"${close}`
  }
  return src
    .replace(/([A-Za-z0-9_]+)(\[)([^\]]*)(\])/g, (_m, id, o, inner, c) =>
      quote(id, o, inner, c, /[()<>]/)
    )
    .replace(/([A-Za-z0-9_]+)(\{)([^}]*)(\})/g, (_m, id, o, inner, c) =>
      quote(id, o, inner, c, /[()<>[\]]/)
    )
}

/**
 * Lazily renders a ```mermaid fence to SVG. Mermaid (~heavy, with d3/dagre) is
 * dynamically imported so it never enters the chat bundle unless a diagram
 * actually appears. Rendering is debounced (so a half-streamed fence doesn't
 * thrash) and any parse error falls back to the raw code block.
 */
export default function Mermaid({
  code,
  fallback
}: {
  code: string
  fallback: ReactNode
}): React.JSX.Element {
  const [svg, setSvg] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  const idRef = useRef(`mmd-${Math.random().toString(36).slice(2)}`)

  useEffect(() => {
    let cancelled = false
    setFailed(false)
    // Drop the previous diagram so a code change shows the placeholder, not a
    // stale (now-unrelated) diagram, while the new one (re)renders.
    setSvg(null)
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const mermaid = (await import('mermaid')).default
          mermaid.initialize({ startOnLoad: false, theme: 'dark', securityLevel: 'strict' })
          const out = await mermaid.render(idRef.current, quoteRiskyLabels(code.trim()))
          if (!cancelled) setSvg(out.svg)
        } catch {
          if (!cancelled) setFailed(true)
        }
      })()
    }, 250)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [code])

  if (failed) return <>{fallback}</>
  if (svg === null)
    return (
      <div className="my-2 rounded-lg border border-zinc-800 bg-zinc-900/40 p-3 text-[11px] text-zinc-600">
        Rendering diagram…
      </div>
    )
  return (
    <div
      className="my-2 flex justify-center overflow-x-auto rounded-lg border border-zinc-800 bg-white/[0.03] p-3 [&_svg]:max-w-full"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  )
}
