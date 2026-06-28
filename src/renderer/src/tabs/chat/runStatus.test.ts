import { describe, expect, it } from 'vitest'
import { chatRunPhase, chatRunPhaseLabel } from './runStatus'

describe('chatRunPhase', () => {
  it('returns idle without an active stream', () => {
    expect(chatRunPhase(undefined)).toBe('idle')
  })

  it('returns starting before chat.send resolves the assistant id', () => {
    expect(chatRunPhase('')).toBe('starting')
    expect(chatRunPhaseLabel('starting')).toBe('Starting local run...')
  })

  it('returns waitingFirstToken for an empty streaming assistant message', () => {
    expect(chatRunPhase('assistant-1', { parts: [] })).toBe('waitingFirstToken')
    expect(chatRunPhaseLabel('waitingFirstToken')).toBe('Loading local model...')
  })

  it('returns generating once the assistant message has streamed parts', () => {
    expect(chatRunPhase('assistant-1', { parts: [{ type: 'text', text: 'hello' }] })).toBe(
      'generating'
    )
    expect(chatRunPhaseLabel('generating')).toBe('Generating...')
  })
})
