interface Props {
  used: number
  contextLength: number | null
}

const RADIUS = 6
const CIRCUMFERENCE = 2 * Math.PI * RADIUS

/** Tiny donut showing how much of the model's context window is in use. */
export default function ContextDonut({ used, contextLength }: Props) {
  if (contextLength === null || used <= 0) return null
  const fraction = Math.min(used / contextLength, 1)
  const arcClass =
    fraction >= 0.9
      ? 'stroke-red-500'
      : fraction >= 0.75
        ? 'stroke-amber-400'
        : 'stroke-emerald-500'
  return (
    <span
      title={`${used.toLocaleString()} / ${contextLength.toLocaleString()} tokens (${Math.round(
        fraction * 100
      )}% of context)`}
      className="flex items-center gap-1 text-[11px] text-zinc-500"
    >
      {/* -rotate-90 starts the arc at 12 o'clock. */}
      <svg viewBox="0 0 16 16" className="h-4 w-4 -rotate-90">
        <circle
          cx="8"
          cy="8"
          r={RADIUS}
          fill="none"
          strokeWidth="2.5"
          className="stroke-zinc-700/40"
        />
        <circle
          cx="8"
          cy="8"
          r={RADIUS}
          fill="none"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeDasharray={`${fraction * CIRCUMFERENCE} ${CIRCUMFERENCE}`}
          className={arcClass}
        />
      </svg>
      {Math.round(fraction * 100)}%
    </span>
  )
}
