import type { EngineModelInfo } from '@shared/types'
import { EMBEDDING_MODEL } from '@shared/model-tiers'

/**
 * The loaded models Crispin may force-unload through the engine's public
 * per-model unload endpoint. NEVER the embedder: an in-flight /v1/embeddings
 * holds an `in_use` lease the public unload bypasses, and engineIdle() cannot
 * see that embed (it has no inflight counter and registers in no /api/status
 * bucket) — so unloading it would tear an active RAG embed down. The engine's
 * own lease-aware TTL/LRU owns the embedder's lifecycle instead. Also never
 * `exceptRepoId` (the model a swap is making room for).
 */
export function evictableLoaded(
  models: EngineModelInfo[],
  exceptRepoId?: string
): EngineModelInfo[] {
  return models.filter(
    (m) => m.state === 'loaded' && m.id !== EMBEDDING_MODEL && m.id !== exceptRepoId
  )
}
