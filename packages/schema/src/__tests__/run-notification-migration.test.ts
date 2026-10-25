// `guardRunNotification` is the one door every stored notification row enters through — both store
// readers call it — so a row stamped with any other version must be refused by name rather than
// read as the current contract.
import { describe, expect, it } from 'vitest'

import {
  CURRENT_RUN_NOTIFICATION_SCHEMA_VERSION,
  guardRunNotification,
  RUN_NOTIFICATION_MIGRATIONS,
  RunNotificationSchemaError,
} from '../notification/run-notification'

function stored(): Record<string, unknown> {
  return {
    schemaVersion: CURRENT_RUN_NOTIFICATION_SCHEMA_VERSION,
    runId: 'run-notification-guard',
    outcome: 'done',
    verdictSummary: { total: 2, byClass: { timeout: 1, unknown: 1 } },
    stages: {
      analysis: { status: 'done' },
      curation: { status: 'done', curated: 3, deprecated: 1 },
    },
  }
}

describe('guardRunNotification reads only the current stamp and shape', () => {
  it('accepts a current record unchanged', () => {
    const current = stored()
    const before = JSON.stringify(current)
    expect(JSON.parse(JSON.stringify(guardRunNotification(current)))).toEqual(current)
    expect(JSON.stringify(current)).toBe(before)
  })

  it.each([0, 1, 3, 4, 5])('refuses a record stamped %i by name, naming both stamps', (stamp) => {
    const other = { ...stored(), schemaVersion: stamp }

    expect(() => guardRunNotification(other)).toThrow(RunNotificationSchemaError)
    expect(() => guardRunNotification(other)).toThrow(
      new RegExp(
        `declares schemaVersion ${String(stamp)}, and this build reads ` +
          `${String(CURRENT_RUN_NOTIFICATION_SCHEMA_VERSION)}\\.`,
        'u',
      ),
    )
  })

  it('refuses a current record carrying a stage outside the declared two, naming the set', () => {
    const smuggled = {
      ...stored(),
      stages: { ...(stored().stages as object), extra: {} },
    }

    // The stamp alone cannot catch this: the record claims the current contract, so only the
    // exact-key check stands between an undeclared member and every surface that renders stages.
    expect(() => guardRunNotification(smuggled)).toThrow(RunNotificationSchemaError)
    expect(() => guardRunNotification(smuggled)).toThrow(
      /its stage set is \["analysis","curation","extra"\]/u,
    )
  })

  it.each(['DONE', '', 'done ', 'skipped', 'not-recorded'])(
    'refuses a curation stage status %j, naming the stage',
    (status) => {
      const bad = { ...stored(), stages: { analysis: { status: 'done' }, curation: { status } } }

      expect(() => guardRunNotification(bad)).toThrow(RunNotificationSchemaError)
      expect(() => guardRunNotification(bad)).toThrow(/its curation stage reports no outcome/u)
    },
  )

  it('refuses an analysis stage status outside done and failed', () => {
    const bad = {
      ...stored(),
      stages: { analysis: { status: 'skipped' }, curation: { status: 'done' } },
    }

    expect(() => guardRunNotification(bad)).toThrow(/its analysis stage reports no outcome/u)
  })

  it('refuses the chain outcome partial', () => {
    const bad = { ...stored(), outcome: 'partial' }

    expect(() => guardRunNotification(bad)).toThrow(RunNotificationSchemaError)
    expect(() => guardRunNotification(bad)).toThrow(/partial is not a chain outcome/u)
  })

  it('refuses a record missing its curation stage, naming the set', () => {
    const bad = { ...stored(), stages: { analysis: { status: 'done' } } }

    expect(() => guardRunNotification(bad)).toThrow(RunNotificationSchemaError)
    expect(() => guardRunNotification(bad)).toThrow(/its stage set is \["analysis"\]/u)
  })

  it('refuses a top-level field beside the five the record carries, naming the set', () => {
    const bad = { ...stored(), note: 'anything' }

    expect(() => guardRunNotification(bad)).toThrow(RunNotificationSchemaError)
    expect(() => guardRunNotification(bad)).toThrow(/its field set is \[[^\]]*"note"/u)
  })

  it('stamps 2 and registers no migration step', () => {
    expect(CURRENT_RUN_NOTIFICATION_SCHEMA_VERSION).toBe(2)
    expect(Object.keys(RUN_NOTIFICATION_MIGRATIONS)).toEqual([])
  })
})
