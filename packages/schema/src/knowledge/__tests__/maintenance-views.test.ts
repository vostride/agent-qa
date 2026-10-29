import { describe, expect, it } from 'vitest'

import * as knowledge from '../index.js'
import {
  INSPECT_RECORD_VIEW_SCHEMA_VERSION,
  RECORD_CHANGE_SCHEMA_VERSION,
  RecordChangeSchema,
} from '../maintenance-views'

type Schema<T> = {
  parse(value: unknown): T
}

type MaintenanceViewsModule = {
  RecordChangeSchema: Schema<unknown>
  InspectFilterSchema: Schema<unknown>
  guardInspectRecordView(value: unknown): unknown
}

function maintenanceViews(): MaintenanceViewsModule {
  const exports = knowledge as unknown as Partial<MaintenanceViewsModule>

  expect(exports.RecordChangeSchema, 'RecordChangeSchema export').toBeDefined()
  expect(exports.InspectFilterSchema, 'InspectFilterSchema export').toBeDefined()
  expect(exports.guardInspectRecordView, 'guardInspectRecordView export').toBeDefined()

  return exports as MaintenanceViewsModule
}

describe('maintenance view contracts', () => {
  it('preserves the older promoted fixture and optionally carries its receipt', () => {
    const legacy = { schemaVersion: RECORD_CHANGE_SCHEMA_VERSION, recordId: 'record-1', change: 'promoted', atOrdinal: 42 }
    expect(RecordChangeSchema.parse(legacy)).toEqual(legacy)
    const attributed = {
      ...legacy, promotionPath: 'user-sovereign', promotionReceiptDigest: 'a'.repeat(64),
    }
    expect(RecordChangeSchema.parse(attributed)).toEqual(attributed)
    expect(RecordChangeSchema.safeParse({ ...legacy, promotionPath: 'sovereign' }).success).toBe(false)
    expect(RecordChangeSchema.safeParse({ ...attributed, promotionReceiptDigest: 'invalid' }).success).toBe(false)
  })

  it.each(['added', 'confirmed', 'superseded', 'deprecated', 'purged'] as const)(
    'refuses both promotion fields on %s at their own paths', (change) => {
      for (const field of ['promotionPath', 'promotionReceiptDigest'] as const) {
        const result = RecordChangeSchema.safeParse({
          schemaVersion: RECORD_CHANGE_SCHEMA_VERSION, recordId: 'record-1', change, atOrdinal: 42,
          [field]: field === 'promotionPath' ? 'user-sovereign' : 'a'.repeat(64),
        })
        expect(result.success).toBe(false)
        if (!result.success) expect(result.error.issues.map(issue => issue.path)).toEqual([[field]])
      }
    },
  )
  it.each([
    'added',
    'confirmed',
    'superseded',
    'deprecated',
    'promoted',
    'purged',
  ] as const)('accepts the %s record-change kind', (change) => {
    const { RecordChangeSchema } = maintenanceViews()

    expect(RecordChangeSchema.parse({
      schemaVersion: RECORD_CHANGE_SCHEMA_VERSION,
      recordId: 'record-1',
      change,
      atOrdinal: 42,
      ...(change === 'superseded' ? { byRecordId: 'record-2' } : {}),
    })).toMatchObject({ change })
  })

  it('rejects an unknown record-change kind', () => {
    const { RecordChangeSchema } = maintenanceViews()

    expect(() => RecordChangeSchema.parse({
      schemaVersion: RECORD_CHANGE_SCHEMA_VERSION,
      recordId: 'record-1',
      change: 'mutated',
      atOrdinal: 42,
    })).toThrow()
  })

  it('keeps inspect filters closed over dimensions, statuses, and ordinals', () => {
    const { InspectFilterSchema } = maintenanceViews()

    expect(InspectFilterSchema.parse({})).toEqual({})
    expect(InspectFilterSchema.parse({ status: 'superseded', asOfBuild: 0 }))
      .toEqual({ status: 'superseded', asOfBuild: 0 })
    expect(() => InspectFilterSchema.parse({ query: 'free text' })).toThrow()
    expect(() => InspectFilterSchema.parse({ status: 'invented' })).toThrow()
    expect(() => InspectFilterSchema.parse({ asOfBuild: -1 })).toThrow()
  })

  it('round-trips a valid inspect view and rejects a wrong schema version', () => {
    const { guardInspectRecordView } = maintenanceViews()
    const view = {
      schemaVersion: INSPECT_RECORD_VIEW_SCHEMA_VERSION,
      recordId: 'record-1',
      product: 'shop',
      scope: 'product:shop',
      kind: 'fact',
      status: 'active',
      confirmations: 2,
      contradictions: 1,
      evidenceTokens: ['evidence-1'],
      lastEventOrdinal: 42,
      openedAtOrdinal: 10,
      closedAtOrdinal: 50,
      anchors: ['page:/checkout'],
      trustNarrative: 'Observed twice during checkout.',
    }

    expect(guardInspectRecordView(view)).toEqual(view)
    for (const schemaVersion of [1, 3]) {
      expect(() => guardInspectRecordView({ ...view, schemaVersion })).toThrow()
    }
  })
})
