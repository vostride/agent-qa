import { join } from 'node:path'

import { afterAll, describe, expect, it } from 'vitest'
import { CurationSnapshotSchema, CURATION_SNAPSHOT_SCHEMA_VERSION } from '@vostride/agent-qa-schema'

import {
  PERMITTED_RUN_RECEIPT_DIFF_FIELDS,
  SNAPSHOT_BOUND_RUN_RECEIPT_FIELDS,
  buildFixture,
  compareRunReceipts,
  payloadsForFixture,
  writeFixture,
} from './fixtures.js'
import { LOGICAL_DUMP_EXCLUDED_COLUMNS } from './logical-dump.js'
import {
  DUAL_HOST_ENV,
  LEG_TIMEOUT_MS,
  cleanupDualHostRoots,
  makeRoot,
  runLeg,
  type LegReport,
} from './spawn-helpers.js'

function assertCompletedSnapshot(oneShot: LegReport, daemon: LegReport, expectedCount: number) {
  const snapshot = CurationSnapshotSchema.parse(oneShot.runReceipt.snapshot)
  expect(snapshot.breakdown).toEqual({ added: expectedCount, confirmed: 0, superseded: 0,
    deprecated: 0, proposed: 0 })
  const tables = JSON.parse(oneShot.logicalDump) as Array<{
    table: string; rows: Array<{ bundle_id: string }>
  }>
  expect(snapshot.rows.map(row => row.recordId).sort()).toEqual(
    tables.find(table => table.table === 'records')!.rows.map(row => row.bundle_id).sort(),
  )
  expect(daemon.runReceipt).not.toHaveProperty('snapshot')
  // The inline drain records its counts beside the snapshot; the hand-off has none of its own.
  expect(SNAPSHOT_BOUND_RUN_RECEIPT_FIELDS).toEqual(['curated', 'deprecated'])
  expect(oneShot.runReceipt).toMatchObject({ curated: expectedCount, deprecated: 0 })
  for (const field of SNAPSHOT_BOUND_RUN_RECEIPT_FIELDS) expect(daemon.runReceipt).not.toHaveProperty(field)
  // Equal completed snapshots remain comparable, and a snapshot is never an ignored field.
  expect(() => compareRunReceipts(oneShot.runReceipt, { ...oneShot.runReceipt })).not.toThrow()
  const empty = { schemaVersion: CURATION_SNAPSHOT_SCHEMA_VERSION, rows: [], breakdown: {
    added: 0, confirmed: 0, superseded: 0, deprecated: 0, proposed: 0,
  } }
  expect(() => compareRunReceipts(oneShot.runReceipt, { ...oneShot.runReceipt, snapshot: empty }))
    .toThrow(/snapshot/u)
  expect(() => compareRunReceipts({ ...oneShot.runReceipt, snapshot: {
    ...snapshot, breakdown: { ...snapshot.breakdown, added: expectedCount + 1 },
  } }, daemon.runReceipt)).toThrow(/snapshot/u)
  const { snapshot: omitted, ...withoutSnapshot } = oneShot.runReceipt
  expect(omitted).toBeDefined()
  expect(() => compareRunReceipts(withoutSnapshot, { ...daemon.runReceipt, snapshot }))
    .toThrow(/snapshot/u)
  expect(() => compareRunReceipts(withoutSnapshot, daemon.runReceipt)).toThrow(/curated, deprecated/u)
  expect(() => compareRunReceipts(oneShot.runReceipt, { ...daemon.runReceipt, curated: expectedCount, deprecated: 0 }))
    .toThrow(/curated, deprecated/u)
  expect(() => compareRunReceipts({ ...oneShot.runReceipt, curated: -1 }, daemon.runReceipt)).toThrow(/curated/u)
  const withoutCounts = Object.fromEntries(Object.entries(oneShot.runReceipt)
    .filter(([key]) => !(SNAPSHOT_BOUND_RUN_RECEIPT_FIELDS as readonly string[]).includes(key)))
  expect(() => compareRunReceipts(oneShot.runReceipt, withoutCounts)).toThrow(/curated, deprecated/u)
  expect(() => compareRunReceipts({ ...oneShot.runReceipt, drainKind: 'handed-off' }, daemon.runReceipt))
    .toThrow(/snapshot/u)
}

