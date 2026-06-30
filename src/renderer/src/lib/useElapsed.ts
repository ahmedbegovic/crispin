import { useEffect, useState } from 'react'

export function elapsedSeconds(now: number, startedAt: number | null | undefined): number {
  if (startedAt == null) {
    return 0
  }

  return Math.max(0, Math.floor((now - startedAt) / 1000))
}

export function useElapsed(startedAt: number | null | undefined, intervalMs = 1000): number {
  const [elapsed, setElapsed] = useState(() => elapsedSeconds(Date.now(), startedAt))

  useEffect(() => {
    if (startedAt == null) {
      setElapsed(0)
      return
    }

    setElapsed(elapsedSeconds(Date.now(), startedAt))

    const intervalId = window.setInterval(() => {
      setElapsed(elapsedSeconds(Date.now(), startedAt))
    }, intervalMs)

    return () => window.clearInterval(intervalId)
  }, [startedAt, intervalMs])

  return elapsed
}
