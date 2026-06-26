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
  it('returns the loaded models eligible for a force-unload', () => {
    const models = [model('a', 'loaded'), model('b', 'loaded')]
    expect(evictableLoaded(models).map((m) => m.id)).toEqual(['a', 'b'])
  })

  it('never includes the embedder — engineIdle() cannot see an in-flight embed', () => {
    const models = [model('a', 'loaded'), model(EMBEDDING_MODEL, 'loaded')]
    expect(evictableLoaded(models).map((m) => m.id)).toEqual(['a'])
  })

  it('excludes models that are not loaded', () => {
    const models = [model('a', 'loaded'), model('b', 'loading'), model('c', 'unloaded')]
    expect(evictableLoaded(models).map((m) => m.id)).toEqual(['a'])
  })

  it('excludes exceptRepoId (the model being loaded)', () => {
    const models = [model('a', 'loaded'), model('b', 'loaded')]
    expect(evictableLoaded(models, 'b').map((m) => m.id)).toEqual(['a'])
  })

  it('excludes the embedder and exceptRepoId together', () => {
    const models = [model('a', 'loaded'), model('b', 'loaded'), model(EMBEDDING_MODEL, 'loaded')]
    expect(evictableLoaded(models, 'a').map((m) => m.id)).toEqual(['b'])
  })
})
