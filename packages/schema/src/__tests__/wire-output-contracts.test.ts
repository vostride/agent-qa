// A JSON Schema walker, not zod: zod's record parser skips an own `__proto__` key.

import { describe, expect, test } from 'vitest'
import { z } from 'zod'

import * as api from '../index'
import { RUN_EVIDENCE_DOCUMENT_SCHEMA_VERSION } from '../run/evidence'

type Json = Record<string, unknown>

const HANDLED = new Set([
  '$schema', 'description', 'type', 'enum', 'const', 'properties', 'required',
  'additionalProperties', 'propertyNames', 'items', 'anyOf', 'oneOf', 'allOf', 'minimum',
  'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'pattern', 'minLength', 'maxLength',
])

function typeOf(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number'
  return typeof value
}

function ownEntries(value: object): [string, unknown][] {
  return Object.keys(value).map((key) => [key, Object.getOwnPropertyDescriptor(value, key)?.value])
}

function conformance(schema: Json, value: unknown, at = '$'): string[] {
  for (const key of Object.keys(schema)) {
    if (!HANDLED.has(key)) throw new Error(`unhandled JSON Schema keyword ${key} at ${at}`)
  }
  const failures: string[] = []
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type]
    const actual = typeOf(value)
    if (!types.includes(actual) && !(actual === 'integer' && types.includes('number'))) {
      return [`${at}: ${actual} is not ${types.join('|')}`]
    }
  }
  if (schema.const !== undefined && schema.const !== value) failures.push(`${at}: not const`)
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) failures.push(`${at}: not in enum`)
  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) failures.push(`${at}: below minimum`)
    if (typeof schema.maximum === 'number' && value > schema.maximum) failures.push(`${at}: above maximum`)
    if (typeof schema.exclusiveMinimum === 'number' && value <= schema.exclusiveMinimum) failures.push(`${at}: not above`)
    if (typeof schema.exclusiveMaximum === 'number' && value >= schema.exclusiveMaximum) failures.push(`${at}: not below`)
  }
  if (typeof value === 'string') {
    if (typeof schema.pattern === 'string' && !new RegExp(schema.pattern, 'u').test(value)) failures.push(`${at}: pattern`)
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) failures.push(`${at}: too short`)
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) failures.push(`${at}: too long`)
  }
  if (Array.isArray(value) && schema.items !== undefined) {
    value.forEach((item, index) => failures.push(...conformance(schema.items as Json, item, `${at}[${index}]`)))
  }
  if (typeOf(value) === 'object') {
    const entries = ownEntries(value as object)
    const properties = (schema.properties ?? {}) as Json
    for (const required of (schema.required ?? []) as string[]) {
      if (!Object.hasOwn(value as object, required)) failures.push(`${at}.${required}: missing`)
    }
    for (const [key, entry] of entries) {
      if (schema.propertyNames !== undefined) failures.push(...conformance(schema.propertyNames as Json, key, `${at}{${key}}`))
      if (Object.hasOwn(properties, key)) {
        failures.push(...conformance(properties[key] as Json, entry, `${at}.${key}`))
      } else if (schema.additionalProperties === false) {
        failures.push(`${at}.${key}: additional property`)
      } else if (typeof schema.additionalProperties === 'object') {
        failures.push(...conformance(schema.additionalProperties as Json, entry, `${at}.${key}`))
      }
    }
  }
  if (Array.isArray(schema.allOf)) {
    for (const member of schema.allOf) failures.push(...conformance(member as Json, value, at))
  }
  for (const keyword of ['anyOf', 'oneOf'] as const) {
    const members = schema[keyword]
    if (!Array.isArray(members)) continue
    const passing = members.filter((member) => conformance(member as Json, value, at).length === 0).length
    if (passing === 0 || (keyword === 'oneOf' && passing > 1)) failures.push(`${at}: ${keyword} matched ${passing}`)
  }
  return failures
}

