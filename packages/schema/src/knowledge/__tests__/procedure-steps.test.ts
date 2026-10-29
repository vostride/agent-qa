import { describe, expect, it } from 'vitest'

import {
  COORDINATE_ACTION_KEYS,
  NON_REPLAYABLE_ACTION_TYPES,
  isReplayableActionShape,
} from '../../action/replayability'
import {
  PROCEDURE_BODY_SCHEMA_VERSION,
  parseProcedureBody,
  procedureStepKeys,
  serializeProcedureBody,
  type ProcedureBodyPayload,
} from '../procedure-steps'

function threeStepPayload(): ProcedureBodyPayload {
  return {
    schemaVersion: PROCEDURE_BODY_SCHEMA_VERSION,
    parameters: [
      { name: 'username', type: 'string', required: true },
      { name: 'password', type: 'secret', required: true },
    ],
    steps: [
      {
        instruction: 'Open the login page',
        action: { type: 'navigate', targets: {}, values: { url: '/login' } },
        guard: {
          target: { role: 'textbox', nameNormalized: 'username' },
          pageAnchor: { t: 'page', route: '/login' },
          landmarks: ['Sign in'],
        },
      },
      {
        instruction: 'Fill the password field',
        action: {
          type: 'fill',
          targets: { ref: { role: 'textbox', nameNormalized: 'password', ordinal: 0 } },
          values: { value: { param: 'password' } },
        },
        guard: {
          target: { role: 'textbox', nameNormalized: 'password', ordinal: 0 },
          pageAnchor: { t: 'page', route: '/login' },
        },
      },
      {
        instruction: 'Submit the form',
        action: { type: 'click', targets: { ref: { role: 'button', nameNormalized: 'sign in' } }, values: {} },
        guard: {
          target: { role: 'button', nameNormalized: 'sign in' },
          pageAnchor: { t: 'page', route: '/login' },
        },
      },
    ],
    successAssertion: 'The account dashboard is visible',
  }
}

function scalarValuePayload(): ProcedureBodyPayload {
  return {
    schemaVersion: PROCEDURE_BODY_SCHEMA_VERSION,
    parameters: [{ name: 'user_email', type: 'string', required: true }],
    steps: [
      {
        instruction: 'Fill and submit the email field',
        action: {
          type: 'fill',
          targets: { ref: { role: 'textbox', nameNormalized: 'email' } },
          values: { text: { param: 'user_email' }, submit: true },
        },
        guard: {
          target: { role: 'textbox', nameNormalized: 'email' },
          pageAnchor: { t: 'page', route: '/login' },
        },
      },
      {
        instruction: 'Scroll until the result is visible',
        action: {
          type: 'scroll',
          targets: { ref: { role: 'list', nameNormalized: 'results' } },
          values: { maxSwipes: 4, retryOpposite: false },
        },
        guard: {
          target: { role: 'list', nameNormalized: 'results' },
          pageAnchor: { t: 'page', route: '/results' },
        },
      },
      {
        instruction: 'Pinch the canvas',
        action: {
          type: 'pinch',
          targets: { ref: { role: 'img', nameNormalized: 'map' } },
          values: { scale: 2.5 },
        },
        guard: {
          target: { role: 'img', nameNormalized: 'map' },
          pageAnchor: { t: 'page', route: '/map' },
        },
      },
    ],
    successAssertion: 'The typed actions complete',
  }
}

function compositeValuePayload(): ProcedureBodyPayload {
  return {
    schemaVersion: PROCEDURE_BODY_SCHEMA_VERSION,
    parameters: [],
    steps: [
      {
        instruction: 'Upload the fixture files',
        action: {
          type: 'fileUpload',
          targets: { ref: { role: 'button', nameNormalized: 'upload files' } },
          values: { files: { json: ['a.png', 'b.pdf'] } },
        },
        guard: {
          target: { role: 'button', nameNormalized: 'upload files' },
          pageAnchor: { t: 'page', route: '/attachments' },
        },
      },
      {
        instruction: 'Open the card at the recorded point',
        action: {
          type: 'doubleClick',
          targets: { ref: { role: 'article', nameNormalized: 'invoice' } },
          values: { relativePosition: { json: { x: 5, y: 7 } } },
        },
        guard: {
          target: { role: 'article', nameNormalized: 'invoice' },
          pageAnchor: { t: 'page', route: '/attachments' },
        },
      },
    ],
    successAssertion: 'The uploaded invoice is open',
  } as unknown as ProcedureBodyPayload
}

