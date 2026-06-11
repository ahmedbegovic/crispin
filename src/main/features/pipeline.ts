import { handle } from '../ipc/router'
import type { PipelineService } from '../services/pipeline-service'

/** Registers every pipeline.* IPC method. */
export function registerPipelineFeature(pipeline: PipelineService): void {
  handle('pipeline.start', ({ sessionId, task, options }) =>
    pipeline.start(sessionId, task, options)
  )

  handle('pipeline.abort', async ({ pipelineId }) => {
    await pipeline.abort(pipelineId)
    return { ok: true }
  })

  handle('pipeline.approve', ({ pipelineId, approve }) => {
    pipeline.approve(pipelineId, approve)
    return { ok: true }
  })

  handle('pipeline.get', ({ sessionId }) => ({ pipeline: pipeline.get(sessionId) }))
}
