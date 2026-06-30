import { memo } from 'react'
import ReactMarkdown, { defaultUrlTransform, type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeHighlight from 'rehype-highlight'
import rehypeKatex from 'rehype-katex'
import type { SourceRef } from '@shared/types'
import CodeBlock from './CodeBlock'
import Citation, { SourcesContext } from './Citation'

// react-markdown's default urlTransform strips any scheme outside its http(s)
// allowlist BEFORE component renderers run — without this passthrough the img
// renderer below would never see an crispin-attachment: src.
const urlTransform = (url: string): string =>
  /^crispin-attachment:/i.test(url) ? url : defaultUrlTransform(url)

const EMPTY_SOURCES: Record<number, SourceRef> = {}

interface HNode {
  type: string
  tagName?: string
  value?: string
  properties?: { className?: unknown }
  children?: HNode[]
}

/** Split a text value on [n] markers, wrapping each in a <cite> element. */
function splitCitations(value: string): HNode[] | null {
  const re = /\[(\d+)\]/g
  if (!re.test(value)) return null
  re.lastIndex = 0
  const out: HNode[] = []
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(value)) !== null) {
    if (m.index > last) out.push({ type: 'text', value: value.slice(last, m.index) })
    out.push({
      type: 'element',
      tagName: 'cite',
      properties: {},
      children: [{ type: 'text', value: m[0] }]
    })
    last = m.index + m[0].length
  }
  if (last < value.length) out.push({ type: 'text', value: value.slice(last) })
  return out
}

function walkCitations(node: HNode): void {
  const children = node.children
  if (!children) return
  for (let i = 0; i < children.length; i++) {
    const child = children[i]
    if (child.type === 'element') {
      const cls = child.properties?.className
      const inKatex =
        Array.isArray(cls) && cls.some((c) => typeof c === 'string' && c.startsWith('katex'))
      // Never rewrite [n] inside code / inline code / rendered math.
      if (child.tagName === 'code' || child.tagName === 'pre' || inKatex) continue
      walkCitations(child)
    } else if (child.type === 'text' && child.value) {
      const split = splitCitations(child.value)
      if (split) {
        children.splice(i, 1, ...split)
        i += split.length - 1
      }
    }
  }
}

/** rehype plugin: turn [n] markers in prose into <cite> citation elements. */
function rehypeCitations() {
  return (tree: unknown): void => walkCitations(tree as HNode)
}

