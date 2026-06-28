import { describe, expect, it } from 'vitest'
import { segmentThought } from './thoughtSteps'

describe('segmentThought', () => {
  it('returns no steps for empty / whitespace', () => {
    expect(segmentThought('')).toEqual([])
    expect(segmentThought('   \n  ')).toEqual([])
  })

  it('splits on blank lines into heading-less steps', () => {
    expect(segmentThought('First idea.\n\nSecond idea.')).toEqual([
      { heading: null, body: 'First idea.' },
      { heading: null, body: 'Second idea.' }
    ])
  })

  it('extracts a markdown header as the heading', () => {
    expect(segmentThought('## Plan the search\nlook for recent pricing')).toEqual([
      { heading: 'Plan the search', body: 'look for recent pricing' }
    ])
  })

  it('extracts a closed bold lead-in (inline or on its own line)', () => {
    expect(segmentThought('**Weigh tradeoffs** the M4 is faster')).toEqual([
      { heading: 'Weigh tradeoffs', body: 'the M4 is faster' }
    ])
    expect(segmentThought('**Decide**\ngo with the M4')).toEqual([
      { heading: 'Decide', body: 'go with the M4' }
    ])
  })

  it('leaves a half-streamed bold lead-in as body (no closer yet)', () => {
    expect(segmentThought('**Weigh trade')).toEqual([{ heading: null, body: '**Weigh trade' }])
  })

  it('treats a numbered/bullet item with body as a heading, a bare one as prose', () => {
    expect(segmentThought('1. Plan the search\nfind sources')).toEqual([
      { heading: 'Plan the search', body: 'find sources' }
    ])
    expect(segmentThought('- just a single bullet line')).toEqual([
      { heading: null, body: '- just a single bullet line' }
    ])
  })

  it('extracts a short "Title: body" lead-in', () => {
    expect(segmentThought('Goal: ship the feature today')).toEqual([
      { heading: 'Goal', body: 'ship the feature today' }
    ])
  })

  it('keeps a single unbroken paragraph as one heading-less step', () => {
    expect(segmentThought('one continuous thought with no breaks at all')).toEqual([
      { heading: null, body: 'one continuous thought with no breaks at all' }
    ])
  })
})
