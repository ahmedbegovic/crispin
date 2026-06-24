import { useRef, type ReactNode } from 'react'
import { X } from 'lucide-react'
import { useDismissable } from '@/lib/useDismissable'

interface Props {
  open: boolean
  title: string
  wide?: boolean
  onClose: () => void
  children: ReactNode
}

/** Dialog shell for the MCP and Library panels. z-40 keeps ConfirmDialog (z-50) on top. */
export default function Modal({ open, title, wide = false, onClose, children }: Props) {
  const panelRef = useRef<HTMLDivElement>(null)
  // Escape closes, focus moves into the panel on open, and is restored on close.
  useDismissable(open, onClose, { focusRef: panelRef })
  if (!open) return null
  return (
    <div
      className="no-drag fixed inset-0 z-40 flex items-center justify-center bg-black/60"
      onClick={onClose}
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`flex max-h-[80vh] w-full ${wide ? 'max-w-2xl' : 'max-w-lg'} flex-col rounded-lg border border-zinc-800 bg-zinc-900 shadow-2xl outline-none`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-3">
          <h3 className="text-[13px] font-semibold text-zinc-100">{title}</h3>
          <button
            onClick={onClose}
            className="rounded p-0.5 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
          >
            <X size={14} />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-4">{children}</div>
      </div>
    </div>
  )
}
