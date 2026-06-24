import { isValidElement, useState, type ReactNode } from 'react'
import { Check, Copy } from 'lucide-react'
import { toastError } from '@/stores/toasts'
import Mermaid from './Mermaid'

/** Language label from the highlighted <code class="language-xxx"> child. */
function langOf(children: ReactNode): string {
  if (isValidElement(children)) {
    const cls = (children.props as { className?: string }).className ?? ''
    const m = /language-([\w-]+)/.exec(cls)
    if (m) return m[1]
  }
  return 'text'
}

/** Flatten the (possibly highlight-tokenized) children back to the raw source. */
function nodeText(node: ReactNode): string {
  if (typeof node === 'string') return node
  if (typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(nodeText).join('')
  if (isValidElement(node)) return nodeText((node.props as { children?: ReactNode }).children)
  return ''
}

/**
 * Fenced code block with a hover header (language badge + copy). A ```mermaid
 * fence renders to a diagram instead, falling back to this block on error.
 */
export default function CodeBlock({ children }: { children?: ReactNode }): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  const lang = langOf(children)
  const raw = nodeText(children)

  const copy = (): void => {
    // Only flash "Copied" if the write actually resolved (denied permission /
    // unfocused document rejects), and surface the failure instead of lying.
    navigator.clipboard
      .writeText(raw)
      .then(() => {
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
      })
      .catch(toastError)
  }

  const block = (
    <div className="group/code relative my-2 overflow-hidden rounded-lg border border-zinc-800">
      <div className="flex items-center justify-between border-b border-zinc-800 bg-zinc-900/60 px-2.5 py-1 text-[10.5px]">
        <span className="font-mono text-zinc-500">{lang}</span>
        <button
          onClick={copy}
          aria-label="Copy code"
          className="flex items-center gap-1 rounded px-1 py-0.5 text-zinc-500 opacity-0 transition-opacity hover:text-zinc-200 focus-visible:opacity-100 group-hover/code:opacity-100"
        >
          {copied ? <Check size={12} className="text-emerald-400" /> : <Copy size={12} />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre className="overflow-x-auto text-[12px] leading-relaxed [&>code]:block [&>code]:p-3">
        {children}
      </pre>
    </div>
  )

  if (lang === 'mermaid') return <Mermaid code={raw} fallback={block} />
  return block
}
