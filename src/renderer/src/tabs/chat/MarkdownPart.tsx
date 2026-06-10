import { memo } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'

// Tailwind preflight strips element margins, so markdown elements are styled
// here instead of a global stylesheet (no typography plugin installed).
const components: Components = {
  a: ({ node: _, ...props }) => (
    // target=_blank routes through main's setWindowOpenHandler -> shell.openExternal.
    <a {...props} target="_blank" rel="noreferrer" className="text-sky-400 hover:underline" />
  ),
  p: ({ node: _, ...props }) => (
    <p className="my-2 leading-relaxed first:mt-0 last:mb-0" {...props} />
  ),
  ul: ({ node: _, ...props }) => <ul className="my-2 list-disc space-y-1 pl-5" {...props} />,
  ol: ({ node: _, ...props }) => <ol className="my-2 list-decimal space-y-1 pl-5" {...props} />,
  li: ({ node: _, ...props }) => <li className="leading-relaxed" {...props} />,
  h1: ({ node: _, ...props }) => (
    <h1 className="mb-2 mt-4 text-[16px] font-semibold text-zinc-100 first:mt-0" {...props} />
  ),
  h2: ({ node: _, ...props }) => (
    <h2 className="mb-2 mt-4 text-[15px] font-semibold text-zinc-100 first:mt-0" {...props} />
  ),
  h3: ({ node: _, ...props }) => (
    <h3 className="mb-1.5 mt-3 text-[14px] font-semibold text-zinc-100 first:mt-0" {...props} />
  ),
  h4: ({ node: _, ...props }) => (
    <h4 className="mb-1 mt-3 text-[13.5px] font-semibold text-zinc-200 first:mt-0" {...props} />
  ),
  pre: ({ node: _, ...props }) => (
    <pre
      className="my-2 overflow-x-auto rounded-lg border border-zinc-800 text-[12px] leading-relaxed [&>code]:block [&>code]:p-3"
      {...props}
    />
  ),
  code: ({ node: _, className, ...props }) =>
    className ? (
      <code className={className} {...props} />
    ) : (
      <code
        className="rounded bg-zinc-800 px-1 py-0.5 text-[12px] text-zinc-200"
        {...props}
      />
    ),
  blockquote: ({ node: _, ...props }) => (
    <blockquote className="my-2 border-l-2 border-zinc-700 pl-3 text-zinc-400" {...props} />
  ),
  table: ({ node: _, ...props }) => (
    <div className="my-2 overflow-x-auto">
      <table className="w-full border-collapse text-[12.5px]" {...props} />
    </div>
  ),
  th: ({ node: _, ...props }) => (
    <th
      className="border border-zinc-800 bg-zinc-900 px-2 py-1 text-left font-medium text-zinc-200"
      {...props}
    />
  ),
  td: ({ node: _, ...props }) => <td className="border border-zinc-800 px-2 py-1" {...props} />,
  hr: ({ node: _, ...props }) => <hr className="my-3 border-zinc-800" {...props} />
}

interface Props {
  text: string
}

/**
 * Memoized per part so a streaming delta re-renders only the part it touches.
 * Incomplete markdown (open fences, half-written links) parses to a partial
 * tree each render — no special casing needed.
 */
const MarkdownPart = memo(function MarkdownPart({ text }: Props) {
  return (
    <div className="select-text text-[13.5px] leading-relaxed text-zinc-200">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        components={components}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
})

export default MarkdownPart
