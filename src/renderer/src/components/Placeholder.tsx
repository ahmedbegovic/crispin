import type { LucideIcon } from 'lucide-react'

interface Props {
  icon: LucideIcon
  title: string
  subtitle: string
  milestone: string
}

/** Temporary tab body shown until the tab's milestone lands. */
export default function Placeholder({ icon: Icon, title, subtitle, milestone }: Props) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
      <div className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-4">
        <Icon size={28} strokeWidth={1.5} className="text-zinc-500" />
      </div>
      <div>
        <h2 className="text-lg font-semibold text-zinc-200">{title}</h2>
        <p className="mt-1 max-w-md text-sm text-zinc-500">{subtitle}</p>
      </div>
      <span className="rounded-full border border-zinc-800 bg-zinc-900 px-2.5 py-0.5 text-[11px] text-zinc-500">
        arrives in {milestone}
      </span>
    </div>
  )
}
