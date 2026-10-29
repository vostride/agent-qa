// RED-first pins for the run-start quarantine snapshot.
//
// The local composition root folds the committed ledger ONCE at run start and hands the resolved
// set into the run as plain data. Folding once is what makes the disposition deterministic for the
// whole run — a mid-run ledger edit can never retroactively change a running build (the same
// posture `executionContext` resolution already has).
//
// A ledger read failure DEGRADES to an empty set with a printed warning. A broken ledger can never
// abort a run.

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createQuarantineOperations } from '@vostride/agent-qa-knowledge-local'
import { QUARANTINE_LEDGER_FILENAME } from '@vostride/agent-qa-knowledge-local/reader'
import {
  CURRENT_QUARANTINE_LEDGER_SCHEMA_VERSION,
  QUARANTINE_UNASSIGNED_OWNER,
} from '@vostride/agent-qa-schema'

import { resolveRunQuarantineSnapshot } from '../composition/quarantine-snapshot.js'

const RUN_START_NOW = '2026-08-20T10:00:00.000Z'
const ACTIVE_EXPIRY = '2026-09-04T10:00:00.000Z'
const LAPSED_EXPIRY = '2026-08-01T10:00:00.000Z'

function entered(fields: {
  product: string
  filePath: string
  testName: string
  expiresAt: string
}): string {
  return JSON.stringify({
    schemaVersion: CURRENT_QUARANTINE_LEDGER_SCHEMA_VERSION,
    kind: 'entered',
    at: '2026-07-20T10:00:00.000Z',
    fingerprint: 'fp-1',
    verdictClass: 'flake',
    owner: QUARANTINE_UNASSIGNED_OWNER,
    ...fields,
  })
}

