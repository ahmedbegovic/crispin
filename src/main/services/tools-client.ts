import type { ZodType } from 'zod'
import {
  checkSidecar,
  extractResultSchema,
  healthzSchema,
  hubSearchSchema,
  imageSearchSchema,
  jobIdSchema,
  jobSnapshotSchema,
  localModelsSchema,
  newsFetchSchema,
  okSchema,
  ragQuerySchema,
  searchSchema,
  visitResultSchema
} from './sidecar-contract'

export interface JobSnapshot<TData = unknown> {
  id: string
  kind: string
  status: 'running' | 'done' | 'failed' | 'cancelled'
  /** 0..1, or -1 when indeterminate. */
  progress: number
  detail?: string
  error?: string | null
  /** Job-kind-specific live payload (e.g. download byte counts). */
  data?: TData
  result?: unknown
}

export interface DownloadJobData {
  repo_id: string
  bytes_done: number
  bytes_total: number | null
}

export interface LocalModelEntry {
  repo_id: string
  size_bytes: number
  last_modified_ms: number | null
  /** max_position_embeddings from the snapshot's config.json; null if unreadable. */
  context_length: number | null
  /** Recommended sampling from generation_config.json; null if absent. */
  sampling: { temperature: number | null; top_p: number | null; top_k: number | null } | null
}

export interface HubSearchEntry {
  repo_id: string
  downloads: number
  likes: number
  last_modified_ms: number | null
}

export interface ExtractResult {
  markdown: string
  title: string | null
  kind: string
  /** og:image for url/html extractions; null for file kinds. */
  image_url: string | null
}

export interface WebSearchEntry {
  title: string
  url: string
  snippet: string
}

export interface ImageSearchEntry {
  title: string
  /** Direct image URL (https-only — the renderer blocks other schemes). */
  image_url: string
  /** Page the image came from. */
  source_url: string
  width: number | null
  height: number | null
}

export interface VisitResult {
  markdown: string
  title: string | null
  url: string
  /** og:image when the page declares one (absolute http(s) only). */
  image_url: string | null
}

export interface NewsFeedEntry {
  guid: string
  title: string | null
  link: string | null
  published_ms: number | null
  summary: string | null
  /** RSS media:thumbnail / image media:content / image enclosure. */
  image_url: string | null
}

export interface NewsFetchResult {
  not_modified: boolean
  /** Echoed back on 304; the response headers' values otherwise. */
  etag: string | null
  last_modified: string | null
  feed_title: string | null
  entries: NewsFeedEntry[]
}

export interface RagQueryHit {
  text: string
  doc_id: string
  title: string | null
  score: number
  chunk_index: number
}

/** Chat-loop endpoints are bounded: a stalled sidecar request must not wedge a generation. */
const SYNC_FETCH_TIMEOUT_MS = 60_000

const bounded = (signal?: AbortSignal): AbortSignal =>
  AbortSignal.any([AbortSignal.timeout(SYNC_FETCH_TIMEOUT_MS), ...(signal ? [signal] : [])])

/** Typed client for the crispin-tools FastAPI sidecar. Grows with each milestone. */
export class ToolsClient {
  constructor(private readonly baseUrl: () => string) {}

  private async request<T>(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    body?: unknown,
    signal?: AbortSignal,
    schema?: ZodType<unknown>
  ): Promise<T> {
    const res = await fetch(`${this.baseUrl()}${path}`, {
      method,
      headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`tools ${method} ${path} → ${res.status}: ${text.slice(0, 300)}`)
    }
    const data = (await res.json()) as T
    // Dev-gated contract check at the response seam (no-op in prod).
    return schema ? checkSidecar(schema, data, path) : data
  }

  healthz(): Promise<{ status: string; service: string; version: string }> {
    return this.request('GET', '/healthz', undefined, undefined, healthzSchema)
  }

  job<TData = unknown>(id: string): Promise<JobSnapshot<TData>> {
    return this.request('GET', `/jobs/${id}`, undefined, undefined, jobSnapshotSchema)
  }

  cancelJob(id: string): Promise<{ ok: boolean }> {
    return this.request('POST', `/jobs/${id}/cancel`, undefined, undefined, okSchema)
  }

  // --- models / HF cache -----------------------------------------------------

  downloadModel(repoId: string): Promise<{ job_id: string }> {
    return this.request('POST', '/models/download', { repo_id: repoId }, undefined, jobIdSchema)
  }

  localModels(): Promise<{ models: LocalModelEntry[] }> {
    return this.request('GET', '/models/local', undefined, undefined, localModelsSchema)
  }