describe('procedure body codec', () => {
  it('round-trips a payload byte-identically through serialize -> parse', () => {
    const payload = threeStepPayload()
    const first = serializeProcedureBody(payload)
    const second = serializeProcedureBody(payload)
    expect(second).toBe(first)

    const parsed = parseProcedureBody(first)
    expect(parsed).toEqual(payload)
    expect(parsed).not.toBeUndefined()
    expect(serializeProcedureBody(parsed as ProcedureBodyPayload)).toBe(first)
  })

  it('fails closed on any malformation — undefined, never a throw', () => {
    expect(parseProcedureBody('random prose')).toBeUndefined()
    expect(parseProcedureBody('')).toBeUndefined()
    expect(parseProcedureBody('```json agent-qa-procedure\n{bad json}\n```\n')).toBeUndefined()

    const outsideUnion = threeStepPayload() as unknown as {
      parameters: { name: string; type: string; required: boolean }[]
    }
    outsideUnion.parameters[0].type = 'json'
    expect(parseProcedureBody(serializeProcedureBody(outsideUnion as ProcedureBodyPayload))).toBeUndefined()

    const unknownKey = { ...threeStepPayload(), unexpected: true }
    expect(parseProcedureBody(serializeProcedureBody(unknownKey as ProcedureBodyPayload))).toBeUndefined()
  })

  it('round-trips JSON scalar value slots without changing their types or canonical bytes', () => {
    const payload = scalarValuePayload()
    const first = serializeProcedureBody(payload)
    expect(serializeProcedureBody(payload)).toBe(first)

    const parsed = parseProcedureBody(first)
    expect(parsed).toEqual(payload)
    expect(typeof parsed?.steps[0]?.action.values.submit).toBe('boolean')
    expect(typeof parsed?.steps[1]?.action.values.maxSwipes).toBe('number')
    expect(typeof parsed?.steps[2]?.action.values.scale).toBe('number')
    expect(parsed?.steps[0]?.action.values.text).toEqual({ param: 'user_email' })
  })

  it('round-trips tagged JSON composite slots without changing their nested values', () => {
    const payload = compositeValuePayload()

    const parsed = parseProcedureBody(serializeProcedureBody(payload))

    expect(parsed).toEqual(payload)
    expect(parsed?.steps[0]?.action.values.files).toEqual({ json: ['a.png', 'b.pdf'] })
    expect(parsed?.steps[1]?.action.values.relativePosition).toEqual({
      json: { x: 5, y: 7 },
    })
  })

  it('rejects bare composites while treating tagged param-shaped objects as JSON literals', () => {
    const bareArray = compositeValuePayload() as unknown as {
      steps: Array<{ action: { values: Record<string, unknown> } }>
    }
    bareArray.steps[0]!.action.values.files = ['a.png']
    expect(
      parseProcedureBody(serializeProcedureBody(bareArray as unknown as ProcedureBodyPayload)),
    ).toBeUndefined()

    const bareObject = compositeValuePayload() as unknown as {
      steps: Array<{ action: { values: Record<string, unknown> } }>
    }
    bareObject.steps[1]!.action.values.relativePosition = { x: 5, y: 7 }
    expect(
      parseProcedureBody(serializeProcedureBody(bareObject as unknown as ProcedureBodyPayload)),
    ).toBeUndefined()

    const taggedLiteral = compositeValuePayload() as unknown as {
      steps: Array<{ action: { values: Record<string, unknown> } }>
    }
    taggedLiteral.steps[1]!.action.values.relativePosition = { json: { param: 'x' } }
    expect(
      parseProcedureBody(serializeProcedureBody(taggedLiteral as unknown as ProcedureBodyPayload))
        ?.steps[1]?.action.values.relativePosition,
    ).toEqual({ json: { param: 'x' } })
  })

  it('round-trips targets carrying the exact name and row words', () => {
    const payload = threeStepPayload()
    const target = {
      role: 'button',
      nameNormalized: 'edit label',
      name: 'Edit label',
      row: '7 Elm Street',
    }
    payload.steps[2] = {
      ...payload.steps[2]!,
      action: { type: 'click', targets: { ref: target }, values: {} },
      guard: { ...payload.steps[2]!.guard, target },
    }
    const first = serializeProcedureBody(payload)

    const parsed = parseProcedureBody(first)

    expect(parsed).toEqual(payload)
    expect(parsed?.steps[2]?.action.targets.ref).toEqual(target)
    expect(serializeProcedureBody(parsed as ProcedureBodyPayload)).toBe(first)
  })

  it('fails closed on an unknown target key', () => {
    const payload = threeStepPayload() as unknown as {
      steps: Array<{ guard: { target: Record<string, unknown> } }>
    }
    payload.steps[2]!.guard.target.nearText = 'Submit'

    expect(
      parseProcedureBody(serializeProcedureBody(payload as unknown as ProcedureBodyPayload)),
    ).toBeUndefined()
  })

  it('rejects duplicate parameter names at the committed parse wall', () => {
    const payload = threeStepPayload()
    payload.parameters = [
      { name: 'email', type: 'string', required: true },
      { name: 'email', type: 'secret', required: true },
    ]

    expect(parseProcedureBody(serializeProcedureBody(payload))).toBeUndefined()
  })

  it('derives one ordered step key per step, excluding authored prose', () => {
    const keys = procedureStepKeys(threeStepPayload())
    expect(keys).toHaveLength(3)
    expect(new Set(keys).size).toBe(3)
    for (const key of keys) {
      expect(key).not.toContain('Open the login page')
      expect(key).not.toContain('Submit the form')
    }
    // deterministic across calls
    expect(procedureStepKeys(threeStepPayload())).toEqual(keys)
  })

  it('keeps step identity byte-identical when only value-slot types change', () => {
    const before = scalarValuePayload()
    const after = scalarValuePayload()
    after.steps[0]!.action.values.submit = 'true'
    after.steps[1]!.action.values.maxSwipes = '4'
    after.steps[2]!.action.values.scale = '2.5'

    expect(procedureStepKeys(after)).toEqual(procedureStepKeys(before))
  })

  it('keeps step identity byte-identical when only composite literal values change', () => {
    const before = compositeValuePayload()
    const after = compositeValuePayload() as unknown as {
      steps: Array<{ action: { values: Record<string, unknown> } }>
    }
    after.steps[0]!.action.values.files = { json: ['different.csv'] }
    after.steps[1]!.action.values.relativePosition = { json: { x: 99, y: 101 } }

    expect(procedureStepKeys(after as unknown as ProcedureBodyPayload)).toEqual(
      procedureStepKeys(before),
    )
  })
})

