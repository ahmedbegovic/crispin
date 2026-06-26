import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const { warn } = vi.hoisted(() => ({ warn: vi.fn() }))
vi.mock('./logger', () => ({
  scopedLogger: () => ({ info: () => {}, warn, error: () => {} })
}))

import { ToolsClient } from './tools-client'
import { enableSidecarValidation } from './sidecar-contract'

const resp = (body: unknown): Response => ({ ok: true, json: async () => body }) as unknown as Response

beforeEach(() => {
  warn.mockClear()
  enableSidecarValidation(true)
})

afterEach(() => {
  vi.unstubAllGlobals()
  enableSidecarValidation(false)
})

describe('ToolsClient response contract validation (wiring)', () => {
  it('logs when a response drifts from its endpoint schema', async () => {
    // /models/local entry missing the required repo_id.
    vi.stubGlobal('fetch', vi.fn(async () => resp({ models: [{ size_bytes: 1 }] })))
    await new ToolsClient(() => 'http://127.0.0.1:1').localModels()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0][0]).toContain('/models/local')
  })

  it('does not log a contract-valid response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => resp({ models: [] })))
    await new ToolsClient(() => 'http://127.0.0.1:1').localModels()
    expect(warn).not.toHaveBeenCalled()
  })

  it('stays silent when validation is disabled (prod path), even on drift', async () => {
    enableSidecarValidation(false)
    vi.stubGlobal('fetch', vi.fn(async () => resp({ totally: 'wrong' })))
    await new ToolsClient(() => 'http://127.0.0.1:1').localModels()
    expect(warn).not.toHaveBeenCalled()
  })
})
