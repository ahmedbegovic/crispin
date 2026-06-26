import type { ZodError, ZodType } from 'zod'
import { scopedLogger } from './logger'

// Boundary validation for data read from an UNTYPED source — a SQLite row, a
// JSON column, a settings blob — before it is handed back as a contract-typed
// value (an IPC output or a broadcast event). TypeScript guarantees the static
// shape; these helpers are the runtime backstop at the one place the value
// crosses from `unknown` into the contract, so a stale/corrupt row degrades to
// a safe default instead of failing the whole IPC response (dev output.parse)
// or shipping a malformed shape to the renderer (prod).
const log = scopedLogger('hydrate')

const firstIssue = (error: ZodError): string => {
  const issue = error.issues[0]
  if (!issue) return 'invalid'
  const path = issue.path.join('.')
  return path ? `${path}: ${issue.message}` : issue.message
}

/**
 * Validate one stored value against the contract schema it must satisfy. On
 * drift, log once with context and return the fallback.
 */
export function parseOr<T>(schema: ZodType<T>, value: unknown, fallback: T, ctx: string): T {
  const result = schema.safeParse(value)
  if (result.success) return result.data
  log.warn(`${ctx}: ${firstIssue(result.error)} — using fallback`)
  return fallback
}

/**
 * Validate each element of a stored array against the contract schema; keep the
 * valid ones, drop + log the invalid ones. One corrupt element never kills the
 * whole array (a single malformed message part can't make a conversation refuse
 * to open). A non-array value degrades to [].
 */
export function parseArrayDropInvalid<T>(elem: ZodType<T>, value: unknown, ctx: string): T[] {
  if (!Array.isArray(value)) {
    if (value != null) log.warn(`${ctx}: not an array — using []`)
    return []
  }
  const out: T[] = []
  value.forEach((item, i) => {
    const result = elem.safeParse(item)
    if (result.success) out.push(result.data)
    else log.warn(`${ctx}[${i}]: ${firstIssue(result.error)} — dropping`)
  })
  return out
}

/**
 * Validate each entry of a stored record/map against the key + value schemas;
 * keep the valid pairs, drop + log the rest. The record analogue of
 * parseArrayDropInvalid: one corrupt or stale-keyed entry never collapses the
 * whole map (so a single drifted module/tier key can't wipe every other pick).
 * A non-object value degrades to {}.
 */
export function parseRecordDropInvalid<K extends string, V>(
  keySchema: ZodType<K>,
  valueSchema: ZodType<V>,
  value: unknown,
  ctx: string
): Partial<Record<K, V>> {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    if (value != null) log.warn(`${ctx}: not a record — using {}`)
    return {}
  }
  const out: Partial<Record<K, V>> = {}
  for (const [key, raw] of Object.entries(value)) {
    const keyResult = keySchema.safeParse(key)
    const valueResult = valueSchema.safeParse(raw)
    if (keyResult.success && valueResult.success) out[keyResult.data] = valueResult.data
    else log.warn(`${ctx}[${key}]: dropping invalid entry`)
  }
  return out
}
