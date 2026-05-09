import { describe, expect, it } from 'vitest'

import { parseConfigNumberInput } from '@/components/config-manager/numeric-input'

describe('parseConfigNumberInput', () => {
  it('rejects blank required fields instead of coercing them to zero', () => {
    expect(parseConfigNumberInput('', {
      label: 'Port',
      min: 1,
      max: 65535,
      integer: true,
    })).toEqual({
      value: undefined,
      error: 'Port must be an integer between 1 and 65535',
    })
  })

  it('rejects partial integer strings before config save', () => {
    expect(parseConfigNumberInput('123abc', {
      label: 'Viewport width',
      min: 1,
      integer: true,
    })).toEqual({
      value: undefined,
      error: 'Viewport width must be an integer greater than or equal to 1',
    })
  })

  it('preserves optional blank numeric settings as undefined', () => {
    expect(parseConfigNumberInput('', {
      label: 'Effective resolution',
      min: 1,
      integer: true,
      allowEmpty: true,
      errorMessage: 'Effective resolution must be a positive integer',
    })).toEqual({
      value: undefined,
      error: null,
    })
  })

  it('parses bounded decimal settings exactly', () => {
    expect(parseConfigNumberInput('0.75', {
      label: 'Min trust',
      min: 0,
      max: 1,
    })).toEqual({
      value: 0.75,
      error: null,
    })

    expect(parseConfigNumberInput('1.2', {
      label: 'Min trust',
      min: 0,
      max: 1,
    })).toEqual({
      value: undefined,
      error: 'Min trust must be a number between 0 and 1',
    })
  })
})
