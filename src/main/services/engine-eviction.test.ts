import { describe, it, expect } from 'vitest'
import type { EngineModelInfo } from '@shared/types'
import { EMBEDDING_MODEL } from '@shared/model-tiers'
import { evictableLoaded } from './engine-eviction'

// Pure eviction policy — no Electron/engine deps.

const model = (id: string, state: EngineModelInfo['state']): EngineModelInfo => ({
  id,
  state,
  memoryGB: 1
})

describe('evictableLoaded', () => {
  it('returns the loaded chat models eligible for a force-unload', () => {
    const models = [model('a', 'loaded'), model('b', 'loaded')]
    expect(evictableLoaded(models, { protectEmbedder: true }).map((m) => m.id)).toEqual(['a', 'b'])
  })

  it('excludes the embedder while protecting it (a RAG ingest is in flight)', () => {
    const models = [model('a', 'loaded'), model(EMBEDDING_MODEL, 'loaded')]
    expect(evictableLoaded(models, { protectEmbedder: true }).map((m) => m.id)).toEqual(['a'])
  })

  it('INCLUDES the embedder when not protecting (no ingest) — it can be evicted to free RAM', () => {
    const models = [model('a', 'loaded'), model(EMBEDDING_MODEL, 'loaded')]
    expect(evictableLoaded(models, { protectEmbedder: false }).map((m) => m.id)).toEqual([
      'a',
      EMBEDDING_MODEL
    ])
  })

  it('excludes models that are not loaded', () => {
    const models = [model('a', 'loaded'), model('b', 'loading'), model('c', 'unloaded')]
    expect(evictableLoaded(models, { protectEmbedder: true }).map((m) => m.id)).toEqual(['a'])
  })

  it('excludes exceptRepoId (the model being loaded)', () => {
    const models = [model('a', 'loaded'), model('b', 'loaded')]
    expect(evictableLoaded(models, { exceptRepoId: 'b', protectEmbedder: true }).map((m) => m.id)).toEqual([
      'a'
    ])
  })

  it('excludes the protected embedder and exceptRepoId together', () => {
    const models = [model('a', 'loaded'), model('b', 'loaded'), model(EMBEDDING_MODEL, 'loaded')]
    expect(
      evictableLoaded(models, { exceptRepoId: 'a', protectEmbedder: true }).map((m) => m.id)
    ).toEqual(['b'])
  })
})
