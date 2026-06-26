import { describe, it, expect, vi, afterEach } from 'vitest'
import { EngineClient } from './engine-client'

// Guards the airtight half of the engine lifecycle coordinator (Pass 18 #2): while
// a lifecycle op holds the drain gate, a NEW generation must PARK before it counts
// as in-flight or hits the wire — so the op runs with nothing able to start. A
// sampled engineIdle() probe could not guarantee this.

const completion = {
  ok: true,
  headers: { get: () => null },
  json: async () => ({ choices: [{ message: { content: 'hi' } }], usage: {} })
} as unknown as Response

describe('EngineClient drain gate', () => {
  afterEach(() => vi.restoreAllMocks())

  it('parks a new generation while draining, releases it on setDraining(false)', async () => {
    const fetchMock = vi.fn(async () => completion)
    vi.stubGlobal('fetch', fetchMock)
    const engine = new EngineClient(() => 'http://127.0.0.1:1')

    engine.setDraining(true)
    const inflight = engine.chat({ model: 'm', messages: [] })
    await new Promise((r) => setTimeout(r, 20)) // a few microtask turns

    expect(fetchMock).not.toHaveBeenCalled() // held at the gate, never reached the wire
    expect(engine.inflight).toBe(0) // not counted until past the gate

    engine.setDraining(false)
    await inflight

    expect(fetchMock).toHaveBeenCalledTimes(1) // released → proceeded
    expect(engine.inflight).toBe(0) // balanced back on completion
  })

  it('does not park when the gate is clear', async () => {
    const fetchMock = vi.fn(async () => completion)
    vi.stubGlobal('fetch', fetchMock)
    const engine = new EngineClient(() => 'http://127.0.0.1:1')

    await engine.chat({ model: 'm', messages: [] })

    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
