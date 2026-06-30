import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Check } from 'lucide-react'

export interface MenuItem {
  label: string
  leading?: ReactNode
  hint?: string
  disabled?: boolean
  selected?: boolean
  onSelect: () => void
}

// menuitemradio when an item carries `selected` (a value-select); plain menuitem
// otherwise (action menu). Keyboard-nav selectors must match BOTH roles.
const MENU_ITEM_SELECTOR =
  '[role="menuitem"]:not(:disabled), [role="menuitemradio"]:not(:disabled)'

/**
 * Small anchored menu opening above its trigger (footers sit low in the
 * thread). Closes on outside-click or Escape. `trigger` receives the open
 * state + a toggle so callers control the button.
 */
export default function DropdownMenu({
  trigger,
  items,
  align = 'left',
  ariaLabel
}: {
  trigger: (open: boolean, toggle: () => void) => ReactNode
  items: MenuItem[]
  align?: 'left' | 'right'
  /** Accessible name for the popup (role="menu") — pass the control's name. */
  ariaLabel?: string
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const restoreFocus = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (!open) return
    // Move focus into the menu on open; restore it to the trigger on close.
    restoreFocus.current = document.activeElement as HTMLElement | null
    // Focus the checked option if any (single-select), else the first item.
    const menu = menuRef.current
    const focusTarget =
      menu?.querySelector<HTMLButtonElement>('[aria-checked="true"]') ??
      menu?.querySelector<HTMLButtonElement>(MENU_ITEM_SELECTOR)
    focusTarget?.focus()
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
    if (e.key === 'Tab') {
      setOpen(false) // Tab leaves the menu — close it (focus restores to the trigger).
      return
    }
    const items = Array.from(
      menuRef.current?.querySelectorAll<HTMLButtonElement>(MENU_ITEM_SELECTOR) ?? []
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
          aria-label={ariaLabel}
          onKeyDown={onMenuKey}
          className={`pop-in absolute bottom-full z-40 mb-1 max-h-64 min-w-44 overflow-y-auto rounded-lg border border-zinc-700 bg-zinc-900 py-1 shadow-xl ${
            align === 'right' ? 'origin-bottom-right right-0' : 'origin-bottom-left left-0'
          }`}
        >
          {items.map((item, i) => (
            <button
              key={i}
              role={item.selected === undefined ? 'menuitem' : 'menuitemradio'}
              aria-checked={item.selected === undefined ? undefined : item.selected}
              disabled={item.disabled}
              onClick={() => {
                setOpen(false)
                item.onSelect()
              }}
              className={`flex w-full items-center justify-between gap-3 px-2.5 py-1.5 text-left text-[12px] text-zinc-300 hover:bg-zinc-800 disabled:cursor-default disabled:text-zinc-600 disabled:hover:bg-transparent ${
                item.selected ? 'bg-zinc-800/60 text-zinc-200' : ''
              }`}
            >
              <span className="flex min-w-0 items-center gap-2">
                {item.leading && <span className="shrink-0">{item.leading}</span>}
                <span className="truncate">{item.label}</span>
              </span>
              {(item.hint || item.selected) && (
                <span className="flex shrink-0 items-center gap-2">
                  {item.hint && <span className="text-[10.5px] text-zinc-600">{item.hint}</span>}
                  {item.selected && (
                    <Check size={13} aria-hidden className="text-zinc-400" />
                  )}
                </span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
