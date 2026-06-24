import { useRef } from 'react'
import { useDismissable } from '@/lib/useDismissable'

interface Props {
  open: boolean
  title: string
  body: string
  confirmLabel?: string
  cancelLabel?: string
  /** Red confirm button for destructive actions. */
  danger?: boolean
  onConfirm: () => void
  onCancel: () => void
}

/** Minimal app-wide confirm modal. Backdrop click / Escape cancels. */
export default function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  danger = false,
  onConfirm,
  onCancel
}: Props) {
  const cancelRef = useRef<HTMLButtonElement>(null)
  const confirmRef = useRef<HTMLButtonElement>(null)
  // Focus the safe default on open (Cancel for destructive actions, Confirm
  // otherwise) — so Enter activates the focused button without a separate
  // handler. Escape cancels; focus is restored to the opener on close.
  useDismissable(open, onCancel, { focusRef: danger ? cancelRef : confirmRef })
  if (!open) return null
  return (
    <div
      className="no-drag fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={onCancel}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="w-full max-w-sm rounded-lg border border-zinc-800 bg-zinc-900 p-4 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-[13px] font-semibold text-zinc-100">{title}</h3>
        <p className="mt-1.5 text-[12px] leading-relaxed text-zinc-400">{body}</p>
        <div className="mt-4 flex justify-end gap-2">
          <button
            ref={cancelRef}
            onClick={onCancel}
            className="rounded-md px-2.5 py-1 text-[12px] text-zinc-400 outline-none hover:bg-zinc-800 hover:text-zinc-200 focus-visible:ring-2 focus-visible:ring-zinc-500"
          >
            {cancelLabel}
          </button>
          <button
            ref={confirmRef}
            onClick={onConfirm}
            className={`rounded-md px-2.5 py-1 text-[12px] font-medium text-white outline-none focus-visible:ring-2 ${
              danger
                ? 'bg-red-600 hover:bg-red-500 focus-visible:ring-red-400'
                : 'bg-emerald-600 hover:bg-emerald-500 focus-visible:ring-emerald-400'
            }`}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
