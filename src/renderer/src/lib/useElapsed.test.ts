import { describe, expect, it } from 'vitest'
import { elapsedSeconds } from './useElapsed'

describe('elapsedSeconds', () => {
  const startedAt = 1_000_000

  it('returns 0 when startedAt is null', () => {
    expect(elapsedSeconds(startedAt, null)).toBe(0)
  })

  it('returns 0 when startedAt is undefined', () => {
    expect(elapsedSeconds(startedAt, undefined)).toBe(0)
  })

  it('returns 0 for the same instant', () => {
    expect(elapsedSeconds(startedAt, startedAt)).toBe(0)
  })

  it('floors partial seconds', () => {
    expect(elapsedSeconds(startedAt + 1_500, startedAt)).toBe(1)
  })

  it('returns elapsed whole minutes in seconds', () => {
    expect(elapsedSeconds(startedAt + 60_000, startedAt)).toBe(60)
  })

  it('never returns a negative elapsed value', () => {
    expect(elapsedSeconds(startedAt - 1, startedAt)).toBe(0)
  })
})
