import { describe, expect, it } from 'vitest'
import { detectProvider } from './search-providers-core'

describe('detectProvider', () => {
  it('detects an arXiv id (with or without the word)', () => {
    expect(detectProvider('summarize arxiv 2401.16745')).toEqual({ kind: 'arxiv', name: '2401.16745' })
    expect(detectProvider('what is arxiv:2503.09516 about')).toEqual({
      kind: 'arxiv',
      name: '2503.09516'
    })
    expect(detectProvider('explain the arxiv paper 2505.04588v2')).toEqual({
      kind: 'arxiv',
      name: '2505.04588'
    })
  })

  it('does not treat a bare number as arXiv without the cue', () => {
    expect(detectProvider('what happened in 2024.12345')).toBeNull()
  })

  it('detects a GitHub release query (bare owner/repo or URL) with intent', () => {
    expect(detectProvider('latest release of facebook/react on github')).toEqual({
      kind: 'github_release',
      owner: 'facebook',
      repo: 'react'
    })
    expect(detectProvider('what is the newest version at github.com/openai/whisper')).toEqual({
      kind: 'github_release',
      owner: 'openai',
      repo: 'whisper'
    })
    expect(detectProvider('github vercel/next.js latest tag')).toEqual({
      kind: 'github_release',
      owner: 'vercel',
      repo: 'next.js'
    })
  })

  it('does not hijack a plain github repo read (no release intent)', () => {
    expect(detectProvider('summarize github.com/openai/whisper')).toBeNull()
  })

  it('detects PyPI version/release queries (ecosystem cue + intent)', () => {
    expect(detectProvider('latest version of numpy on pypi')).toEqual({ kind: 'pypi', name: 'numpy' })
    expect(detectProvider('pypi fastapi latest release')).toEqual({ kind: 'pypi', name: 'fastapi' })
    expect(detectProvider('what version does pip install requests pull')).toEqual({
      kind: 'pypi',
      name: 'requests'
    })
  })

  it('detects npm version/release queries (intent; scoped @org/name allowed)', () => {
    expect(detectProvider('latest version of express on npm')).toEqual({ kind: 'npm', name: 'express' })
    expect(detectProvider('npm react newest version')).toEqual({ kind: 'npm', name: 'react' })
    expect(detectProvider('npm @types/node latest version')).toEqual({
      kind: 'npm',
      name: '@types/node'
    })
  })

  it('does NOT hijack a troubleshooting prompt (ecosystem cue but no version intent)', () => {
    expect(detectProvider('why does npm install sharp fail on macOS')).toBeNull()
    expect(detectProvider('pip install requests')).toBeNull()
    expect(detectProvider('how do I npm install react in a monorepo')).toBeNull()
  })

  it('returns null for ambiguous "latest version of X" without an ecosystem cue', () => {
    expect(detectProvider('what is the latest version of react')).toBeNull()
    expect(detectProvider('how do I update a row in SQL')).toBeNull()
  })

  it('returns null for code blocks and empty input', () => {
    expect(detectProvider('```\npip install requests\n```')).toBeNull()
    expect(detectProvider('   ')).toBeNull()
  })
})
