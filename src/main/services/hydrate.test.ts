import { describe, it, expect, vi, beforeEach } from 'vitest'
import { z } from 'zod'

// ./logger imports electron; replace it so this loads under plain Node.
// vi.hoisted so the mock factory (hoisted above this file) can see `warn`.
const { warn } = vi.hoisted(() => ({ warn: vi.fn() }))
vi.mock('./logger', () => ({
  scopedLogger: () => ({ info: () => {}, warn, error: () => {} })
}))

import { parseOr, parseArrayDropInvalid, parseRecordDropInvalid } from './hydrate'

const Item = z.object({ n: z.number() })

beforeEach(() => warn.mockClear())

describe('parseOr', () => {
  it('returns the validated value when it matches the schema', () => {
    expect(parseOr(Item, { n: 5 }, { n: 0 }, 'ctx')).toEqual({ n: 5 })
    expect(warn).not.toHaveBeenCalled()
  })

  it('returns the fallback and logs once when the value violates the schema', () => {
    expect(parseOr(Item, { n: 'oops' }, { n: 0 }, 'ctx.field')).toEqual({ n: 0 })
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0][0]).toContain('ctx.field')
  })

  it('supports a nullable schema with a null fallback', () => {
    expect(parseOr(Item.nullable(), 'garbage', null, 'ctx')).toBeNull()
  })
})

describe('parseArrayDropInvalid', () => {
  it('keeps valid elements and drops invalid ones', () => {
    const out = parseArrayDropInvalid(Item, [{ n: 1 }, { n: 'x' }, { n: 3 }], 'parts')
    expect(out).toEqual([{ n: 1 }, { n: 3 }])
    expect(warn).toHaveBeenCalledTimes(1) // one drop
  })

  it('returns [] for a non-array value', () => {
    expect(parseArrayDropInvalid(Item, { not: 'array' }, 'parts')).toEqual([])
  })

  it('returns [] without logging for null (an empty/absent column)', () => {
    expect(parseArrayDropInvalid(Item, null, 'parts')).toEqual([])
    expect(warn).not.toHaveBeenCalled()
  })
})

describe('parseRecordDropInvalid', () => {
  const Key = z.enum(['low', 'high'])

  it('keeps entries with a valid key and value, drops the rest, logs each drop', () => {
    const out = parseRecordDropInvalid(z.string(), z.boolean(), { a: true, b: 'no', c: false }, 'rec')
    expect(out).toEqual({ a: true, c: false }) // b dropped (non-boolean value)
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('drops entries whose key is outside the key schema', () => {
    const out = parseRecordDropInvalid(Key, z.string(), { low: 'x', bogus: 'y' }, 'rec')
    expect(out).toEqual({ low: 'x' }) // bogus key dropped, valid pick preserved
  })

  it('returns {} for a non-object (and null) value', () => {
    expect(parseRecordDropInvalid(z.string(), z.boolean(), 'nope', 'rec')).toEqual({})
    expect(parseRecordDropInvalid(z.string(), z.boolean(), null, 'rec')).toEqual({})
  })
})
