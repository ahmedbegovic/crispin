import { describe, it, expect, vi, afterEach } from 'vitest'
import { EngineClient } from './engine-client'

// rediscover() drives Crispin's oMLX patch: POST /v1/models/discover triggers a
// live re-scan instead of an engine restart. It must (a) return the pool summary
// on success, (b) report 'unsupported' (null) on 404 so callers fall back to the
// old restart on an un-patched engine, (c) surface other failures, (d) stay off
// the inflight counter (it's a control-plane call, not a generation).

const res = (init: { status: number; ok: boolean; body?: unknown; text?: string }) =>
  ({
    ok: init.ok,
    status: init.status,
    json: async () => init.body,
    text: async () => init.text ?? ''
  }) as unknown as Response

afterEach(() => vi.restoreAllMocks())

describe('EngineClient.rediscover', () => {
  it('returns the pool summary on success', async () => {
    const fetchMock = vi.fn(async () =>
      res({ ok: true, status: 200, body: { status: 'ok', models_discovered: 2, loaded_models: ['a/b'] } })
    )
    vi.stubGlobal('fetch', fetchMock)
    const engine = new EngineClient(() => 'http://127.0.0.1:1')

    const result = await engine.rediscover()

    expect(result).toEqual({ modelsDiscovered: 2, loadedModels: ['a/b'] })
    const [url, opts] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('http://127.0.0.1:1/v1/models/discover')
    expect(opts.method).toBe('POST')
    expect(engine.inflight).toBe(0) // control-plane: never counts as a generation
  })

  it('returns null when the endpoint is absent (404 → fall back to restart)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => res({ ok: false, status: 404, text: 'Not Found' })))
    const engine = new EngineClient(() => 'http://127.0.0.1:1')

    expect(await engine.rediscover()).toBeNull()
  })

  it('throws on a non-404 failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => res({ ok: false, status: 500, text: 'boom' })))
    const engine = new EngineClient(() => 'http://127.0.0.1:1')

    await expect(engine.rediscover()).rejects.toThrow(/500/)
  })

  it('sends a settings body when provided, and none otherwise', async () => {
    const fetchMock = vi.fn(async () =>
      res({ ok: true, status: 200, body: { status: 'ok', models_discovered: 1, loaded_models: [] } })
    )
    vi.stubGlobal('fetch', fetchMock)
    const engine = new EngineClient(() => 'http://127.0.0.1:1')

    const bodyOf = (i: number) =>
      JSON.parse((fetchMock.mock.calls[i] as unknown as [string, RequestInit])[1].body as string)

    await engine.rediscover({ 'a--b': { max_tokens: 8192 } })
    expect(bodyOf(0)).toEqual({ settings: { 'a--b': { max_tokens: 8192 } } })

    await engine.rediscover()
    expect(bodyOf(1)).toEqual({})
  })
})
