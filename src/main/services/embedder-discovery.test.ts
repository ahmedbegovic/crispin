import { describe, it, expect } from 'vitest'
import { embedderDiscoverAction } from './embedder-discovery'

// Pure decision kernel for the embedder-rediscovery restart (F2) — no deps.

const base = {
  disposed: false,
  running: true,
  alreadyDiscovered: false,
  idle: true,
  timedOut: false
}

describe('embedderDiscoverAction', () => {
  it('restarts only when the engine is running, idle, and the embedder is undiscovered', () => {
    expect(embedderDiscoverAction(base)).toBe('restart')
  })

  it('NEVER restarts while a generation is in flight — waits instead', () => {
    expect(embedderDiscoverAction({ ...base, idle: false })).toBe('wait')
  })

  it('gives up (without restarting) once the busy-wait deadline passes', () => {
    expect(embedderDiscoverAction({ ...base, idle: false, timedOut: true })).toBe('giveUp')
  })

  it('is a no-op when the engine is not running', () => {
    expect(embedderDiscoverAction({ ...base, running: false, idle: false })).toBe('done')
  })

  it('is a no-op when the embedder is already discovered', () => {
    expect(embedderDiscoverAction({ ...base, alreadyDiscovered: true })).toBe('done')
  })

  it('gives up on shutdown, even when the engine is idle', () => {
    expect(embedderDiscoverAction({ ...base, disposed: true })).toBe('giveUp')
  })
})