describe('resolveRunQuarantineSnapshot', () => {
  let knowledgeRoot: string
  let warnings: string[]

  beforeEach(async () => {
    knowledgeRoot = await mkdtemp(join(tmpdir(), 'quarantine-snapshot-'))
    warnings = []
  })

  afterEach(async () => {
    await rm(knowledgeRoot, { recursive: true, force: true })
  })

  async function writeLedger(lines: readonly string[]): Promise<void> {
    await writeFile(join(knowledgeRoot, QUARANTINE_LEDGER_FILENAME), lines.join('\n') + '\n', 'utf8')
  }

  function snapshot(product = 'example-web'): readonly unknown[] {
    return resolveRunQuarantineSnapshot({
      knowledgeRoot,
      product,
      now: RUN_START_NOW,
      warn: (message: string) => warnings.push(message),
    })
  }

  it('answers the active, product-matched entries as plain data', async () => {
    await writeLedger([
      entered({
        product: 'example-web',
        filePath: 'tests/checkout.test.yaml',
        testName: 'checkout completes',
        expiresAt: ACTIVE_EXPIRY,
      }),
    ])

    expect(snapshot()).toEqual([
      {
        product: 'example-web',
        filePath: 'tests/checkout.test.yaml',
        testName: 'checkout completes',
        expiresAt: ACTIVE_EXPIRY,
      },
    ])
    expect(warnings).toEqual([])
  })

  it('excludes lapsed entries — an expired entry is NOT applied', async () => {
    await writeLedger([
      entered({
        product: 'example-web',
        filePath: 'tests/checkout.test.yaml',
        testName: 'checkout completes',
        expiresAt: LAPSED_EXPIRY,
      }),
    ])
    expect(snapshot()).toEqual([])
  })

  it('excludes released entries', async () => {
    await writeLedger([
      entered({
        product: 'example-web',
        filePath: 'tests/checkout.test.yaml',
        testName: 'checkout completes',
        expiresAt: ACTIVE_EXPIRY,
      }),
      JSON.stringify({
        schemaVersion: CURRENT_QUARANTINE_LEDGER_SCHEMA_VERSION,
        kind: 'released-manual',
        at: '2026-08-10T10:00:00.000Z',
        product: 'example-web',
        filePath: 'tests/checkout.test.yaml',
        testName: 'checkout completes',
      }),
    ])
    expect(snapshot()).toEqual([])
  })

  it('filters by the slugged product so another product never bleeds in', async () => {
    await writeLedger([
      entered({
        product: 'example-web',
        filePath: 'tests/checkout.test.yaml',
        testName: 'checkout completes',
        expiresAt: ACTIVE_EXPIRY,
      }),
      entered({
        product: 'other-web',
        filePath: 'tests/other.test.yaml',
        testName: 'other test',
        expiresAt: ACTIVE_EXPIRY,
      }),
    ])
    expect(snapshot('example-web')).toHaveLength(1)
    expect(snapshot('other-web')).toEqual([
      {
        product: 'other-web',
        filePath: 'tests/other.test.yaml',
        testName: 'other test',
        expiresAt: ACTIVE_EXPIRY,
      },
    ])
  })

  it('matches the projection partition law — the raw scope key is slugged before comparing', async () => {
    await writeLedger([
      entered({
        // slugBranch('feature/checkout') === 'feature-checkout'
        product: 'feature-checkout',
        filePath: 'tests/checkout.test.yaml',
        testName: 'checkout completes',
        expiresAt: ACTIVE_EXPIRY,
      }),
    ])
    expect(snapshot('feature/checkout')).toHaveLength(1)
  })

  it('folds a missing ledger to an empty set with no warning', () => {
    expect(snapshot()).toEqual([])
    expect(warnings).toEqual([])
  })

  it('surfaces refused lines as a warning while still applying the healthy entries', async () => {
    await writeLedger([
      '{ not json at all',
      entered({
        product: 'example-web',
        filePath: 'tests/checkout.test.yaml',
        testName: 'checkout completes',
        expiresAt: ACTIVE_EXPIRY,
      }),
    ])
    expect(snapshot()).toHaveLength(1)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain(QUARANTINE_LEDGER_FILENAME)
  })

  it('degrades a hard ledger failure to an empty set with a warning — never a run abort', async () => {
    await writeLedger([
      entered({
        product: 'example-web',
        filePath: 'tests/checkout.test.yaml',
        testName: 'checkout completes',
        expiresAt: ACTIVE_EXPIRY,
      }).replace(
        `"schemaVersion":${CURRENT_QUARANTINE_LEDGER_SCHEMA_VERSION}`,
        '"schemaVersion":99',
      ),
    ])
    expect(snapshot()).toEqual([])
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatch(/schemaVersion/)
  })

  // ---- the two-sided pin: the human WRITE verb against this READER --------
  //
  // The defect this closes was invisible to every single-sided fixture. The writer half lives in
  // `knowledge-local` and the reader half lives here; each is internally consistent, and they
  // disagreed about what a `product` IS — `add` stored the spelling a human typed, this reader
  // filters on `slugBranch` of it. So `quarantine.add({product: 'My Product'})` answered `entered`,
  // the ledger recorded a real entry, and the test it named kept failing every build.
  //
  // It is pinned HERE rather than beside the verb because the two halves cannot be brought into one
  // package: `agent-local` depends on `knowledge-local`, never the reverse. Nothing but the ledger
  // file passes between them below — the writer is driven entirely through the real port.

  describe('a human quarantine.add against this reader', () => {
    const ADD_NOW = '2026-08-15T10:00:00.000Z'
    /** ADD_NOW + the pinned 30-day default lifetime — still suppressing at RUN_START_NOW. */
    const ADDED_EXPIRY = '2026-09-14T10:00:00.000Z'
    const HUMAN_PRODUCT = 'My Product'
    const SLUGGED_PRODUCT = 'My-Product'
    const TEST_FILE = 'tests/checkout.yaml'
    const TEST_NAME = 'checkout completes'

    function verbs(): ReturnType<typeof createQuarantineOperations> {
      return createQuarantineOperations({
        resolveKnowledgeRoot: () => knowledgeRoot,
        now: () => ADD_NOW,
        // this pin is about the PRODUCT partition, and its fixture already speaks the
        // canonical `tests/checkout.yaml`, so a passthrough leaves what it measures unchanged. The
        // filePath leg's own two-sided pin — real mint, real verbs, real reader, two checkout roots
        // — is `cli/src/__tests__/quarantine-ledger-portability.test.ts`, the one layer where every
        // part can be production code.
        mintIdentityPath: (filePath: string) => filePath,
      })
    }

    it('is APPLIED by the next run under the same unslugged spelling the human typed', async () => {
      const answer = await verbs().add({
        product: HUMAN_PRODUCT,
        filePath: TEST_FILE,
        testName: TEST_NAME,
      })
      expect(answer.kind).toBe('entered')

      expect(snapshot(HUMAN_PRODUCT)).toEqual([
        {
          product: SLUGGED_PRODUCT,
          filePath: TEST_FILE,
          testName: TEST_NAME,
          expiresAt: ADDED_EXPIRY,
        },
      ])
      expect(warnings).toEqual([])
    })

    it('is dropped again by the human release verb — the exit path closes what it opened', async () => {
      await verbs().add({ product: HUMAN_PRODUCT, filePath: TEST_FILE, testName: TEST_NAME })
      const released = await verbs().release({
        product: HUMAN_PRODUCT,
        filePath: TEST_FILE,
        testName: TEST_NAME,
      })

      expect(released.kind).toBe('released')
      expect(snapshot(HUMAN_PRODUCT)).toEqual([])
    })

    it('does NOT leak into a different product that merely slugs alike-looking bytes', async () => {
      await verbs().add({ product: HUMAN_PRODUCT, filePath: TEST_FILE, testName: TEST_NAME })

      // The partition still partitions: normalizing is not the same as collapsing.
      expect(snapshot('Other Product')).toEqual([])
    })
  })
})
