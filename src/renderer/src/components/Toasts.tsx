import { useEffect } from 'react'
import { useToastsStore, type ToastLevel } from '@/stores/toasts'

const LEVEL_STYLES: Record<ToastLevel, string> = {
  info: 'border-zinc-700 text-zinc-200',
  warn: 'border-amber-500/40 text-amber-300',
  error: 'border-red-500/40 text-red-300'
}

/** Bottom-right stack of auto-dismissing notifications; click dismisses one early. */
export default function Toasts() {
  const toasts = useToastsStore((s) => s.toasts)
  const dismiss = useToastsStore((s) => s.dismiss)
  const init = useToastsStore((s) => s.init)

  // Mounted once in App so the system.toast subscription outlives tab switches.
  useEffect(() => init(), [init])

  if (toasts.length === 0) return null
  return (
    <div
      role="status"
      aria-live="polite"
      aria-atomic="true"
      className="no-drag fixed bottom-9 right-3 z-50 flex w-80 flex-col gap-2"
    >
      {toasts.map((toast) => (
        <button
          key={toast.id}
          onClick={() => dismiss(toast.id)}
          className={`rounded-lg border bg-zinc-900 px-3 py-2 text-left text-[12px] leading-relaxed shadow-2xl ${LEVEL_STYLES[toast.level]}`}
        >
          {toast.message}
        </button>
      ))}
    </div>
  )
}
