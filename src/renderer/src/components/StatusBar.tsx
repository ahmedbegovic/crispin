import { useSystemStore } from '@/stores/system'
import type { ProcessSnapshot } from '@shared/types'

function dotColor(state: ProcessSnapshot['state']): string {
  switch (state) {
    case 'running':
      return 'bg-emerald-500'
    case 'waiting_healthy':
    case 'spawning':
    case 'restarting':
      return 'bg-amber-400'
    case 'unhealthy':
      return 'bg-orange-500'
    case 'failed':
      return 'bg-red-500'
    default:
      return 'bg-zinc-600'
  }
}

export default function StatusBar() {
  const status = useSystemStore((s) => s.status)
  const processes = useSystemStore((s) => s.processes)
  const restart = useSystemStore((s) => s.restartProcess)

  return (
    <footer className="flex h-7 shrink-0 items-center gap-4 border-t border-zinc-800/80 bg-zinc-950 px-3 text-[11px] text-zinc-500">
      {Object.values(processes).map((p) => (
        <button
          key={p.name}
          className="no-drag flex items-center gap-1.5 hover:text-zinc-300"
          title={`${p.name}: ${p.state}${p.detail ? ` — ${p.detail}` : ''}${p.port ? ` (port ${p.port})` : ''}\nClick to restart`}
          onClick={() => void restart(p.name)}
        >
          <span className={`inline-block h-2 w-2 rounded-full ${dotColor(p.state)}`} />
          {p.name}
          {p.state !== 'running' && <span className="text-zinc-600">· {p.state}</span>}
        </button>
      ))}
      <div className="ml-auto flex items-center gap-3">
        <span>Orion {status?.version ?? '…'}</span>
      </div>
    </footer>
  )
}
