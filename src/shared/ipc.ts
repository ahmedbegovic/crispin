import { z } from 'zod'

// ---------------------------------------------------------------------------
// Schemas shared by methods and events
// ---------------------------------------------------------------------------

export const processStateSchema = z.enum([
  'stopped',
  'spawning',
  'waiting_healthy',
  'running',
  'unhealthy',
  'restarting',
  'failed'
])

export const processSnapshotSchema = z.object({
  name: z.string(),
  state: processStateSchema,
  port: z.number().nullable(),
  pid: z.number().nullable(),
  detail: z.string().optional()
})

export const systemStatusSchema = z.object({
  version: z.string(),
  dataDir: z.string(),
  processes: z.array(processSnapshotSchema)
})

// ---------------------------------------------------------------------------
// Method contract: renderer -> main request/response over `orion:call`.
// Every method is zod-validated on both sides of the bridge.
// ---------------------------------------------------------------------------

export const contract = {
  'system.status': {
    input: z.undefined(),
    output: systemStatusSchema
  },
  'system.restartProcess': {
    input: z.object({ name: z.string() }),
    output: z.object({ ok: z.boolean() })
  },
  'system.openLogs': {
    input: z.undefined(),
    output: z.object({ ok: z.boolean() })
  }
} as const

export type Contract = typeof contract
export type MethodName = keyof Contract
export type MethodInput<M extends MethodName> = z.infer<Contract[M]['input']>
export type MethodOutput<M extends MethodName> = z.infer<Contract[M]['output']>

/** Envelope returned by main for every `orion:call` invoke. */
export type CallResult<T> = { ok: true; data: T } | { ok: false; error: string }

// ---------------------------------------------------------------------------
// Event bus: main -> renderer over the single `orion:event` channel.
// ---------------------------------------------------------------------------

export const orionEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('system.processState'),
    process: processSnapshotSchema
  }),
  z.object({
    type: z.literal('system.toast'),
    level: z.enum(['info', 'warn', 'error']),
    message: z.string()
  })
])

export type OrionEvent = z.infer<typeof orionEventSchema>
export type OrionEventType = OrionEvent['type']
export type OrionEventOf<T extends OrionEventType> = Extract<OrionEvent, { type: T }>
