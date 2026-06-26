import { extname, join } from 'node:path'
import { collectionSchema, libraryDocSchema, type CrispinEvent } from '@shared/ipc'
import type { Collection, LibraryDoc, LibraryDocStatus } from '@shared/types'
import { EMBEDDING_MODEL } from '@shared/model-tiers'
import type { CrispinDatabase } from './db'
import { engineModelId } from './engine-client'
import type { ToolsClient } from './tools-client'
import type { ProcessManager } from './process-manager'
import { dataDir } from './paths'
import { scopedLogger } from './logger'
import { parseArrayDropInvalid } from './hydrate'

// Re-exported for consumers that reach the embedder through the library.
export { EMBEDDING_MODEL }

const JOB_POLL_MS = 750
const ENGINE_WAIT_TIMEOUT_MS = 180_000

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

interface CollectionRow {
  id: string
  name: string
  kind: 'library' | 'notebook'
  created_at: number
  doc_count: number
}

interface DocRow {
  id: string
  collection_id: string
  title: string | null
  source: string
  kind: string
  status: LibraryDocStatus
  error: string | null
  chunk_count: number
  created_at: number
}

const rowToDoc = (row: DocRow): LibraryDoc => ({
  id: row.id,
  collectionId: row.collection_id,
  title: row.title,
  source: row.source,
  kind: row.kind,
  status: row.status,
  error: row.error,
  chunkCount: row.chunk_count,
  createdAt: row.created_at
})

const kindFromSource = (path?: string, url?: string): string => {
  if (url) return 'url'
  const ext = extname(path ?? '').slice(1).toLowerCase()
  return ext || 'txt'
}

export interface LibraryServiceDeps {
  db: CrispinDatabase
  tools: ToolsClient
  processManager: ProcessManager
  getEnginePort: () => number
  /** Whether the engine chat registry would be non-empty (the embedder never counts). */
  hasRegistryModels: () => boolean
  /** Make a freshly downloaded embedder discoverable via an idle-gated engine restart. */
  discoverEmbedder: () => Promise<{ ok: boolean; reason?: string }>
  broadcast: (event: CrispinEvent) => void
}

/**
 * Owns collections + library_docs and the extract → embed → index pipeline.
 * lancedb tables live in the tools sidecar; this service chains its jobs and
 * keeps the SQLite rows (the renderer's source of truth) in sync.
 */
export class LibraryService {
  private disposed = false
  /** docId → tools job id for every rag-ingest we're actively polling. */
  private readonly activeIngests = new Map<string, string>()
  private readonly log = scopedLogger('library')

  constructor(private readonly deps: LibraryServiceDeps) {}

  init(): void {
    // Ingests from a previous app run died with their pollers — surface that.
    this.deps.db
      .prepare(
        "UPDATE library_docs SET status = 'failed', error = 'interrupted by app restart' WHERE status IN ('pending', 'ingesting')"
      )
      .run()
  }

  dispose(): void {
    this.disposed = true
  }

  /** True while any rag-ingest job is embedding — gates the engine's eviction of the embedder. */
  isIngesting(): boolean {
    return this.activeIngests.size > 0
  }

  embeddingsUrl(): string {
    return `http://127.0.0.1:${this.deps.getEnginePort()}/v1/embeddings`
  }

  lancedbDir(): string {
    return join(dataDir(), 'lancedb')
  }

  // --- collections ------------------------------------------------------------

  collections(): Collection[] {
    const rows = this.deps.db
      .prepare(
        `SELECT c.*, COUNT(d.id) AS doc_count FROM collections c
         LEFT JOIN library_docs d ON d.collection_id = c.id
         GROUP BY c.id ORDER BY c.created_at DESC`
      )
      .all() as unknown as CollectionRow[]
    return parseArrayDropInvalid(
      collectionSchema,
      rows.map((r) => ({
        id: r.id,
        name: r.name,
        kind: r.kind,
        docCount: r.doc_count,
        createdAt: r.created_at
      })),
      'library.collections'
    )
  }

  createCollection(name: string): Collection {
    const id = crypto.randomUUID()
    const createdAt = Date.now()
    this.deps.db
      .prepare('INSERT INTO collections (id, name, created_at) VALUES (?, ?, ?)')
      .run(id, name, createdAt)
    return { id, name, kind: 'library', docCount: 0, createdAt }
  }

