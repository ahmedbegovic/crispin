import { z } from 'zod'
import { scopedLogger } from './logger'

// The TS↔Python sidecar protocol is otherwise enforced only by hand-matched
// shapes: tools-client/engine-client cast each response with `as T` and nothing
// checks it. These schemas mirror the verified Python (crispin_tools routers) and
// oMLX responses; checkSidecar validates against them at the response seam so a
// renamed/removed field, a wrong type, or a new enum value surfaces LOUDLY in dev
// instead of silently producing `undefined` downstream. Mirrors the IPC output /
// event policy: dev-gated, log-and-send (never throw — a malformed status poll
// must not turn a live generation or download into a failure).
const log = scopedLogger('sidecar')

let validationEnabled = false

/** Enabled once at startup from `!app.isPackaged` (keeps the clients electron-free). */
export function enableSidecarValidation(enabled: boolean): void {
  validationEnabled = enabled
}

const firstIssue = (error: z.ZodError): string => {
  const issue = error.issues[0]
  if (!issue) return 'invalid'
  const path = issue.path.join('.')
  return path ? `${path}: ${issue.message}` : issue.message
}

/**
 * Validate a sidecar response against its contract schema and return it
 * unchanged. No-op unless validation is enabled (dev). On drift, log once and
 * still return the data — the caller's existing defensive handling stands.
 */
export function checkSidecar<T>(schema: z.ZodType<unknown>, data: T, ctx: string): T {
  if (validationEnabled) {
    const result = schema.safeParse(data)
    if (!result.success) {
      log.warn(`response ${ctx} drifted from contract: ${firstIssue(result.error)}`)
    }
  }
  return data
}

// --- crispin_tools (FastAPI) response shapes --------------------------------

const samplingSchema = z.object({
  temperature: z.number().nullable(),
  top_p: z.number().nullable(),
  top_k: z.number().nullable()
})

export const healthzSchema = z.object({
  status: z.string(),
  service: z.string(),
  version: z.string()
})

export const okSchema = z.object({ ok: z.boolean() })

export const jobIdSchema = z.object({ job_id: z.string() })

export const jobSnapshotSchema = z.object({
  id: z.string(),
  kind: z.string(),
  // The enum is the point: a new Python status value (jobs.py) drifts here.
  status: z.enum(['running', 'done', 'failed', 'cancelled']),
  progress: z.number(),
  detail: z.string(),
  error: z.string().nullable(),
  result: z.unknown(),
  data: z.record(z.string(), z.unknown())
})

export const localModelsSchema = z.object({
  models: z.array(
    z.object({
      repo_id: z.string(),
      size_bytes: z.number(),
      last_modified_ms: z.number().nullable(),
      context_length: z.number().nullable(),
      sampling: samplingSchema.nullable()
    })
  )
})

export const hubSearchSchema = z.object({
  results: z.array(
    z.object({
      repo_id: z.string(),
      downloads: z.number(),
      likes: z.number(),
      last_modified_ms: z.number().nullable()
    })
  )
})

export const extractResultSchema = z.object({
  markdown: z.string(),
  title: z.string().nullable(),
  kind: z.string(),
  image_url: z.string().nullable()
})

export const searchSchema = z.object({
  results: z.array(z.object({ title: z.string(), url: z.string(), snippet: z.string() })),
  backend: z.string()
})

export const imageSearchSchema = z.object({
  results: z.array(
    z.object({
      title: z.string(),
      image_url: z.string(),
      source_url: z.string(),
      width: z.number().nullable(),
      height: z.number().nullable()
    })
  )
})

export const visitResultSchema = z.object({
  markdown: z.string(),
  title: z.string().nullable(),
  url: z.string(),
  image_url: z.string().nullable()
})

export const newsFetchSchema = z.object({
  not_modified: z.boolean(),
  etag: z.string().nullable(),
  last_modified: z.string().nullable(),
  feed_title: z.string().nullable(),
  entries: z.array(
    z.object({
      guid: z.string(),
      title: z.string().nullable(),
      link: z.string().nullable(),
      published_ms: z.number().nullable(),
      summary: z.string().nullable(),
      image_url: z.string().nullable()
    })
  )
})

// POST /providers/lookup — structured fast paths (PyPI/npm/GitHub/arXiv). A miss
// or upstream failure returns ok:false (the caller degrades to generic search).
export const providerLookupSchema = z.object({
  ok: z.boolean(),
  source: z.string(),
  title: z.string().nullable(),
  summary: z.string(),
  url: z.string().nullable(),
  error: z.string().nullable()
})

export const ragQuerySchema = z.object({
  results: z.array(
    z.object({
      text: z.string(),
      doc_id: z.string(),
      title: z.string().nullable(),
      score: z.number(),
      chunk_index: z.number()
    })
  )
})

// --- oMLX engine response shapes --------------------------------------------
// Lenient by necessity: built-in pseudo-models (MarkItDown) legitimately omit
// source_repo_id/sizes, and the entry carries many oMLX-internal keys (stripped
// by zod). This catches STRUCTURAL drift (models not an array, entry not an
// object, id/status renamed or wrong-typed); a source_repo_id rename needs the
// dedicated post-upgrade contract test (recorded-response comparison).
export const engineModelsStatusSchema = z.object({
  models: z
    .array(
      z.object({
        id: z.string(),
        loaded: z.boolean().optional(),
        is_loading: z.boolean().optional(),
        estimated_size: z.number().nullable().optional(),
        actual_size: z.number().nullable().optional(),
        source_repo_id: z.string().nullable().optional()
      })
    )
    .optional()
})

export const engineApiStatusSchema = z.object({
  status: z.string(),
  active_requests: z.number().optional(),
  waiting_requests: z.number().optional(),
  models_loading: z.number().optional()
})

// POST /v1/models/discover — Crispin's patch to oMLX: a live re-scan of the HF
// cache that merges newly downloaded models into the running pool (no respawn),
// returning the post-scan pool summary. The id list is what the embedder/new-
// model post-check reads back via /v1/models/status; this just confirms the
// re-scan ran and the shape didn't drift.
export const engineDiscoverSchema = z.object({
  status: z.string(),
  models_discovered: z.number(),
  loaded_models: z.array(z.string())
})
