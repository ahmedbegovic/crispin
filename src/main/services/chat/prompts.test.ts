import { describe, expect, it } from 'vitest'
import { cleanTitle, instantTitle } from './prompts'

describe('instantTitle', () => {
  it('flattens whitespace and newlines', () => {
    expect(instantTitle('  hello\n  world  ')).toBe('hello world')
  })

  it('strips a leading markdown marker', () => {
    expect(instantTitle('## Fix the build')).toBe('Fix the build')
    expect(instantTitle('- buy milk and eggs today please')).toBe('buy milk and eggs today please')
    expect(instantTitle('> quoted question here please')).toBe('quoted question here please')
    expect(instantTitle('1. first numbered item here')).toBe('first numbered item here')
  })

  it('strips inline markdown punctuation', () => {
    expect(instantTitle('Explain **RAG** vs `long-context`')).toBe('Explain RAG vs long-context')
  })

  it('prefers the first sentence when it is substantial', () => {
    expect(instantTitle('How do I center a div? I have tried flexbox.')).toBe(
      'How do I center a div?'
    )
  })

  it('falls back to the whole line for a short first sentence', () => {
    // "Hi." is too short to stand alone as a title.
    expect(instantTitle('Hi. Can you help me debug this stack trace?')).toBe(
      'Hi. Can you help me debug this stack trace?'
    )
  })

  it('truncates with an ellipsis past 60 chars', () => {
    const long = 'a'.repeat(80)
    const out = instantTitle(long)
    expect(out.endsWith('…')).toBe(true)
    expect(out.length).toBe(60)
  })

  it('is pure/deterministic for the same input', () => {
    const t = '## Plan **the** migration\nstep by step'
    expect(instantTitle(t)).toBe(instantTitle(t))
  })
})

describe('cleanTitle', () => {
  it('strips quotes, markdown chars and trailing punctuation', () => {
    expect(cleanTitle('"Center a div with flexbox."')).toBe('Center a div with flexbox')
    expect(cleanTitle('**Fix the build**')).toBe('Fix the build')
  })

  it('caps at 8 words', () => {
    expect(cleanTitle('one two three four five six seven eight nine ten')).toBe(
      'one two three four five six seven eight'
    )
  })

  it('collapses whitespace and newlines', () => {
    expect(cleanTitle('a\n  b   c')).toBe('a b c')
  })
})
