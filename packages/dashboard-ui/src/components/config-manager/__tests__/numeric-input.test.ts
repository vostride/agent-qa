import { afterEach, describe, expect, it } from 'vitest'

import { parseConfigNumberInput } from '@/components/config-manager/numeric-input'
import i18n from '@/i18n'

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

  it.each([
    [
      'Retries must be an integer less than or equal to 10',
      { label: 'Retries', max: 10, integer: true },
    ],
    ['Retries must be an integer', { label: 'Retries', integer: true }],
    ['Ratio must be a number greater than or equal to 0', { label: 'Ratio', min: 0 }],
    ['Ratio must be a number less than or equal to 1', { label: 'Ratio', max: 1 }],
    ['Ratio must be a number', { label: 'Ratio' }],
  ])('rejects a value that is not a number with: %s', (message, options) => {
    expect(parseConfigNumberInput('x', options)).toEqual({ value: undefined, error: message })
  })
})

describe('parseConfigNumberInput in another language', () => {
  const port = { label: 'Port', min: 1, max: 65535, integer: true }

  afterEach(async () => {
    await i18n.changeLanguage('en')
    i18n.removeResourceBundle('fr', 'translation')
  })

  it('puts the field name and the bounds where the language writes them', async () => {
    i18n.addResourceBundle('fr', 'translation', {
      'configUi.number.integerRange': 'Entre {{min}} et {{max}}, {{label}} doit être un entier',
    })
    await i18n.changeLanguage('fr')

    expect(parseConfigNumberInput('', port).error).toBe('Entre 1 et 65535, Port doit être un entier')
  })

  it('reads the message again when the language changes back', async () => {
    i18n.addResourceBundle('fr', 'translation', {
      'configUi.number.integerRange': 'Entre {{min}} et {{max}}, {{label}} doit être un entier',
    })
    await i18n.changeLanguage('fr')
    parseConfigNumberInput('', port)
    await i18n.changeLanguage('en')

    expect(parseConfigNumberInput('', port).error).toBe('Port must be an integer between 1 and 65535')
  })

  it('returns the message the caller gives as it is given', async () => {
    i18n.addResourceBundle('fr', 'translation', {
      'configUi.number.integerMin': '{{label}} doit être un entier supérieur ou égal à {{min}}',
    })
    await i18n.changeLanguage('fr')

    expect(
      parseConfigNumberInput('0', {
        label: 'Effective resolution',
        min: 1,
        integer: true,
        errorMessage: 'Effective resolution must be a positive integer',
      }).error,
    ).toBe('Effective resolution must be a positive integer')
  })
})
