import { useEffect, useRef, type RefObject } from 'react'

/**
 * The standard overlay dismissal + focus contract, in one place:
 *  - Escape closes (and is stopped so it doesn't also trigger composer-stop etc.)
 *  - `focusRef` is focused when the overlay opens (so keyboard/SR users land inside)
 *  - focus is restored to the previously-focused element when it closes
 *  - pass `outsideRef` to also close on a mousedown outside that element (popovers)
 *
 * Call it unconditionally (it no-ops while `open` is false), before any early return.
 */
export function useDismissable(
  open: boolean,
  onClose: () => void,
  opts: {
    focusRef?: RefObject<HTMLElement | null>
    outsideRef?: RefObject<HTMLElement | null>
  } = {}
): void {
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  const { focusRef, outsideRef } = opts

  useEffect(() => {
    if (!open) return
    const previouslyFocused = document.activeElement as HTMLElement | null
    // Focus after paint so the target element exists and layout has settled.
    const focusTimer = window.setTimeout(() => focusRef?.current?.focus(), 0)

    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        onCloseRef.current()
      }
    }
    const onDown = (e: MouseEvent): void => {
      const el = outsideRef?.current
      if (el && e.target instanceof Node && !el.contains(e.target)) onCloseRef.current()
    }
    window.addEventListener('keydown', onKey)
    if (outsideRef) window.addEventListener('mousedown', onDown)
    return () => {
      window.clearTimeout(focusTimer)
      window.removeEventListener('keydown', onKey)
      if (outsideRef) window.removeEventListener('mousedown', onDown)
      previouslyFocused?.focus?.()
    }
  }, [open, focusRef, outsideRef])
}
