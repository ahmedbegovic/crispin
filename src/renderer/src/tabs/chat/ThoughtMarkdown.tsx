import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'

const components: Components = {
  a: ({ node: _, ...props }) => (
    <a {...props} target="_blank" rel="noreferrer" className="text-zinc-400 underline underline-offset-2" />
  ),
  p: ({ node: _, ...props }) => (
    <p className="my-2 leading-relaxed first:mt-0 last:mb-0" {...props} />
  ),
  ul: ({ node: _, ...props }) => (
    <ul className="my-2 list-disc space-y-1.5 pl-4 first:mt-0 last:mb-0" {...props} />
  ),
  ol: ({ node: _, ...props }) => (
    <ol className="my-2 list-decimal space-y-1.5 pl-4 first:mt-0 last:mb-0" {...props} />
  ),
  li: ({ node: _, ...props }) => <li className="pl-1 leading-relaxed [&>ul]:mt-1.5 [&>ol]:mt-1.5" {...props} />,
  strong: ({ node: _, ...props }) => <strong className="font-semibold text-zinc-400" {...props} />,
  h1: ({ node: _, ...props }) => (
    <h1 className="mb-1.5 mt-3 text-[12px] font-semibold leading-snug text-zinc-400 first:mt-0 last:mb-0" {...props} />
  ),
  h2: ({ node: _, ...props }) => (
    <h2 className="mb-1.5 mt-3 text-[12px] font-semibold leading-snug text-zinc-400 first:mt-0 last:mb-0" {...props} />
  ),
  h3: ({ node: _, ...props }) => (
    <h3 className="mb-1.5 mt-3 text-[12px] font-semibold leading-snug text-zinc-400 first:mt-0 last:mb-0" {...props} />
  ),
  h4: ({ node: _, ...props }) => (
    <h4 className="mb-1.5 mt-3 text-[12px] font-semibold leading-snug text-zinc-400 first:mt-0 last:mb-0" {...props} />
  ),
  h5: ({ node: _, ...props }) => (
    <h5 className="mb-1.5 mt-3 text-[12px] font-semibold leading-snug text-zinc-400 first:mt-0 last:mb-0" {...props} />
  ),
  h6: ({ node: _, ...props }) => (
    <h6 className="mb-1.5 mt-3 text-[12px] font-semibold leading-snug text-zinc-400 first:mt-0 last:mb-0" {...props} />
  ),
  code: ({ node: _, className, ...props }) =>
    className ? (
      <code className="text-[11px] text-zinc-400 [overflow-wrap:anywhere]" {...props} />
    ) : (
      <code
        className="rounded bg-zinc-800/70 px-1 py-px text-[11px] text-zinc-400 [overflow-wrap:anywhere]"
        {...props}
      />
    ),
  pre: ({ node: _, ...props }) => (
    <pre
      className="my-2 max-h-40 overflow-x-auto rounded border border-zinc-800/80 bg-zinc-950/40 p-2 text-[11px] leading-relaxed text-zinc-400"
      {...props}
    />
  ),
  blockquote: ({ node: _, ...props }) => (
    <blockquote className="my-2 border-l-2 border-zinc-800 pl-2 text-zinc-500" {...props} />
  ),
  table: ({ node: _, ...props }) => (
    <div className="my-2 overflow-x-auto rounded border border-zinc-800/80">
      <table className="w-full border-collapse text-[11px]" {...props} />
    </div>
  ),
  th: ({ node: _, ...props }) => (
    <th className="border-b border-zinc-800 px-1.5 py-1 text-left font-semibold text-zinc-400" {...props} />
  ),
  td: ({ node: _, ...props }) => (
    <td className="border-b border-zinc-800 px-1.5 py-1 text-zinc-500" {...props} />
  ),
  hr: ({ node: _, ...props }) => <hr className="my-3 border-zinc-800" {...props} />
}

interface Props {
  text: string
}

export default function ThoughtMarkdown({ text }: Props) {
  return (
    <div className="select-text break-words text-[12px] leading-relaxed text-zinc-500">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  )
}
