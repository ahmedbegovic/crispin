import { describe, expect, it } from 'vitest'
import { dateBucket } from './format'

describe('dateBucket', () => {
  // Fixed "now": Wed 2026-06-24 14:30 local time.
  const now = new Date(2026, 5, 24, 14, 30, 0).getTime()
  const at = (y: number, m: number, d: number, h = 12): number => new Date(y, m, d, h).getTime()

  it('buckets anything from local midnight onward as Today', () => {
    expect(dateBucket(now, now)).toBe('Today')
    expect(dateBucket(new Date(2026, 5, 24, 0, 0, 0).getTime(), now)).toBe('Today')
    // A future-ish stamp later the same day is still Today, not a wrong bucket.
    expect(dateBucket(new Date(2026, 5, 24, 23, 59, 0).getTime(), now)).toBe('Today')
  })

  it('buckets the previous calendar day as Yesterday regardless of time of day', () => {
    expect(dateBucket(at(2026, 5, 23, 1), now)).toBe('Yesterday')
    expect(dateBucket(at(2026, 5, 23, 23), now)).toBe('Yesterday')
  })

  it('buckets 2–7 days back as Previous 7 Days', () => {
    expect(dateBucket(at(2026, 5, 22), now)).toBe('Previous 7 Days')
    expect(dateBucket(at(2026, 5, 18), now)).toBe('Previous 7 Days')
  })

  it('buckets 8–30 days back as Previous 30 Days', () => {
    expect(dateBucket(at(2026, 5, 10), now)).toBe('Previous 30 Days')
    expect(dateBucket(at(2026, 4, 26), now)).toBe('Previous 30 Days')
  })

  it('buckets anything older as Older', () => {
    expect(dateBucket(at(2026, 4, 1), now)).toBe('Older')
    expect(dateBucket(at(2025, 11, 31), now)).toBe('Older')
  })
})
