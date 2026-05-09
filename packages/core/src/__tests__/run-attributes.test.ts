import { describe, expect, it } from 'vitest'
import {
  ATTR_RUNNER,
  ATTR_TRIGGER,
  buildInternalRunAttributes,
  formatRunAttributesBlock,
  parseRunAttrFlags,
  validateTrustedRunAttributes,
  validateUserRunAttributes,
} from '../run-attributes.js'

describe('run attributes', () => {
  it('accepts arbitrary string keys and string values', () => {
    expect(validateUserRunAttributes({
      'git.branch': 'phase223-main',
      'myCustomKey.xx': 'custom-123',
    })).toEqual({
      'git.branch': 'phase223-main',
      'myCustomKey.xx': 'custom-123',
    })
  })

  it('rejects invalid user attributes', () => {
    expect(() => validateUserRunAttributes({ '': 'main' })).toThrow(/Attribute key must be non-empty/)
    expect(() => validateUserRunAttributes({ [ATTR_TRIGGER]: 'cli' })).toThrow(/reserved prefix/)
    expect(() => validateUserRunAttributes({ 'git.branch': ['main'] })).toThrow(/must be a string/)
  })

  it('preserves prototype-shaped custom attribute keys as data', () => {
    const userAttributes = validateUserRunAttributes(JSON.parse('{"__proto__":"value"}'))
    expect(Object.hasOwn(userAttributes, '__proto__')).toBe(true)
    expect(userAttributes.__proto__).toBe('value')

    const trustedAttributes = validateTrustedRunAttributes(JSON.parse('{"__proto__":"trusted"}'))
    expect(Object.hasOwn(trustedAttributes, '__proto__')).toBe(true)
    expect(trustedAttributes.__proto__).toBe('trusted')
  })

  it('parses repeated CLI flags with last value wins and duplicate warnings', () => {
    const parsed = parseRunAttrFlags(['git.branch=dev', 'git.branch=phase223-main', 'user.email=CI'])
    expect(parsed.attributes).toEqual({
      'git.branch': 'phase223-main',
      'user.email': 'CI',
    })
    expect(parsed.duplicateKeys).toEqual(['git.branch'])
  })

  it('parses prototype-shaped run attribute flags as data keys', () => {
    const parsed = parseRunAttrFlags(['__proto__=value'])
    expect(Object.hasOwn(parsed.attributes, '__proto__')).toBe(true)
    expect(parsed.attributes.__proto__).toBe('value')
  })

  it('builds protected internal run attributes', () => {
    expect(buildInternalRunAttributes({ trigger: 'cli', runner: 'local' })).toEqual({
      [ATTR_TRIGGER]: 'cli',
      [ATTR_RUNNER]: 'local',
    })
  })

  it('accepts trusted internal attributes plus custom attributes', () => {
    expect(validateTrustedRunAttributes({
      [ATTR_TRIGGER]: 'dashboard',
      [ATTR_RUNNER]: 'browserstack',
      'git.branch': 'phase223-main',
    }, 'inherited run attributes')).toEqual({
      [ATTR_TRIGGER]: 'dashboard',
      [ATTR_RUNNER]: 'browserstack',
      'git.branch': 'phase223-main',
    })
  })

  it('rejects unknown or invalid protected trusted attributes', () => {
    expect(() => validateTrustedRunAttributes({
      'agent-qa.custom': 'evil',
    }, 'inherited run attributes')).toThrow(/inherited run attributes: Attribute key "agent-qa\.custom" uses the reserved prefix/)

    expect(() => validateTrustedRunAttributes({
      [ATTR_TRIGGER]: 'evil',
    }, 'inherited run attributes')).toThrow(/Attribute value for "agent-qa\.trigger" must be one of/)
  })

  it('formats attributes with protected keys first and custom keys alphabetically', () => {
    expect(formatRunAttributesBlock({
      'z.custom': 'last',
      'git.branch': 'phase223-main',
      [ATTR_RUNNER]: 'local',
      [ATTR_TRIGGER]: 'cli',
    })).toBe([
      'Run attributes:',
      '  agent-qa.trigger=cli',
      '  agent-qa.runner=local',
      '  git.branch=phase223-main',
      '  z.custom=last',
    ].join('\n'))
  })
})