// Tailwind preflight strips element margins, so markdown elements are styled
// here instead of a global stylesheet (no typography plugin installed).
const components: Components = {
  a: ({ node: _, ...props }) => (
    // target=_blank routes through main's setWindowOpenHandler -> shell.openExternal.
    <a {...props} target="_blank" rel="noreferrer" className="text-sky-400 hover:underline" />
  ),
  // Prose leading follows the reading-density preference (--chat-lh); set it here
  // because these per-element line-heights would otherwise override the wrapper's.
  p: ({ node: _, ...props }) => (
    <p
      className="[margin-top:var(--chat-my-para,0.5rem)] [margin-bottom:var(--chat-my-para,0.5rem)] leading-[var(--chat-lh,1.7)] first:mt-0 last:mb-0"
      {...props}
    />
  ),
  ul: ({ node: _, ...props }) => (
    <ul
      className="[margin-top:var(--chat-my-para,0.5rem)] [margin-bottom:var(--chat-my-para,0.5rem)] list-disc space-y-1 pl-5"
      {...props}
    />
  ),
  ol: ({ node: _, ...props }) => (
    <ol
      className="[margin-top:var(--chat-my-para,0.5rem)] [margin-bottom:var(--chat-my-para,0.5rem)] list-decimal space-y-1 pl-5"
      {...props}
    />
  ),
  li: ({ node: _, ...props }) => <li className="leading-[var(--chat-lh,1.7)]" {...props} />,
  h1: ({ node: _, ...props }) => (
    <h1
      className="mb-2 mt-6 text-[17px] font-semibold tracking-[-0.01em] text-zinc-100 first:mt-0"
      {...props}
    />
  ),
  // The hairline underbar turns long answers into clearly outlined sections.
  h2: ({ node: _, ...props }) => (
    <h2
      className="mb-2 mt-5 border-b border-zinc-800/60 pb-1.5 text-[15px] font-semibold tracking-[-0.01em] text-zinc-100 first:mt-0"
      {...props}
    />
  ),
  h3: ({ node: _, ...props }) => (
    <h3 className="mb-1.5 mt-4 text-[14px] font-semibold text-zinc-200 first:mt-0" {...props} />
  ),
  h4: ({ node: _, ...props }) => (
    <h4 className="mb-1 mt-3 text-[13.5px] font-semibold text-zinc-200 first:mt-0" {...props} />
  ),
  pre: ({ node: _, children }) => <CodeBlock>{children}</CodeBlock>,
  code: ({ node: _, className, ...props }) =>
    className ? (
      <code className={className} {...props} />
    ) : (
      <code
        // overflow-wrap:anywhere — long unbroken file paths/URLs in inline
        // code must wrap, not push the panel into horizontal scrolling.
        className="rounded bg-zinc-800 px-1 py-0.5 text-[12px] text-zinc-200 [overflow-wrap:anywhere]"
        {...props}
      />
    ),
  cite: ({ node: _, children }) => <Citation>{children}</Citation>,
  blockquote: ({ node: _, ...props }) => (
    // Neutral rule: a quote has no "active" state, so it stays off the sky/emerald/amber spine.
    <blockquote className="my-2 border-l-2 border-zinc-700 pl-3 text-zinc-400" {...props} />
  ),
  // Calm zebra ledger: a single rounded frame, horizontal rules only, an
  // uppercase header row, and a faint stripe on even rows for scan-ability.
  table: ({ node: _, ...props }) => (
    <div className="my-2 overflow-x-auto rounded-lg border border-zinc-800">
      <table className="w-full border-collapse text-[12.5px]" {...props} />
    </div>
  ),
  tr: ({ node: _, ...props }) => <tr className="even:bg-white/[0.02]" {...props} />,
  th: ({ node: _, ...props }) => (
    <th
      className="border-b border-zinc-800 bg-zinc-900/80 px-2 py-1 text-left text-[11px] font-medium uppercase tracking-[0.05em] text-zinc-400"
      {...props}
    />
  ),
  td: ({ node: _, ...props }) => (
    <td className="border-b border-zinc-800 px-2 py-1 text-zinc-300" {...props} />
  ),
  hr: ({ node: _, ...props }) => <hr className="my-3 border-zinc-800" {...props} />,
  img: ({ node: _, src, alt, ...props }) => {
    const url = typeof src === 'string' ? src : ''
    // https remote images and our own attachment protocol only; anything else
    // (file:, data:, http:) renders as a labeled placeholder.
    if (!/^(https:|crispin-attachment:)/i.test(url)) {
      return <span className="text-zinc-500">[image: {alt || 'unsupported source'}]</span>
    }
    return (
      <img
        {...props}
        src={url}
        alt={alt ?? ''}
        loading="lazy"
        referrerPolicy="no-referrer"
        onError={(e) => {
          e.currentTarget.style.display = 'none'
        }}
        className="my-2 max-h-80 max-w-full rounded-lg border border-zinc-800"
      />
    )
  }
}

interface Props {
  text: string
  /** Per-message [n] → source map for inline citations (stable ref per message). */
  sources?: Record<number, SourceRef>
}

/**
 * Memoized per part so a streaming delta re-renders only the part it touches.
 * Incomplete markdown (open fences, half-written links) parses to a partial
 * tree each render — no special casing needed. `sources` is reference-stable
 * (empty until the sources part lands), so the memo behaves as before.
 */
const MarkdownPart = memo(function MarkdownPart({ text, sources }: Props) {
  return (
    <div className="select-text break-words text-[length:var(--chat-fs,13.5px)] leading-[var(--chat-lh,1.7)] text-zinc-200">
      <SourcesContext.Provider value={sources ?? EMPTY_SOURCES}>
        <ReactMarkdown
          // singleDollarTextMath:false — a single `$` is currency far more often
          // than inline math in chat ("$1,099 … $1,199" was rendering as italic
          // LaTeX). Display math via `$$…$$` is unaffected.
          remarkPlugins={[remarkGfm, [remarkMath, { singleDollarTextMath: false }]]}
          // throwOnError:false — a half-written $$…$$ mid-stream must render as
          // readable raw text, never crash the whole message.
          rehypePlugins={[
            rehypeHighlight,
            [rehypeKatex, { throwOnError: false }],
            rehypeCitations
          ]}
          components={components}
          urlTransform={urlTransform}
        >
          {text}
        </ReactMarkdown>
      </SourcesContext.Provider>
    </div>
  )
})

export default MarkdownPart