  async deleteCollection(collectionId: string): Promise<void> {
    // A still-running ingest job would re-create the dropped table afterwards.
    for (const docId of [...this.activeIngests.keys()]) {
      if (this.getDoc(docId)?.collectionId === collectionId) await this.cancelIngest(docId)
    }
    try {
      await this.deps.tools.ragDropCollection(collectionId, this.lancedbDir())
    } catch (err) {
      // The lancedb table is orphaned junk at worst — the rows still go.
      this.log.warn(`rag cleanup failed: ${err instanceof Error ? err.message : err}`)
    }
    this.deps.db.prepare('DELETE FROM collections WHERE id = ?').run(collectionId) // docs cascade
    // No FK backs conversations.collection_id — clear it by hand, or those
    // conversations keep offering rag_search against the dropped table.
    this.deps.db
      .prepare('UPDATE conversations SET collection_id = NULL WHERE collection_id = ?')
      .run(collectionId)
  }

  // --- docs ----------------------------------------------------------------------

  docs(collectionId: string): LibraryDoc[] {
    const rows = this.deps.db
      .prepare('SELECT * FROM library_docs WHERE collection_id = ? ORDER BY created_at DESC')
      .all(collectionId) as unknown as DocRow[]
    return parseArrayDropInvalid(libraryDocSchema, rows.map(rowToDoc), 'library.docs')
  }

  getDoc(docId: string): LibraryDoc | null {
    const row = this.deps.db.prepare('SELECT * FROM library_docs WHERE id = ?').get(docId) as
      | DocRow
      | undefined
    return row ? rowToDoc(row) : null
  }

  async deleteDoc(docId: string): Promise<void> {
    const doc = this.getDoc(docId)
    if (!doc) return
    // Cancel before cleanup: a still-running ingest job would re-add the
    // doc's chunks after ragDeleteDoc, resurrecting them invisibly.
    await this.cancelIngest(docId)
    try {
      await this.deps.tools.ragDeleteDoc(doc.collectionId, docId, this.lancedbDir())
    } catch (err) {
      this.log.warn(`rag cleanup failed: ${err instanceof Error ? err.message : err}`)
    }
    this.deps.db.prepare('DELETE FROM library_docs WHERE id = ?').run(docId)
  }

  /**
   * Returns the docId immediately; the pipeline runs detached and reports via
   * library.docStatus events at every transition.
   */
  ingest(input: { collectionId: string; path?: string; url?: string }): string {
    if (!input.path && !input.url) throw new Error('ingest needs a path or url')
    // Throws on unknown collection before we commit to a doc row.
    const exists = this.deps.db
      .prepare('SELECT id FROM collections WHERE id = ?')
      .get(input.collectionId)
    if (!exists) throw new Error(`No such collection: ${input.collectionId}`)

    const docId = crypto.randomUUID()
    this.deps.db
      .prepare(
        `INSERT INTO library_docs (id, collection_id, source, kind, status, created_at)
         VALUES (?, ?, ?, ?, 'pending', ?)`
      )
      .run(docId, input.collectionId, input.url ?? input.path!, kindFromSource(input.path, input.url), Date.now())
    this.broadcastDoc(docId)
    void this.runPipeline(docId, input).catch((err) => {
      this.log.warn(`ingest pipeline crashed: ${err instanceof Error ? err.message : err}`)
    })
    return docId
  }

  /** extract → ensure embedder + engine → rag ingest job → poll → ready/failed. */
  private async runPipeline(
    docId: string,
    input: { collectionId: string; path?: string; url?: string }
  ): Promise<void> {
    try {
      const extracted = await this.deps.tools.extract({ path: input.path, url: input.url })
      this.update(docId, {
        status: 'ingesting',
        title: extracted.title,
        kind: extracted.kind || undefined
      })
      this.broadcastDoc(docId)

      await this.ensureEmbeddingModel()
      await this.ensureEngineRunning()
      if (this.disposed) return

      const { job_id } = await this.deps.tools.ragIngest({
        collectionId: input.collectionId,
        docId,
        markdown: extracted.markdown,
        title: extracted.title,
        embeddingsUrl: this.embeddingsUrl(),
        embeddingModel: engineModelId(EMBEDDING_MODEL),
        lancedbDir: this.lancedbDir()
      })
      this.activeIngests.set(docId, job_id)

      try {
        for (;;) {
          await sleep(JOB_POLL_MS)
          if (this.disposed) return
          const job = await this.deps.tools.job(job_id)
          if (job.status === 'running') continue
          if (job.status === 'done') {
            if (!this.getDoc(docId)) {
              // deleteDoc/deleteCollection raced the job's lancedb write and
              // its chunks were re-added after cleanup — purge them again.
              await this.deps.tools
                .ragDeleteDoc(input.collectionId, docId, this.lancedbDir())
                .catch((err) =>
                  this.log.warn(`rag cleanup failed: ${err instanceof Error ? err.message : err}`)
                )
            } else {
              const result = (job.result ?? {}) as { chunks?: number }
              this.update(docId, { status: 'ready', chunkCount: result.chunks ?? 0 })
            }
          } else {
            this.update(docId, { status: 'failed', error: job.error ?? `ingest job ${job.status}` })
          }
          break
        }
      } finally {
        this.activeIngests.delete(docId)
      }
    } catch (err) {
      this.update(docId, {
        status: 'failed',
        error: err instanceof Error ? err.message : String(err)
      })
    }
    this.broadcastDoc(docId)
  }

