import { describe, it, expect, vi, beforeEach } from 'vitest'
import { z } from 'zod'

const { warn } = vi.hoisted(() => ({ warn: vi.fn() }))
vi.mock('./logger', () => ({
  scopedLogger: () => ({ info: () => {}, warn, error: () => {} })
}))

import {
  checkSidecar,
  enableSidecarValidation,
  engineDiscoverSchema,
  jobSnapshotSchema,
  localModelsSchema
} from './sidecar-contract'

const S = z.object({ a: z.string() })

beforeEach(() => {
  warn.mockClear()
  enableSidecarValidation(false)
})

describe('checkSidecar', () => {
  it('returns the data and does not log when validation is disabled (prod default)', () => {
    const bad = { a: 1 } as unknown
    expect(checkSidecar(S, bad, 'x')).toBe(bad)
    expect(warn).not.toHaveBeenCalled()
  })

  it('logs once but STILL returns the data when enabled and the shape drifted', () => {
    enableSidecarValidation(true)
    const bad = { a: 1 } as unknown
    expect(checkSidecar(S, bad, '/endpoint')).toBe(bad) // log-and-send: never throws/drops
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0][0]).toContain('/endpoint')
  })

  it('does not log a contract-valid shape', () => {
    enableSidecarValidation(true)
    checkSidecar(S, { a: 'ok' }, 'x')
    expect(warn).not.toHaveBeenCalled()
  })
})

describe('endpoint schemas catch real drift', () => {
  beforeEach(() => enableSidecarValidation(true))

  it('flags a job status value Python could add without updating the TS union', () => {
    // jobs.py only emits running|done|failed|cancelled; a new 'paused' would drift.
    checkSidecar(
      jobSnapshotSchema,
      { id: '1', kind: 'x', status: 'paused', progress: 0, detail: '', error: null, result: null, data: {} },
      '/jobs'
    )
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('flags a renamed/missing required field in /models/local', () => {
    checkSidecar(localModelsSchema, { models: [{ size_bytes: 1 }] }, '/models/local') // repo_id missing
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('accepts the real /models/local shape (nullable sampling/context)', () => {
    checkSidecar(
      localModelsSchema,
      { models: [{ repo_id: 'a/b', size_bytes: 1, last_modified_ms: null, context_length: null, sampling: null }] },
      '/models/local'
    )
    expect(warn).not.toHaveBeenCalled()
  })

  it('accepts the real /v1/models/discover shape', () => {
    checkSidecar(
      engineDiscoverSchema,
      { status: 'ok', models_discovered: 3, loaded_models: ['a/b'] },
      '/v1/models/discover'
    )
    expect(warn).not.toHaveBeenCalled()
  })

  it('flags /v1/models/discover drift (loaded_models not an array of strings)', () => {
    checkSidecar(
      engineDiscoverSchema,
      { status: 'ok', models_discovered: 3, loaded_models: 'a/b' },
      '/v1/models/discover'
    )
    expect(warn).toHaveBeenCalledTimes(1)
  })
})