describe('replayability constants (the one shared list)', () => {
  it('mirrors the runner exclusion lists member-for-member', () => {
    expect([...NON_REPLAYABLE_ACTION_TYPES].sort()).toEqual(
      ['assertAI', 'extractAI', 'setVariable', 'tapCoordinate'].sort(),
    )
    expect([...COORDINATE_ACTION_KEYS].sort()).toEqual(
      ['coordinates', 'coords', 'endX', 'endY', 'startX', 'startY', 'x', 'y'].sort(),
    )
  })

  it('rejects non-replayable types and coordinate-carrying shapes; accepts descriptor-targeted actions', () => {
    expect(isReplayableActionShape('tapCoordinate', [])).toBe(false)
    expect(isReplayableActionShape('setVariable', ['name', 'value'])).toBe(false)
    expect(isReplayableActionShape('assertAI', ['assertion'])).toBe(false)
    expect(isReplayableActionShape('extractAI', ['query'])).toBe(false)
    expect(isReplayableActionShape('click', ['ref', 'x', 'y'])).toBe(false)
    expect(isReplayableActionShape('swipe', ['startX', 'startY'])).toBe(false)

    expect(isReplayableActionShape('click', ['ref'])).toBe(true)
    expect(isReplayableActionShape('fill', ['ref', 'value'])).toBe(true)
  })
})
