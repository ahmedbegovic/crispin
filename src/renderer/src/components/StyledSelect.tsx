import { type ReactNode } from 'react'
import { ChevronDown } from 'lucide-react'
import DropdownMenu from './DropdownMenu'

export interface StyledSelectOption<T extends string> {
  value: T
  label: string
  leading?: ReactNode
  disabled?: boolean
}

export interface StyledSelectProps<T extends string> {
  value: T
  options: StyledSelectOption<T>[]
  onChange: (value: T) => void
  ariaLabel: string
  /** Native-style hover tooltip on the trigger (parity with the old <select title>). */
  title?: string
  align?: 'left' | 'right'
  className?: string
}

export default function StyledSelect<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
  title,
  align = 'left',
  className = ''
}: StyledSelectProps<T>): React.JSX.Element {
  const selected = options.find((option) => option.value === value)

  return (
    <DropdownMenu
      align={align}
      ariaLabel={ariaLabel}
      items={options.map((option) => ({
        label: option.label,
        leading: option.leading,
        disabled: option.disabled,
        selected: option.value === value,
        onSelect: () => {
          if (option.value !== value) onChange(option.value)
        }
      }))}
      trigger={(open, toggle) => (
        <button
          type="button"
          onClick={toggle}
          aria-haspopup="menu"
          aria-expanded={open}
          // Fold the current value into the accessible name — aria-label would
          // otherwise override the visible label and AT would never hear the pick.
          aria-label={selected ? `${ariaLabel}: ${selected.label}` : ariaLabel}
          title={title}
          className={`press flex min-w-0 items-center justify-between gap-1.5 rounded-md border border-zinc-800 bg-zinc-900/70 px-1.5 py-1 text-[11px] text-zinc-400 outline-none hover:border-zinc-700 hover:text-zinc-300 focus:border-emerald-500/70 focus:text-zinc-200 ${
            open ? 'border-zinc-700 text-zinc-200' : ''
          } ${className}`}
        >
          {/* Per-option dots live INSIDE the menu (when choosing); the closed
              trigger stays clean — the resolved-model badge is the footer status. */}
          <span className="min-w-0 truncate">{selected?.label ?? ''}</span>
          <ChevronDown size={12} aria-hidden className="shrink-0 text-zinc-500" />
        </button>
      )}
    />
  )
}
