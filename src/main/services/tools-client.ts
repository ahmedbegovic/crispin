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
}

export interface WebSearchEntry {
  title: string
  url: string
  snippet: string
}

export interface VisitResult {
  markdown: string
  title: string | null
  url: string
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

/** Typed client for the orion-tools FastAPI sidecar. Grows with each milestone. */
export class ToolsClient {
  constructor(private readonly baseUrl: () => string) {}

  private async request<T>(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    body?: unknown,
    signal?: AbortSignal
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
    return (await res.json()) as T
  }

  healthz(): Promise<{ status: string; service: string; version: string }> {
    return this.request('GET', '/healthz')
  }

  job<TData = unknown>(id: string): Promise<JobSnapshot<TData>> {
    return this.request('GET', `/jobs/${id}`)
  }

  cancelJob(id: string): Promise<{ ok: boolean }> {
    return this.request('POST', `/jobs/${id}/cancel`)
  }

  // --- models / HF cache -----------------------------------------------------

  downloadModel(repoId: string): Promise<{ job_id: string }> {
    return this.request('POST', '/models/download', { repo_id: repoId })
  }

  localModels(): Promise<{ models: LocalModelEntry[] }> {
    return this.request('GET', '/models/local')
  }

  /** repo_id contains a slash — the sidecar uses a path-typed param. */
  deleteModel(repoId: string): Promise<{ ok: boolean }> {
    return this.request('DELETE', `/models/${repoId}`)
  }

  searchModels(q: string): Promise<{ results: HubSearchEntry[] }> {
    return this.request('GET', `/models/search?q=${encodeURIComponent(q)}`)
  }

  // --- extraction / web (M2) --------------------------------------------------

  /** Sync — extraction is seconds, not a job. Exactly one of path|url. */
  extract(input: { path?: string; url?: string }, signal?: AbortSignal): Promise<ExtractResult> {
    return this.request('POST', '/extract', { path: input.path, url: input.url }, bounded(signal))
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
      bounded(signal)
    )
  }

  visit(url: string, maxChars = 12_000, signal?: AbortSignal): Promise<VisitResult> {
    return this.request('POST', '/visit', { url, max_chars: maxChars }, bounded(signal))
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
    return this.request('POST', '/rag/ingest', {
      collection_id: input.collectionId,
      doc_id: input.docId,
      markdown: input.markdown,
      title: input.title,
      embeddings_url: input.embeddingsUrl,
      embedding_model: input.embeddingModel,
      lancedb_dir: input.lancedbDir
    })
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
      bounded(signal)
    )
    return res.results
  }

  ragDeleteDoc(collectionId: string, docId: string, lancedbDir: string): Promise<{ ok: boolean }> {
    return this.request('POST', '/rag/delete_doc', {
      collection_id: collectionId,
      doc_id: docId,
      lancedb_dir: lancedbDir
    })
  }

  ragDropCollection(collectionId: string, lancedbDir: string): Promise<{ ok: boolean }> {
    return this.request('POST', '/rag/drop_collection', {
      collection_id: collectionId,
      lancedb_dir: lancedbDir
    })
  }
}
