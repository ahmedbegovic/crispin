import { describe, it, expect, beforeEach, vi } from 'vitest'

// Shared mutable state the hoisted mock factories close over.
const h = vi.hoisted(() => ({ warn: vi.fn(), send: vi.fn(), isPackaged: false }))

vi.mock('../services/logger', () => ({
  scopedLogger: () => ({ info: () => {}, warn: h.warn, error: () => {} })
}))

vi.mock('electron', () => ({
  app: {
    get isPackaged() {
      return h.isPackaged
    }
  },
  BrowserWindow: {
    getAllWindows: () => [{ isDestroyed: () => false, webContents: { send: h.send } }]
  }
}))

import { broadcast, checkEvent } from './events'

// A structurally-valid event and one whose payload violates crispinEventSchema
// (chat.delta carrying a part with an unknown discriminator).
const validEvent = { type: 'news.updated' as const }
const malformedDelta = {
  type: 'chat.delta' as const,
  conversationId: 'c',
  messageId: 'm',
  partIndex: 0,
  part: { type: 'bogus' },
  append: false
}

beforeEach(() => {
  h.warn.mockClear()
  h.send.mockClear()
  h.isPackaged = false
})

describe('checkEvent', () => {
  it('returns true for a contract-valid event', () => {
    expect(checkEvent(validEvent)).toBe(true)
  })

  it('returns false when the event payload violates the schema', () => {
    expect(checkEvent(malformedDelta)).toBe(false)
  })
})

describe('broadcast', () => {
  it('in dev, logs a malformed event but STILL delivers it (never drops/throws)', () => {
    expect(() => broadcast(malformedDelta as never)).not.toThrow()
    expect(h.warn).toHaveBeenCalledTimes(1)
    expect(h.send).toHaveBeenCalledTimes(1)
    expect(h.send).toHaveBeenCalledWith('crispin:event', malformedDelta)
  })

  it('in dev, delivers a valid event without logging', () => {
    broadcast(validEvent as never)
    expect(h.warn).not.toHaveBeenCalled()
    expect(h.send).toHaveBeenCalledTimes(1)
  })

  it('in a packaged build, skips validation entirely but still delivers', () => {
    h.isPackaged = true
    broadcast(malformedDelta as never)
    expect(h.warn).not.toHaveBeenCalled()
    expect(h.send).toHaveBeenCalledTimes(1)
  })
})