function subschemas(schema: unknown, at = '$'): [string, Json][] {
  if (typeof schema !== 'object' || schema === null) return []
  if (Array.isArray(schema)) return schema.flatMap((entry, index) => subschemas(entry, `${at}[${index}]`))
  const node = schema as Json
  const found: [string, Json][] = [[at, node]]
  for (const [key, entry] of Object.entries(node)) {
    if (key === 'properties') {
      for (const [name, member] of Object.entries(entry as Json)) found.push(...subschemas(member, `${at}.${name}`))
    } else if (key !== 'enum' && key !== 'const' && key !== 'required') {
      found.push(...subschemas(entry, `${at}/${key}`))
    }
  }
  return found
}

function advertised(contract: { '~standard': { jsonSchema: { output(options: { target: string }): Json } } }): Json {
  return contract['~standard'].jsonSchema.output({ target: 'draft-2020-12' })
}

function validate(contract: { '~standard': { validate(value: unknown): unknown } }, value: unknown) {
  return contract['~standard'].validate(value) as { value?: unknown; issues?: readonly unknown[] }
}

const sha = 'a'.repeat(64)
const runId = 'r_alpha-bravo-charlie'
const address = (kind: string, extra: Json = {}) => ({ runId, testIndex: 0, stepIndex: 1, kind, ...extra })
const ref = (prefix: string) => ({ id: `${prefix}${sha}`, sha })

const summary = (overrides: Json = {}) => ({
  runId,
  scope: { tier: 'suite', key: 'checkout' },
  buildOrdinal: 3,
  executionContext: 'local-headless',
  aggregateVerdict: 'passed',
  startedAt: 1_000,
  endedAt: 2_000,
  testCount: 1,
  tests: [{ testIndex: 0, testId: 't_one', testName: 'Checkout works' }],
  recordedTargets: { status: 'recorded', names: ['staging'] },
  ...overrides,
})

const variables = (): Json => JSON.parse(
  '{"__proto__":{"value":"p","source":"capture"},"constructor":{"value":"c","source":"env"},'
  + '"plain":{"value":"v","source":"inline"}}',
) as Json

const evidenceArms: readonly (readonly [string, unknown])[] = [
  ['ready console', {
    address: address('console'), outcome: 'ready',
    evidence: { kind: 'console', state: 'present', ref: ref('console-evidence:'), counts: { total: 1, errors: 1, warnings: 0 } },
    document: { schemaVersion: RUN_EVIDENCE_DOCUMENT_SCHEMA_VERSION, kind: 'console', records: [{ level: 'error', text: 'boom', timestamp: 5 }] },
  }],
  ['ready console, empty records', {
    address: address('console'), outcome: 'ready',
    evidence: { kind: 'console', state: 'present', ref: ref('console-evidence:'), counts: { total: 0, errors: 0, warnings: 0 } },
    document: { schemaVersion: RUN_EVIDENCE_DOCUMENT_SCHEMA_VERSION, kind: 'console', records: [] },
  }],
  ['ready network', {
    address: address('network'), outcome: 'ready',
    evidence: { kind: 'network', state: 'present', ref: ref('network-evidence:'), counts: { total: 1, failed: 0, errored: 0 } },
    document: {
      schemaVersion: RUN_EVIDENCE_DOCUMENT_SCHEMA_VERSION, kind: 'network',
      records: [{ url: 'https://x.test', method: 'GET', status: 200, requestHeaders: {}, responseHeaders: { a: 'b' }, startTime: 1, endTime: 2 }],
    },
  }],
  ['ready a11y', {
    address: address('a11y'), outcome: 'ready',
    evidence: { kind: 'a11y', state: 'present', ref: ref('a11y-evidence:'), counts: { minor: 0, moderate: 0, serious: 1, critical: 0 } },
    document: {
      schemaVersion: RUN_EVIDENCE_DOCUMENT_SCHEMA_VERSION, kind: 'a11y',
      records: [{ ruleId: 'r', impact: 'serious', description: 'd', help: 'h', helpUrl: 'u', nodes: [{ html: '<a>', target: ['a'] }] }],
    },
  }],
  ['ready aria on a sub-action', {
    address: address('aria', { subActionIndex: 2 }), outcome: 'ready',
    evidence: { kind: 'aria', state: 'present', ref: ref('aria-state:') },
    document: { schemaVersion: RUN_EVIDENCE_DOCUMENT_SCHEMA_VERSION, kind: 'aria', tree: '- button "Pay"' },
  }],
  ['ready variables with own special keys', {
    address: address('variables'), outcome: 'ready',
    evidence: { kind: 'variables', state: 'present', counts: { count: 3 } },
    document: { schemaVersion: RUN_EVIDENCE_DOCUMENT_SCHEMA_VERSION, kind: 'variables', records: variables() },
  }],
  ['ready variables, empty map', {
    address: address('variables'), outcome: 'ready',
    evidence: { kind: 'variables', state: 'present', counts: { count: 0 } },
    document: { schemaVersion: RUN_EVIDENCE_DOCUMENT_SCHEMA_VERSION, kind: 'variables', records: {} },
  }],
  ['absent', {
    address: address('network'), outcome: 'absent',
    evidence: { kind: 'network', state: 'absent', reason: 'not-captured', evidenceIncomplete: true },
  }],
  ['withheld read error with capture', {
    address: address('console'), outcome: 'read-error', code: 'masking-unavailable',
    capture: { kind: 'console', state: 'present', ref: ref('console-evidence:'), counts: { total: 1, errors: 0, warnings: 0 } },
  }],
  ['missing address read error', {
    address: address('aria'), outcome: 'read-error', code: 'address-not-found',
  }],
]

