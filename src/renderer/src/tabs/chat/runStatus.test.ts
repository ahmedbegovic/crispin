import { describe, expect, it } from 'vitest'
import { chatRunPhase, chatRunPhaseLabel } from './runStatus'

describe('chatRunPhase', () => {
  it('returns idle without an active stream', () => {
    expect(chatRunPhase(undefined)).toBe('idle')
  })

  it('does not apply conversation context to non-streaming rows', () => {
    expect(chatRunPhase(undefined, { parts: [] }, { modelLoad: true })).toBe('idle')
    expect(chatRunPhase(undefined, { parts: [] }, { stopping: true })).toBe('idle')
  })

  it('applies conversation context to the active streaming row', () => {
    expect(chatRunPhase('a', { parts: [] }, { modelLoad: true })).toBe('loadingModel')
    expect(chatRunPhase('a', { parts: [{ type: 'text', text: 'x' }] }, { stopping: true })).toBe(
      'stopping'
    )
  })

  it('returns starting before chat.send resolves the assistant id', () => {
    expect(chatRunPhase('')).toBe('starting')
    expect(chatRunPhaseLabel('starting')).toBe('Starting local run…')
  })

  it('returns loadingModel while a cold model load is active', () => {
    expect(chatRunPhase('assistant-1', { parts: [] }, { modelLoad: true })).toBe('loadingModel')
    expect(chatRunPhaseLabel('loadingModel')).toBe('Loading model…')
  })

  it('returns stopping before any other active context phase', () => {
    expect(
      chatRunPhase(
        'assistant-1',
        { parts: [{ type: 'text', text: 'hello' }] },
        { modelLoad: true, stopping: true }
      )
    ).toBe('stopping')
    expect(chatRunPhaseLabel('stopping')).toBe('Stopping…')
  })

  it('returns waitingFirstToken for an empty streaming assistant message', () => {
    expect(chatRunPhase('assistant-1', { parts: [] })).toBe('waitingFirstToken')
    expect(chatRunPhaseLabel('waitingFirstToken')).toBe('Thinking…')
  })

  it('keeps waiting while only process or non-answer parts have streamed', () => {
    expect(chatRunPhase('assistant-1', { parts: [{ type: 'thought', text: 'reasoning' }] })).toBe(
      'waitingFirstToken'
    )
    expect(
      chatRunPhase('assistant-1', {
        parts: [{ type: 'tool_call', id: 'call-1', name: 'search', args: '{"q":"x"}' }]
      })
    ).toBe('waitingFirstToken')
    expect(
      chatRunPhase('assistant-1', {
        parts: [{ type: 'tool_result', toolCallId: 'call-1', name: 'search', result: 'result' }]
      })
    ).toBe('waitingFirstToken')
    expect(
      chatRunPhase('assistant-1', {
        parts: [{ type: 'sources', sources: [{ id: 1, title: null, url: 'https://example.com' }] }]
      })
    ).toBe('waitingFirstToken')
  })

  it('keeps waiting for empty text placeholders', () => {
    expect(chatRunPhase('assistant-1', { parts: [{ type: 'text', text: '' }] })).toBe(
      'waitingFirstToken'
    )
    expect(chatRunPhase('assistant-1', { parts: [{ type: 'text', text: '\n  ' }] })).toBe(
      'waitingFirstToken'
    )
  })

  it('returns generating once the assistant message has streamed visible answer text', () => {
    expect(chatRunPhase('assistant-1', { parts: [{ type: 'text', text: 'hello' }] })).toBe(
      'generating'
    )
    expect(chatRunPhaseLabel('generating')).toBe('Generating…')
  })

  it('keeps two-argument phase behavior unchanged', () => {
    expect(chatRunPhase(undefined)).toBe('idle')
    expect(chatRunPhase('')).toBe('starting')
    expect(chatRunPhase('assistant-1', { parts: [] })).toBe('waitingFirstToken')
    expect(chatRunPhase('assistant-1', { parts: [{ type: 'text', text: 'hello' }] })).toBe(
      'generating'
    )
  })
})
