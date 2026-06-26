import type { EngineModelInfo } from '@shared/types'
import { EMBEDDING_MODEL } from '@shared/model-tiers'

/**
 * The loaded models Crispin may force-unload through the engine's public
 * per-model unload endpoint. Never `exceptRepoId` (the model a swap is making
 * room for). The embedder is excluded ONLY while `protectEmbedder` is set —
 * i.e. while a RAG ingest is in flight: an in-flight /v1/embeddings holds an
 * `in_use` lease the public unload bypasses, and engineIdle() cannot see that
 * embed, so force-unloading mid-ingest would tear it down. When no ingest is
 * running the embedder is a normal eviction candidate, so a big load (e.g. the
 * noCoload ultra tier) can still reclaim its ~0.8 GB instead of being refused.
 */
export function evictableLoaded(
  models: EngineModelInfo[],
  opts: { exceptRepoId?: string; protectEmbedder: boolean }
): EngineModelInfo[] {
  return models.filter(
    (m) =>
      m.state === 'loaded' &&
      m.id !== opts.exceptRepoId &&
      !(opts.protectEmbedder && m.id === EMBEDDING_MODEL)
  )
}