  /** Best-effort cancel of a doc's in-flight rag-ingest job, if any. */
  private async cancelIngest(docId: string): Promise<void> {
    const jobId = this.activeIngests.get(docId)
    if (!jobId) return
    try {
      await this.deps.tools.cancelJob(jobId)
    } catch (err) {
      this.log.warn(`ingest cancel failed: ${err instanceof Error ? err.message : err}`)
    }
  }

  /**
   * The engine runs offline, so the embedder must be in the HF cache before
   * the first embed. Download through the tools sidecar when missing — and
   * because oMLX discovers cache models at startup only, a freshly downloaded
   * embedder is invisible to an already-running engine until a restart.
   */
  async ensureEmbeddingModel(): Promise<void> {
    const { models } = await this.deps.tools.localModels()
    if (models.some((m) => m.repo_id === EMBEDDING_MODEL)) return
    this.log.info(`downloading ${EMBEDDING_MODEL}`)
    const { job_id } = await this.deps.tools.downloadModel(EMBEDDING_MODEL)
    for (;;) {
      await sleep(JOB_POLL_MS)
      if (this.disposed) throw new Error('app is shutting down')
      const job = await this.deps.tools.job(job_id)
      if (job.status === 'running') continue
      if (job.status !== 'done') {
        throw new Error(`embedding model download ${job.status}: ${job.error ?? 'unknown error'}`)
      }
      break
    }
    // oMLX discovers cache models at spawn only, so the running engine must
    // restart to serve the freshly downloaded embedder. ModelService owns that
    // restart and idle-gates it, so it never kills an in-flight generation on
    // another surface (chat/research/news/agent) — unlike the old unconditional
    // restart that ran here.
    const discovered = await this.deps.discoverEmbedder()
    if (!discovered.ok) {
      throw new Error(discovered.reason ?? 'could not make the embedding model available')
    }
  }

  /**
   * /v1/embeddings resolves through the same startup-time discovery and
   * memory guard as chat models under oMLX. Mirrors ModelService's wait loop;
   * load orchestration stays ModelService's job, this only guarantees the
   * HTTP server is up.
   */
  async ensureEngineRunning(): Promise<void> {
    const engine = this.deps.processManager.get('engine')
    if (!engine) throw new Error('engine process is not registered')
    const state = engine.snapshot().state
    if (state === 'running') return
    if (state === 'stopped' || state === 'failed') {
      // An empty-registry spawn exits 2 and crash-loops into 'failed' — fail
      // the doc with something actionable instead of starting the engine.
      if (!this.deps.hasRegistryModels()) {
        throw new Error(
          'a chat model must be downloaded before documents can be embedded — the engine cannot start with an empty registry'
        )
      }
      await engine.start()
    }
    const deadline = Date.now() + ENGINE_WAIT_TIMEOUT_MS
    while (Date.now() < deadline) {
      if (this.disposed) throw new Error('app is shutting down')
      if (engine.snapshot().state === 'running') return
      if (engine.snapshot().state === 'failed') throw new Error('engine failed to start')
      await sleep(500)
    }
    throw new Error('engine did not become ready in time')
  }

  private update(
    docId: string,
    fields: {
      status?: LibraryDocStatus
      title?: string | null
      kind?: string
      error?: string | null
      chunkCount?: number
    }
  ): void {
    const sets: string[] = []
    const values: Array<string | number | null> = []
    const set = (column: string, value: string | number | null): void => {
      sets.push(`${column} = ?`)
      values.push(value)
    }
    if (fields.status !== undefined) set('status', fields.status)
    if (fields.title !== undefined) set('title', fields.title)
    if (fields.kind !== undefined) set('kind', fields.kind)
    if (fields.error !== undefined) set('error', fields.error)
    if (fields.chunkCount !== undefined) set('chunk_count', fields.chunkCount)
    if (sets.length === 0) return
    values.push(docId)
    this.deps.db.prepare(`UPDATE library_docs SET ${sets.join(', ')} WHERE id = ?`).run(...values)
  }

  private broadcastDoc(docId: string): void {
    if (this.disposed) return
    const doc = this.getDoc(docId)
    if (doc) this.deps.broadcast({ type: 'library.docStatus', doc })
  }
}
