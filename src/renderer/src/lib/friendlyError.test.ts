import { describe, expect, it } from 'vitest'
import { friendlyError } from './friendlyError'

const notDownloadedMessage = "That model isn't downloaded yet — open the Models tab to download it."
const engineStartMessage = "The model engine couldn't start. Open the Models tab to check it (or view logs)."
const rejectedMessage = 'The engine rejected the request. Try again, or restart it from the Models tab.'

function expectMapped(raw: string, expected: string): void {
  const mapped = friendlyError(raw)
  expect(mapped).toBe(expected)
  expect(mapped).not.toBe(raw)
}

describe('friendlyError', () => {
  it('maps real main-process model and engine errors', () => {
    expectMapped('mlx-community/Qwen3.5-9B-MLX-4bit is not downloaded', notDownloadedMessage)
    expectMapped('engine did not become ready in time', engineStartMessage)
    expectMapped('engine failed to start — check logs', engineStartMessage)
    expectMapped('engine process is not registered', engineStartMessage)
    expectMapped('engine POST /v1/chat/completions → 404: missing model', rejectedMessage)
  })

  it('keeps existing mapped error groups', () => {
    expectMapped('ECONNREFUSED 127.0.0.1:47621', "The model engine isn't running. Open the Models tab to start it.")
    expectMapped(
      'OOM while allocating KV cache',
      'Ran out of memory for this model. Try a smaller model, or clear the KV cache and retry.'
    )
    expectMapped(
      'engine POST /v1/chat/completions → 500: internal error',
      'The engine hit an error. Try again, or restart it from the Models tab.'
    )
  })

  it('passes unknown errors through unchanged', () => {
    const raw = 'template adapter returned malformed assistant content'

    expect(friendlyError(raw)).toBe(raw)
  })

  it('truncates long unknown errors', () => {
    const raw = `template adapter returned malformed assistant content: ${'x'.repeat(220)}`

    expect(friendlyError(raw)).toBe(`${raw.slice(0, 199)}…`)
  })
})