const childMode = process.env[DUAL_HOST_ENV.child] === '1'

if (childMode) {
  it('runs the selected dual-host child leg', async () => {
    const host = process.env[DUAL_HOST_ENV.host]
    if (host === 'one-shot') {
      const { runOneShotLeg } = await import('./one-shot-leg.fixture.js')
      await runOneShotLeg()
      return
    }
    if (host === 'daemon') {
      const { runDaemonLeg } = await import('./daemon-leg.fixture.js')
      await runDaemonLeg()
      return
    }
    throw new Error(`unsupported dual-host child role: ${String(host)}`)
  }, LEG_TIMEOUT_MS)
} else {
  afterAll(cleanupDualHostRoots)

  describe('dual-host byte identity', () => {
    it('leaves byte-identical bundles and ordered logical rows for mixed run postures', async () => {
    const fixtureRoot = makeRoot('fixture-mixed')
    const fixtureFile = join(fixtureRoot.root, 'shared-fixture.json')
    const fixture = buildFixture('mixed')
    writeFixture(fixtureFile, fixture)

    const oneShot = await runLeg('one-shot', makeRoot('one-shot-mixed'), fixtureFile, 'mixed')
    const daemon = await runLeg('daemon', makeRoot('daemon-mixed'), fixtureFile, 'mixed')

    expect(oneShot.bundleTree).toBe(daemon.bundleTree)
    expect(oneShot.logicalDump).toBe(daemon.logicalDump)
    // The direct sweep leases reconcile and drain separately; the daemon holds one lease for both.
    expect(oneShot.epoch).toBe(2)
    expect(daemon.epoch).toBe(1)
    expect(oneShot.bundleCount).toBe(2)
    expect(daemon.bundleCount).toBe(2)
    expect(oneShot.candidateIds).toEqual(daemon.candidateIds)
    expect(oneShot.authorOrder).toEqual([...fixture.candidates]
      .map(({ candidateId }) => candidateId)
      .sort())
    expect(daemon.authorOrder).toEqual(oneShot.authorOrder)
    expect(oneShot.commitOrder).toEqual(oneShot.authorOrder)
    expect(daemon.commitOrder).toEqual(oneShot.commitOrder)
    expect(oneShot.dispositions).toEqual(daemon.dispositions)
    const payloads = payloadsForFixture(fixture)
    const localId = payloads.find(({ executionContext }) =>
      executionContext === 'local-interactive')?.candidateId
    const ciId = payloads.find(({ executionContext }) => executionContext === 'ci')?.candidateId
    expect(oneShot.dispositions.find(({ candidateId }) => candidateId === localId))
      .toMatchObject({ status: 'active' })
    expect(oneShot.dispositions.find(({ candidateId }) => candidateId === ciId))
      .toMatchObject({ status: 'candidate' })
    expect(oneShot.embedStatuses).toEqual(['pending', 'pending'])

    const dump = JSON.parse(oneShot.logicalDump) as Array<{
      table: string
      columns: string[]
      orderByColumns: string[]
    }>
    expect(LOGICAL_DUMP_EXCLUDED_COLUMNS).toEqual(['embedding'])
    for (const table of dump) {
      expect(table.orderByColumns, `${table.table} must order by every selected column`)
        .toEqual(table.columns)
      expect(table.columns).not.toContain('embedding')
    }
    const records = dump.find(({ table }) => table === 'records')
    expect(records?.columns).toContain('embed_status')

    expect(PERMITTED_RUN_RECEIPT_DIFF_FIELDS).toEqual([
      'drainKind',
      'handoffHolderPid',
    ])
    assertCompletedSnapshot(oneShot, daemon, 2)
    expect(() => compareRunReceipts(oneShot.runReceipt, daemon.runReceipt)).not.toThrow()
    expect(oneShot.runReceipt).toMatchObject({
      drainKind: 'drained',
      handoffHolderPid: null,
      candidateIds: oneShot.candidateIds,
    })
    expect(daemon.runReceipt).toMatchObject({
      drainKind: 'handed-off',
      handoffHolderPid: daemon.pid,
      candidateIds: daemon.candidateIds,
    })
    expect(oneShot.sessionReceipts).toEqual([])
    expect(daemon.sessionReceipts).toHaveLength(1)
    expect(daemon.sessionReceipts[0]).toMatchObject({
      epoch: 1,
      candidateIds: daemon.candidateIds,
      remainingAfter: 0,
    })

    const mutatedReceipt = {
      ...daemon.runReceipt,
      projectionVersion: Number(daemon.runReceipt.projectionVersion) + 1,
    }
    expect(() => compareRunReceipts(oneShot.runReceipt, mutatedReceipt))
      .toThrow(/projectionVersion/u)
    }, LEG_TIMEOUT_MS)

    it('keeps the daemon lease alive through an over-TTL author call', async () => {
      const fixtureRoot = makeRoot('fixture-over-ttl')
      const fixtureFile = join(fixtureRoot.root, 'shared-fixture.json')
      const fixture = buildFixture('over-ttl')
      writeFixture(fixtureFile, fixture)

      const oneShot = await runLeg(
        'one-shot',
        makeRoot('one-shot-over-ttl'),
        fixtureFile,
        'over-ttl',
      )
      const daemon = await runLeg(
        'daemon',
        makeRoot('daemon-over-ttl'),
        fixtureFile,
        'over-ttl',
      )

      expect(oneShot.bundleTree).toBe(daemon.bundleTree)
      expect(oneShot.logicalDump).toBe(daemon.logicalDump)
      expect(oneShot.epoch).toBe(2)
      expect(daemon.epoch).toBe(1)
      expect(oneShot.commitOrder).toEqual([...oneShot.candidateIds].sort())
      expect(daemon.commitOrder).toEqual(oneShot.commitOrder)
      assertCompletedSnapshot(oneShot, daemon, fixture.candidates.length)
      expect(() => compareRunReceipts(oneShot.runReceipt, daemon.runReceipt)).not.toThrow()
      expect(daemon.sessionReceipts).toHaveLength(1)
      expect(daemon.sessionReceipts[0]).toMatchObject({
        epoch: 1,
        candidateIds: [...fixture.candidates].map(({ candidateId }) => candidateId).sort(),
        remainingAfter: 0,
      })

      const eventKinds = daemon.daemonEvents.map(({ kind }) => kind)
      expect(eventKinds.filter((kind) => kind === 'epoch-bump')).toHaveLength(1)
      expect(eventKinds.filter((kind) => kind === 'lease-heartbeated').length)
        .toBeGreaterThanOrEqual(3)
      expect(eventKinds).not.toContain('lease-lost')
      expect(eventKinds.some((kind) => String(kind).includes('reclaim'))).toBe(false)
    }, LEG_TIMEOUT_MS)

    it('leaves identical fresh stores for an empty candidate set', async () => {
      const fixtureRoot = makeRoot('fixture-empty')
      const fixtureFile = join(fixtureRoot.root, 'shared-fixture.json')
      const fixture = buildFixture('empty')
      writeFixture(fixtureFile, fixture)

      const oneShot = await runLeg('one-shot', makeRoot('one-shot-empty'), fixtureFile, 'empty')
      const daemon = await runLeg('daemon', makeRoot('daemon-empty'), fixtureFile, 'empty')

      expect(oneShot.bundleTree).toBe(daemon.bundleTree)
      expect(oneShot.logicalDump).toBe(daemon.logicalDump)
      expect(oneShot.bundleCount).toBe(0)
      expect(daemon.bundleCount).toBe(0)
      expect(oneShot.authorOrder).toEqual([])
      expect(daemon.authorOrder).toEqual([])
      expect(oneShot.commitOrder).toEqual([])
      expect(daemon.commitOrder).toEqual([])
      expect(oneShot.epoch).toBe(2)
      expect(daemon.epoch).toBe(1)
      expect(() => compareRunReceipts(oneShot.runReceipt, daemon.runReceipt)).not.toThrow()
      expect(oneShot.runReceipt.candidateIds).toEqual([])
      expect(daemon.runReceipt.candidateIds).toEqual([])
      expect(oneShot.sessionReceipts).toEqual([])
      expect(daemon.sessionReceipts).toEqual([])
    }, LEG_TIMEOUT_MS)
  })
}