  /** repo_id contains a slash — the sidecar uses a path-typed param. */
  deleteModel(repoId: string): Promise<{ ok: boolean }> {
    return this.request('DELETE', `/models/${repoId}`, undefined, undefined, okSchema)
  }

  searchModels(q: string): Promise<{ results: HubSearchEntry[] }> {
    return this.request(
      'GET',
      `/models/search?q=${encodeURIComponent(q)}`,
      undefined,
      undefined,
      hubSearchSchema
    )
  }

  // --- extraction / web (M2) --------------------------------------------------

  /** Sync — extraction is seconds, not a job. Exactly one of path|url. */
  extract(input: { path?: string; url?: string }, signal?: AbortSignal): Promise<ExtractResult> {
    return this.request(
      'POST',
      '/extract',
      { path: input.path, url: input.url },
      bounded(signal),
      extractResultSchema
    )
  }

  search(
    input: {
      query: string
      maxResults?: number
      backend?: 'auto' | 'searxng' | 'ddgs'
      searxngUrl?: string
    },
    signal?: AbortSignal
  ): Promise<{ results: WebSearchEntry[]; backend: string }> {
    return this.request(
      'POST',
      '/search',
      {
        query: input.query,
        max_results: input.maxResults ?? 5,
        backend: input.backend ?? 'auto',
        searxng_url: input.searxngUrl
      },
      bounded(signal),
      searchSchema
    )
  }

  searchImages(
    input: { query: string; maxResults?: number },
    signal?: AbortSignal
  ): Promise<{ results: ImageSearchEntry[] }> {
    return this.request(
      'POST',
      '/search_images',
      { query: input.query, max_results: input.maxResults ?? 6 },
      bounded(signal),
      imageSearchSchema
    )
  }

  // Default matches the sidecar's VisitRequest.max_chars and the pipeline's
  // VISIT_MAX_CHARS (20k); the old 12k default silently capped model-loop page
  // reads 8k chars shorter than harness-driven ones.
  visit(url: string, maxChars = 20_000, signal?: AbortSignal): Promise<VisitResult> {
    return this.request(
      'POST',
      '/visit',
      { url, max_chars: maxChars },
      bounded(signal),
      visitResultSchema
    )
  }

  // --- news (M6) ----------------------------------------------------------------

  /** Sync — one conditional GET + parse. Pass the stored etag/lastModified or null. */
  newsFetch(
    input: { url: string; etag: string | null; lastModified: string | null },
    signal?: AbortSignal
  ): Promise<NewsFetchResult> {
    return this.request(
      'POST',
      '/news/fetch',
      { url: input.url, etag: input.etag, last_modified: input.lastModified },
      bounded(signal),
      newsFetchSchema
    )
  }

  // --- RAG ----------------------------------------------------------------------

  ragIngest(input: {
    collectionId: string
    docId: string
    markdown: string
    title: string | null
    embeddingsUrl: string
    embeddingModel: string
    lancedbDir: string
  }): Promise<{ job_id: string }> {
    return this.request(
      'POST',
      '/rag/ingest',
      {
        collection_id: input.collectionId,
        doc_id: input.docId,
        markdown: input.markdown,
        title: input.title,
        embeddings_url: input.embeddingsUrl,
        embedding_model: input.embeddingModel,
        lancedb_dir: input.lancedbDir
      },
      undefined,
      jobIdSchema
    )
  }

  async ragQuery(
    input: {
      collectionId: string
      query: string
      k?: number
      embeddingsUrl: string
      embeddingModel: string
      lancedbDir: string
    },
    signal?: AbortSignal
  ): Promise<RagQueryHit[]> {
    const res = await this.request<{ results: RagQueryHit[] }>(
      'POST',
      '/rag/query',
      {
        collection_id: input.collectionId,
        query: input.query,
        k: input.k ?? 6,
        embeddings_url: input.embeddingsUrl,
        embedding_model: input.embeddingModel,
        lancedb_dir: input.lancedbDir
      },
      bounded(signal),
      ragQuerySchema
    )
    return res.results
  }

  ragDeleteDoc(collectionId: string, docId: string, lancedbDir: string): Promise<{ ok: boolean }> {
    return this.request(
      'POST',
      '/rag/delete_doc',
      { collection_id: collectionId, doc_id: docId, lancedb_dir: lancedbDir },
      undefined,
      okSchema
    )
  }

  ragDropCollection(collectionId: string, lancedbDir: string): Promise<{ ok: boolean }> {
    return this.request(
      'POST',
      '/rag/drop_collection',
      { collection_id: collectionId, lancedb_dir: lancedbDir },
      undefined,
      okSchema
    )
  }
}
