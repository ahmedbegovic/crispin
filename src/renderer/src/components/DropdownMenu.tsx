import { useEffect, useRef, useState, type ReactNode } from 'react'

export interface MenuItem {
  label: string
  hint?: string
  disabled?: boolean
  onSelect: () => void
}

/**
 * Small anchored menu opening above its trigger (footers sit low in the
 * thread). Closes on outside-click or Escape. `trigger` receives the open
 * state + a toggle so callers control the button.
 */
export default function DropdownMenu({
  trigger,
  items,
  align = 'left'
}: {
  trigger: (open: boolean, toggle: () => void) => ReactNode
  items: MenuItem[]
  align?: 'left' | 'right'
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const restoreFocus = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (!open) return
    // Move focus into the menu on open; restore it to the trigger on close.
    restoreFocus.current = document.activeElement as HTMLElement | null
    menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus()
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
      restoreFocus.current?.focus?.()
    }
  }, [open])

  const onMenuKey = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    const items = Array.from(
      menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? []
    )
    if (items.length === 0) return
    const idx = items.indexOf(document.activeElement as HTMLButtonElement)
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      items[(idx + 1) % items.length]?.focus()
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      items[(idx - 1 + items.length) % items.length]?.focus()
    } else if (e.key === 'Home') {
      e.preventDefault()
      items[0]?.focus()
    } else if (e.key === 'End') {
      e.preventDefault()
      items[items.length - 1]?.focus()
    }
  }

  return (
    <div ref={ref} className="relative inline-flex">
      {trigger(open, () => setOpen((o) => !o))}
      {open && (
        <div
          ref={menuRef}
          role="menu"
          onKeyDown={onMenuKey}
          className={`pop-in absolute bottom-full z-40 mb-1 min-w-44 rounded-lg border border-zinc-700 bg-zinc-900 py-1 shadow-xl ${
            align === 'right' ? 'origin-bottom-right right-0' : 'origin-bottom-left left-0'
          }`}
        >
          {items.map((item, i) => (
            <button
              key={i}
              role="menuitem"
              disabled={item.disabled}
              onClick={() => {
                setOpen(false)
                item.onSelect()
              }}
              className="flex w-full items-center justify-between gap-3 px-2.5 py-1.5 text-left text-[12px] text-zinc-300 hover:bg-zinc-800 disabled:cursor-default disabled:text-zinc-600 disabled:hover:bg-transparent"
            >
              <span>{item.label}</span>
              {item.hint && <span className="text-[10.5px] text-zinc-600">{item.hint}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
