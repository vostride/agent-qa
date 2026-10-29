import { describe, expect, it } from 'vitest'

import {
  CHAT_SESSION_EVENT_KINDS,
  CURRENT_CHAT_SESSION_SCHEMA_VERSION,
  ClauseReceiptSchema,
  FUNCTION_CALLER_ORIGINS,
  guardChatSessionEvent,
} from '../index'
import * as schema from '../index'
import type { FunctionCaller } from '../index'

describe('the actor-origin axis', () => {
  it('is closed at exactly two members', () => {
    expect(FUNCTION_CALLER_ORIGINS).toEqual(['human', 'agent'])
  })

  it('has no third "unknown" member for a default to hide in', () => {
    // The fail-closed half of the design. A third value would need a rule, every safe rule for
    // it reads "treat it as agent", and a vocabulary with a member that always means another
    // member is two spellings of one thing.
    expect(FUNCTION_CALLER_ORIGINS).not.toContain('unknown')
    expect(FUNCTION_CALLER_ORIGINS).toHaveLength(2)
  })

  it('is REQUIRED on the caller record — an omitted origin never defaults to human', () => {
    // The type-level claim, driven rather than asserted in prose. Both lines are rejected by
    // `tsc`, which is the only authority here; vitest's own typecheck line has printed
    // "no errors" beside real tsc failures in this repo.
    // @ts-expect-error a caller record with no origin does not type
    const withoutOrigin: FunctionCaller = { surface: 'cli' }
    const invented: FunctionCaller = {
      surface: 'cli',
      // @ts-expect-error the union admits nothing but its two members
      origin: 'system',
    }
    void withoutOrigin
    void invented
  })
})

describe('the caller record after the permission wave', () => {
  it('types a tokenless caller with surface and origin alone — every permission field is optional', () => {
    const tokenless: FunctionCaller = { surface: 'mcp', origin: 'agent' }
    expect(Object.keys(tokenless).sort()).toEqual(['origin', 'surface'])
    const CALLER_TYPE_KEYS: ExactKeys<FunctionCaller, 'surface' | 'origin'> = true
    expect(CALLER_TYPE_KEYS).toBe(true)
  })

  it('keeps origin as presentation data only, with no new label', () => {
    // No approval- or provenance-shaped member joins the closed origin vocabulary.
    expect([...FUNCTION_CALLER_ORIGINS]).toEqual(['human', 'agent'])
    const human: FunctionCaller = { surface: 'cli', origin: 'human' }
    const agent: FunctionCaller = { surface: 'cli', origin: 'agent' }
    expect(Object.keys(human)).toEqual(Object.keys(agent))
  })
})

type ExactKeys<T, K extends PropertyKey> = [keyof T] extends [K]
  ? ([K] extends [keyof T] ? true : false)
  : false
const RETIRED_SCOPE_NAMES = [
  'read', 'run', 'config-write', 'knowledge-write', 'approval-write', 'test-write',
]

/** Every list and enum the root barrel exports, with its members. */
function exportedLists(): Array<readonly [string, readonly unknown[]]> {
  return Object.entries(schema).flatMap(([name, value]) => {
    if (Array.isArray(value)) return [[name, value] as const]
    const options = (value as { options?: unknown } | undefined)?.options
    return Array.isArray(options) ? [[name, options] as const] : []
  })
}

/** The exported lists that name any of `grants`. */
function listsNaming(grants: readonly string[]): string[] {
  return exportedLists()
    .filter(([, members]) => members.some((member) => grants.includes(member as string)))
    .map(([name]) => name)
}

describe('the capability-scope union', () => {
  it('exports no capability-scope schema or type from the root barrel', () => {
    expect(Object.keys(schema)).not.toContain('FunctionScopeSchema')
    expect(Object.keys(schema).filter((name) => /FunctionScope/.test(name))).toEqual([])
    // Non-vacuity: the barrel is the real one, and the caller vocabulary that survives is in it.
    expect(Object.keys(schema)).toContain('FUNCTION_CALLER_ORIGINS')
  })

  it('exports no enum parser that carries the six retired scope names', () => {
    const enums = Object.entries(schema).filter(([, value]) =>
      typeof (value as { safeParse?: unknown } | undefined)?.safeParse === 'function'
      && Array.isArray((value as { options?: unknown }).options))
    // Non-vacuity: the barrel does export enum parsers, so the census below ranges something.
    expect(enums.length).toBeGreaterThan(5)
    const carrying = enums
      .filter(([, value]) => RETIRED_SCOPE_NAMES
        .every((name) => ((value as { options: unknown[] }).options).includes(name)))
      .map(([name]) => name)
    expect(carrying).toEqual([])
  })

  it('exports no list or enum naming approval-write or knowledge-write', () => {
    // Non-vacuity: the barrel exports lists, and the census reads a real one.
    expect(exportedLists().length).toBeGreaterThan(5)
    expect(listsNaming(['human'])).toContain('FUNCTION_CALLER_ORIGINS')
    expect(listsNaming(['approval-write', 'knowledge-write'])).toEqual([])
  })

  it('exports no list or enum naming test-write', () => {
    expect(listsNaming(['test-write'])).toEqual([])
  })
})

