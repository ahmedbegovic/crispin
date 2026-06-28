import { describe, expect, it } from 'vitest'
import {
  queryTerms,
  splitIntoChunks,
  scoreChunk,
  rankPassages,
  hostOf,
  domainBonus,
  candidateScore
} from './search-rank'

describe('queryTerms', () => {
  it('lowercases, drops stopwords and short tokens, dedupes', () => {
    expect(queryTerms('What is the BEST price for the iPhone 15?')).toEqual([
      'best',
      'price',
      'iphone',
      '15'
    ])
  })
  it('is empty for a question with no content words', () => {
    expect(queryTerms('what is it?')).toEqual([])
  })
})

describe('splitIntoChunks', () => {
  it('splits on markdown headings and tracks the heading path', () => {
    const md = '# Title\nintro line\n## Pricing\nthe price is $599\n## Specs\n8GB RAM'
    const chunks = splitIntoChunks(md)
    expect(chunks.map((c) => c.headingPath)).toEqual([
      ['Title'],
      ['Title', 'Pricing'],
      ['Title', 'Specs']
    ])
    expect(chunks[1].text).toContain('$599')
  })

  it('pops sibling/shallower headings off the path', () => {
    const md = '# A\n### deep\nx\n## B\ny'
    const chunks = splitIntoChunks(md)
    expect(chunks.map((c) => c.headingPath)).toEqual([
      ['A', 'deep'],
      ['A', 'B']
    ])
  })
})

describe('scoreChunk', () => {
  it('scores a chunk that mentions the terms above one that does not', () => {
    const terms = ['memory', 'bandwidth']
    const hit = { headingPath: ['Specs'], text: 'memory bandwidth is 120 GB/s' }
    const miss = { headingPath: ['About'], text: 'a lovely device for everyone' }
    expect(scoreChunk(hit, terms)).toBeGreaterThan(scoreChunk(miss, terms))
    expect(scoreChunk(miss, terms)).toBe(0)
  })

  it('rewards a heading match', () => {
    const terms = ['pricing']
    const inHeading = { headingPath: ['Pricing'], text: 'see the table below' }
    const inBodyOnly = { headingPath: ['Misc'], text: 'pricing varies by region' }
    expect(scoreChunk(inHeading, terms)).toBeGreaterThan(scoreChunk(inBodyOnly, terms))
  })
})

describe('rankPassages', () => {
  it('surfaces the relevant section even when it sits at the bottom of the page', () => {
    const head = Array.from({ length: 40 }, (_, i) => `## Section ${i}\nfiller about unrelated topics`).join(
      '\n'
    )
    const md = `${head}\n## Battery life\nthe battery lasts 18 hours on a charge`
    // Budget far smaller than the page: the old head-clip would keep only the
    // filler. Relevance-first ranking must lead with the battery section.
    const ranked = rankPassages(md, 'how long does the battery last', 400)
    expect(ranked).toContain('18 hours')
    expect(ranked.indexOf('18 hours')).toBeLessThan(200)
  })

  it('leads a short page with the relevant section so a downstream clip is safe', () => {
    const md = '## Intro\nwelcome to the page\n## Price\nit costs 42 dollars'
    const ranked = rankPassages(md, 'what is the price', 10_000)
    expect(ranked).toContain('42 dollars')
    // the relevant section leads; the irrelevant intro trails it
    expect(ranked.indexOf('42 dollars')).toBeLessThan(ranked.indexOf('welcome'))
  })

  it('KEEPS non-matching chunks of a page that fits the budget (never worse than head-clip)', () => {
    // The answer-bearing chunk has NO query-term overlap (synonym/value only).
    const md = '## Overview\nthe device ships in three colors\n## Details\nit weighs 1.2 kg'
    const ranked = rankPassages(md, 'how heavy is it', 10_000)
    // 'weighs' isn't a query term ('heavy' is), yet the chunk must survive.
    expect(ranked).toContain('1.2 kg')
    expect(ranked).toContain('three colors')
  })

  it('falls back to the document head when there is no lexical signal', () => {
    const md = 'plain text with no headings and nothing to match here'
    expect(rankPassages(md, 'what is it', 20)).toBe(md.slice(0, 20))
  })

  it('never exceeds the char budget by much', () => {
    const md = Array.from({ length: 30 }, (_, i) => `## H${i}\nprice price price detail ${i}`).join('\n')
    const ranked = rankPassages(md, 'price detail', 300)
    expect(ranked.length).toBeLessThanOrEqual(450)
  })
})

describe('hostOf', () => {
  it('lowercases and strips www', () => {
    expect(hostOf('https://WWW.Example.com/path')).toBe('example.com')
    expect(hostOf('https://docs.python.org/3/')).toBe('docs.python.org')
  })
  it('returns empty for an unparseable url', () => {
    expect(hostOf('not a url')).toBe('')
  })
})

describe('domainBonus', () => {
  it('favours official and primary sources over forums and farms', () => {
    expect(domainBonus('https://www.nasa.gov/page')).toBeGreaterThan(0)
    expect(domainBonus('https://docs.python.org/3/')).toBeGreaterThan(0)
    expect(domainBonus('https://en.wikipedia.org/wiki/X')).toBeGreaterThan(0)
    expect(domainBonus('https://reddit.com/r/x')).toBeLessThan(0)
    expect(domainBonus('https://ehow.com/how')).toBeLessThan(0)
    expect(domainBonus('https://some-random-blog.net/post')).toBe(0)
  })
})

describe('candidateScore', () => {
  it('ranks a term-matching authoritative result above a non-matching forum', () => {
    const terms = queryTerms('python list comprehension syntax')
    const good = candidateScore(
      { url: 'https://docs.python.org/3/tutorial', title: 'List comprehension syntax', snippet: 'python list comprehension', rank: 0 },
      terms
    )
    const bad = candidateScore(
      { url: 'https://reddit.com/r/random', title: 'my weekend', snippet: 'unrelated chatter', rank: 1 },
      terms
    )
    expect(good).toBeGreaterThan(bad)
  })

  it('uses the position prior to break ties', () => {
    const terms = queryTerms('hello world')
    const first = candidateScore({ url: 'https://x.com', title: 'hello world', snippet: '', rank: 0 }, terms)
    const fifth = candidateScore({ url: 'https://x.com', title: 'hello world', snippet: '', rank: 5 }, terms)
    expect(first).toBeGreaterThan(fifth)
  })
})
