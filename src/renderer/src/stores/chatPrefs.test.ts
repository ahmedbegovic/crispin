import { describe, expect, it } from 'vitest'
import { coercePersisted } from './chatPrefs'

const DEFAULTS = {
  textSize: 'default',
  width: 'standard',
  density: 'comfortable',
  codeWrap: false
} as const

describe('coercePersisted', () => {
  it('returns all defaults for empty / non-object input', () => {
    expect(coercePersisted(undefined)).toEqual(DEFAULTS)
    expect(coercePersisted(null)).toEqual(DEFAULTS)
    expect(coercePersisted('garbage')).toEqual(DEFAULTS)
    expect(coercePersisted({})).toEqual(DEFAULTS)
  })

  it('keeps a legacy blob that predates the density key and only fills density', () => {
    // The upgrade hazard: a saved blob from before density existed must NOT lose
    // its textSize/width/codeWrap just because the new key is missing.
    expect(coercePersisted({ textSize: 'large', width: 'wide', codeWrap: true })).toEqual({
      textSize: 'large',
      width: 'wide',
      density: 'comfortable',
      codeWrap: true
    })
  })

  it('defaults individual invalid fields without dropping the valid ones', () => {
    expect(
      coercePersisted({ textSize: 'huge', width: 'wide', density: 'cozy', codeWrap: true })
    ).toEqual({ textSize: 'default', width: 'wide', density: 'comfortable', codeWrap: true })
  })

  it('preserves a fully valid blob', () => {
    const valid = { textSize: 'small', width: 'standard', density: 'compact', codeWrap: false }
    expect(coercePersisted(valid)).toEqual(valid)
  })
})