// `approval_decision` stays a readable kind with no writer, so older session files still open.
describe('the origin axis after the gate', () => {
  it('the clause receipt carries origin, with its exact key set', () => {
    expect(Object.keys(ClauseReceiptSchema.shape).sort()).toEqual(
      ['clause', 'functionId', 'origin', 'outcome', 'status'],
    )
    for (const origin of FUNCTION_CALLER_ORIGINS) {
      expect(ClauseReceiptSchema.parse({
        clause: 'show the last run', functionId: 'runs.list', origin, status: 'executed', outcome: 'ok',
      }).origin).toBe(origin)
    }
  })

  it('a historical approval_decision line still parses, both sources and all three decisions', () => {
    expect(CHAT_SESSION_EVENT_KINDS).toContain('approval_decision')
    for (const source of ['gate', 'verb'] as const) {
      for (const decision of ['accept', 'accept-always', 'deny'] as const) {
        const line = {
          kind: 'approval_decision',
          turnId: 't_0001',
          at: '2026-09-01T10:00:00.000Z',
          actionClass: 'fn:authoring.draft.write',
          decision,
          source,
        }
        expect(guardChatSessionEvent(line, CURRENT_CHAT_SESSION_SCHEMA_VERSION)).toEqual(line)
      }
    }
  })

  it('the historical kind keeps its exact key set — no field is added or dropped', () => {
    const line = {
      kind: 'approval_decision',
      turnId: 't_0001',
      at: '2026-09-01T10:00:00.000Z',
      actionClass: 'fn:runs.mark',
      decision: 'deny',
      source: 'gate',
    }
    expect(() => guardChatSessionEvent({ ...line, origin: 'human' }, CURRENT_CHAT_SESSION_SCHEMA_VERSION))
      .toThrow(/approval_decision/)
    const { source: _source, ...withoutSource } = line
    expect(() => guardChatSessionEvent(withoutSource, CURRENT_CHAT_SESSION_SCHEMA_VERSION))
      .toThrow(/approval_decision/)
  })

  it('the origin vocabulary gains no approval-shaped label', () => {
    expect([...FUNCTION_CALLER_ORIGINS]).toEqual(['human', 'agent'])
    for (const retired of ['approved', 'confirmed', 'granted', 'trusted']) {
      expect(FUNCTION_CALLER_ORIGINS as readonly string[]).not.toContain(retired)
    }
  })
})

describe('a historical turn reads back in order, and re-reading is stable', () => {
  const at = '2026-09-01T10:00:00.000Z'
  const turn = [
    { kind: 'user_message', turnId: 't_0007', at, text: 'write a test for the login page' },
    { kind: 'approval_decision', turnId: 't_0007', at, actionClass: 'fn:authoring.draft.write', decision: 'accept', source: 'gate' },
    { kind: 'clause_receipt', turnId: 't_0007', at, clause: 'write a test', functionId: 'authoring.draft.write', origin: 'human', status: 'executed', outcome: 'drafted' },
    { kind: 'approval_decision', turnId: 't_0007', at, actionClass: 'fn:runs.mark', decision: 'deny', source: 'verb' },
    { kind: 'turn_complete', turnId: 't_0007', at, status: 'completed' },
  ]

  it('every line of the historical turn parses, in its written order', () => {
    const lines = turn.map((line) => JSON.parse(JSON.stringify(line)) as unknown)
    const read = lines.map((line) => guardChatSessionEvent(line, CURRENT_CHAT_SESSION_SCHEMA_VERSION))
    expect(read.map((event) => event.kind)).toEqual([
      'user_message', 'approval_decision', 'clause_receipt', 'approval_decision', 'turn_complete',
    ])
    const again = lines.map((line) => guardChatSessionEvent(line, CURRENT_CHAT_SESSION_SCHEMA_VERSION))
    expect(again).toEqual(read)
  })
})
