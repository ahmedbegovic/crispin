import type { RefObject } from 'react'
import { useDismissable } from '@/lib/useDismissable'

const SHORTCUTS = [
  { action: 'Command palette', key: '⌘K' },
  { action: 'New chat', key: '⌘N' },
  { action: 'Focus composer', key: '⌘L' },
  { action: 'Find in thread', key: '⌘F' },
  { action: 'Previous chat', key: '⌘↑' },
  { action: 'Next chat', key: '⌘↓' }
]

interface Props {
  open: boolean
  onClose: () => void
  outsideRef: RefObject<HTMLDivElement | null>
}

export default function ShortcutsHints({ open, onClose, outsideRef }: Props) {
  useDismissable(open, onClose, { outsideRef })

  if (!open) return null

  return (
    <div
      role="dialog"
      aria-label="Keyboard shortcuts"
      className="pop-in absolute right-0 top-full z-20 mt-1 w-60 origin-top-right rounded-lg border border-zinc-700 bg-zinc-900 p-2 shadow-xl"
    >
      <div className="px-1 pb-1.5 text-[10px] font-medium uppercase tracking-[0.06em] text-zinc-500">
        Shortcuts
      </div>
      <div className="space-y-0.5 text-[12px] text-zinc-300">
        {SHORTCUTS.map((shortcut) => (
          <div
            key={shortcut.action}
            className="flex items-center justify-between gap-4 rounded-md px-1.5 py-1 text-zinc-400"
          >
            <span>{shortcut.action}</span>
            <kbd className="rounded bg-zinc-800 px-1.5 py-0.5 font-mono text-[10px] text-zinc-300">
              {shortcut.key}
            </kbd>
          </div>
        ))}
      </div>
    </div>
  )
}
