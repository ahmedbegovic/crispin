import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

/**
 * Hover/focus card portaled to <body> so it escapes the chat thread's
 * overflow clipping (react-virtuoso is overflow-hidden). Opens on hover or
 * keyboard focus of the trigger; closes on leave, blur, scroll, or Escape.
 */
export default function HoverCard({
  trigger,
  children
}: {
  trigger: ReactNode
  children: ReactNode
}): React.JSX.Element {
  const ref = useRef<HTMLSpanElement>(null)
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<{ left: number; top?: number; bottom?: number } | null>(null)
  const hideTimer = useRef<number | undefined>(undefined)

  const clearHide = (): void => {
    if (hideTimer.current !== undefined) {
      window.clearTimeout(hideTimer.current)
      hideTimer.current = undefined
    }
  }
  const show = (): void => {
    clearHide()
    const r = ref.current?.getBoundingClientRect()
    if (r) {
      const CARD_W = 320
      const left = Math.max(8, Math.min(r.left, window.innerWidth - CARD_W - 8))
      // Flip above when there isn't room below (a citation low in the viewport),
      // anchoring via `bottom` so we don't need to measure the card height.
      setPos(
        window.innerHeight - r.bottom < 240
          ? { left, bottom: window.innerHeight - r.top + 4 }
          : { left, top: r.bottom + 4 }
      )
    }
    setOpen(true)
  }
  // Defer the close so the pointer can bridge the gap from the trigger into the
  // portaled card (which isn't a DOM descendant, so onMouseLeave fires en route);
  // the card's own onMouseEnter cancels it.
  const hide = (): void => {
    clearHide()
    hideTimer.current = window.setTimeout(() => setOpen(false), 120)
  }

  useEffect(() => {
    if (!open) return
    const onScroll = (): void => setOpen(false)
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  useEffect(() => () => clearHide(), [])

  return (
    <span ref={ref} onMouseEnter={show} onMouseLeave={hide} onFocus={show} onBlur={hide}>
      {trigger}
      {open &&
        pos &&
        createPortal(
          <div
            role="tooltip"
            style={{ top: pos.top, bottom: pos.bottom, left: pos.left }}
            onMouseEnter={show}
            onMouseLeave={hide}
            className="fixed z-50 w-80 max-w-[90vw] rounded-lg border border-zinc-700 bg-zinc-900 p-2.5 text-[12px] shadow-xl"
          >
            {children}
          </div>,
          document.body
        )}
    </span>
  )
}
