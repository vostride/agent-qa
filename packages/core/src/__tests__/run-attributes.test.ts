import { describe, expect, it } from 'vitest'
import {
  ATTR_GATE_RUN,
  ATTR_RUNNER,
  ATTR_TRIGGER,
  buildInternalRunAttributes,
  formatRunAttributesBlock,
  mergeRunAttributes,
  parseRunAttrFlags,
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

// 2026-10-17 (443-07, D-09): a verify run's row carries one internal mark.
describe('C443-VERIFY-MARK', () => {
  it('the gate-run mark is an internal attribute a user cannot set', () => {
    expect(ATTR_GATE_RUN, 'the mark key').toBe('agent-qa.gate-run')
    const marked = mergeRunAttributes(
      { ...buildInternalRunAttributes({ trigger: 'cli', runner: 'local' }), [ATTR_GATE_RUN]: 'true' },
      { 'git.branch': 'main' },
    )
    expect({ ...marked }, 'the marked attributes after merge').toEqual({
      'git.branch': 'main',
      'agent-qa.trigger': 'cli',
      'agent-qa.runner': 'local',
      'agent-qa.gate-run': 'true',
    })
    const unmarked = buildInternalRunAttributes({ trigger: 'cli', runner: 'local' })
    expect(Object.hasOwn(unmarked, ATTR_GATE_RUN), 'unmarked attributes carry no mark').toBe(false)

    expect(() => validateUserRunAttributes({ [ATTR_GATE_RUN]: 'true' })).toThrow(/reserved prefix/)
    expect(() => parseRunAttrFlags([`${ATTR_GATE_RUN}=true`])).toThrow(/reserved prefix/)
  })

  it('the mark is listed after the runner among the protected keys', () => {
    expect(formatRunAttributesBlock({
      'git.branch': 'main',
      'agent-qa.zz': 'x',
      [ATTR_GATE_RUN]: 'true',
      [ATTR_RUNNER]: 'local',
      [ATTR_TRIGGER]: 'cli',
    }).split('\n').join(' | ')).toBe(
      'Run attributes: |   agent-qa.trigger=cli |   agent-qa.runner=local |   agent-qa.gate-run=true |   agent-qa.zz=x |   git.branch=main',
    )
  })
})

// 2026-10-17 (443-16, GAP-D6): the record's spread is the gate-run mark's one spelling.
describe('C443-DEAD-SURFACE', () => {
  it('the internal attribute builder takes no gate-run option', () => {
    const input = { trigger: 'cli' as const, runner: 'local' as const, gateRun: true as const }
    const built = buildInternalRunAttributes(input)
    expect(Object.hasOwn(built, ATTR_GATE_RUN), 'the builder wrote the gate-run mark').toBe(false)
    expect(built).toEqual({ [ATTR_TRIGGER]: 'cli', [ATTR_RUNNER]: 'local' })
  })
})