const listArms: readonly (readonly [string, unknown])[] = [
  ['empty list', []],
  ['recorded and unknown targets', [summary(), summary({ runId: 'r_delta', recordedTargets: { status: 'unknown' } })]],
]

describe('OUTPUT-CONTRACT-FIDELITY', () => {
  test('the runtime schemas themselves cannot be converted in output mode', () => {
    for (const schema of [api.RunsListOutputSchema, api.RunsEvidenceResultSchema]) {
      expect(() => schema['~standard'].jsonSchema.output({ target: 'draft-2020-12' }))
        .toThrow('Transforms cannot be represented in JSON Schema')
    }
  })

  test('each contract carries its exact runtime schema object', () => {
    expect(api.RunsListOutputContract.runtimeSchema).toBe(api.RunsListOutputSchema)
    expect(api.RunsEvidenceOutputContract.runtimeSchema).toBe(api.RunsEvidenceResultSchema)
    expect(api.RunsArtifactOutputContract.runtimeSchema).toBe(api.RunsArtifactResultSchema)
  })

  test('emits an output-mode draft-2020-12 document with no any-valued substitute', () => {
    for (const contract of [api.RunsListOutputContract, api.RunsEvidenceOutputContract, api.RunsArtifactOutputContract]) {
      const document = advertised(contract)
      expect(document.$schema).toBe('https://json-schema.org/draft/2020-12/schema')
      const empty = subschemas(document).filter(([, node]) => Object.keys(node).length === 0).map(([at]) => at)
      expect(empty).toEqual([])
      expect(advertised(contract)).toEqual(document)
      expect(advertised(contract)).not.toBe(document)
    }
    const list = advertised(api.RunsListOutputContract)
    expect(((list.items as Json).properties as Json).runId).toEqual({ type: 'string' })
  })

  test('refuses a conversion target it does not publish', () => {
    expect(() => api.RunsListOutputContract['~standard'].jsonSchema.output({ target: 'draft-07' }))
      .toThrow(/draft-2020-12/)
  })

  test('input mode is the runtime schema\'s own input conversion', () => {
    expect(api.RunsEvidenceOutputContract['~standard'].jsonSchema.input({ target: 'draft-2020-12' }))
      .toEqual(api.RunsEvidenceResultSchema['~standard'].jsonSchema.input({ target: 'draft-2020-12' }))
  })

  test.each(listArms)('list arm "%s" validates and satisfies the advertised document', (_name, arm) => {
    const result = validate(api.RunsListOutputContract, arm)
    expect(result.issues).toBeUndefined()
    expect(result.value).toEqual(api.RunsListOutputSchema.parse(arm))
    expect(conformance(advertised(api.RunsListOutputContract), result.value)).toEqual([])
    expect(conformance(advertised(api.RunsListOutputContract), arm)).toEqual([])
  })

  test.each(evidenceArms)('evidence arm "%s" validates and satisfies the advertised document', (_name, arm) => {
    const result = validate(api.RunsEvidenceOutputContract, arm)
    expect(result.issues).toBeUndefined()
    expect(conformance(advertised(api.RunsEvidenceOutputContract), result.value)).toEqual([])
    expect(conformance(advertised(api.RunsEvidenceOutputContract), arm)).toEqual([])
  })

  test('own __proto__ and constructor variables survive validation as own data properties', () => {
    const arm = evidenceArms.find(([name]) => name === 'ready variables with own special keys')![1] as Json
    const before = (arm.document as Json).records as Json
    const result = validate(api.RunsEvidenceOutputContract, arm)
    expect(result.issues).toBeUndefined()
    const after = ((result.value as Json).document as Json).records as Json
    expect(Reflect.ownKeys(after).sort()).toEqual(Reflect.ownKeys(before).sort())
    for (const key of Reflect.ownKeys(before)) {
      expect(Object.getOwnPropertyDescriptor(after, key), String(key))
        .toEqual(Object.getOwnPropertyDescriptor(before, key))
    }
    expect(Object.getPrototypeOf(after)).toBe(Object.prototype)
  })

  test('the advertised document checks an own __proto__ value rather than skipping it', () => {
    const records = JSON.parse('{"__proto__":{"value":7,"source":"capture"}}') as Json
    const arm = {
      address: address('variables'), outcome: 'ready',
      evidence: { kind: 'variables', state: 'present', counts: { count: 1 } },
      document: { schemaVersion: RUN_EVIDENCE_DOCUMENT_SCHEMA_VERSION, kind: 'variables', records },
    }
    expect(validate(api.RunsEvidenceOutputContract, arm).issues?.length).toBeGreaterThan(0)
    expect(conformance(advertised(api.RunsEvidenceOutputContract), arm).length).toBeGreaterThan(0)
  })

  test('rejects invalid output exactly as the runtime schema does', () => {
    const invalidList: unknown[] = [
      null,
      { runs: [] },
      [summary({ runId: '../escape' })],
      [summary({ extra: true })],
      [summary({ recordedTargets: { status: 'recorded' } })],
    ]
    for (const value of invalidList) {
      expect(validate(api.RunsListOutputContract, value).issues?.length, JSON.stringify(value)).toBeGreaterThan(0)
      expect(api.RunsListOutputSchema.safeParse(value).success).toBe(false)
    }
    const crossed = {
      address: address('console'), outcome: 'absent',
      evidence: { kind: 'network', state: 'absent', reason: 'empty' },
    }
    const subActionOnConsole = {
      address: address('console', { subActionIndex: 1 }), outcome: 'read-error', code: 'address-not-found',
    }
    for (const value of [null, crossed, subActionOnConsole]) {
      expect(validate(api.RunsEvidenceOutputContract, value).issues?.length, JSON.stringify(value)).toBeGreaterThan(0)
    }
  })

  test('fails closed on an unrepresentable construct it was not told how to publish', () => {
    const drifted = z.object({ note: z.string().transform((value) => value.trim()) })
    expect(() => api.deriveWireOutputRepresentation(drifted)).toThrow(/unrepresentable/)
    expect(() => api.deriveWireOutputRepresentation(z.object({ at: z.date() }))).toThrow(/unrepresentable/)
  })

  test('createOutputContract keeps the runtime schema authoritative and freezes its document', () => {
    const runtime = z.strictObject({ id: z.string().transform((value) => value.toUpperCase()) })
    const contract = api.createOutputContract(runtime, { type: 'object', properties: { id: { type: 'string' } } })
    expect(contract.runtimeSchema).toBe(runtime)
    expect(Object.isFrozen(contract.outputRepresentation)).toBe(true)
    expect(Object.isFrozen(contract.outputRepresentation.properties)).toBe(true)
    expect(validate(contract, { id: 'a' }).value).toEqual({ id: 'A' })
    expect(validate(contract, { id: 'a', extra: 1 }).issues?.length).toBeGreaterThan(0)
  })
})
