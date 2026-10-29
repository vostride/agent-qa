import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  CURRENT_DRAFT_RECEIPT_SCHEMA_VERSION,
  type DraftReceipt,
} from '@vostride/agent-qa-schema'
import { afterEach, describe, expect, it } from 'vitest'

import {
  createDraftReceiptsStore,
  DRAFT_RECEIPTS_DIR_NAME,
  DraftReceiptDigestError,
  DraftReceiptSchemaVersionError,
} from '../draft-receipts-store.js'

const DIGEST_A = 'a'.repeat(64)
const DIGEST_B = 'b'.repeat(64)

function receiptFixture(overrides: {
  contentDigest?: string
  disposition?: DraftReceipt['disposition']
  evaluatedAt?: number
} = {}): DraftReceipt {
  return {
    schemaVersion: CURRENT_DRAFT_RECEIPT_SCHEMA_VERSION,
    draftRef: {
      filePath: 'drafts/checkout.test.yaml',
      testId: 'drafts/checkout.test.yaml::checkout happy path',
      testName: 'checkout happy path',
      contentDigest: overrides.contentDigest ?? DIGEST_A,
    },
    gates: {
      executesDefinitive: { pass: true, runRefs: ['run-1'], indefinitiveRunRefs: [] },
      stableVerdict: {
        pass: true,
        runRefs: ['run-1'],
        distinctOutcomes: ['healed'],
        earlyStopped: false,
      },
      addsValue: { pass: true, novelElementCount: 1, comparedTestCount: 2 },
      falsifiableAssertion: {
        pass: true,
        assertionStepCount: 1,
        falsifiableAssertionCount: 1,
      },
    },
    stepTable: [{
      stepText: 'assert the order number is shown',
      role: 'assertion',
      falsifiable: true,
      captureSignatureHits: [],
    }],
    // F3: the definitive-pass arm arrives as `healed`, so the fixture carries one — a store that
    // round-trips only the tidy shapes is not round-tripping the shape this phase measured.
    gateRuns: [{ runId: 'run-1', memberOutcome: 'healed', definitive: true, healed: true }],
    addsValueFinding: {
      novelElements: ['{"anchor":{"name":"order number","ordinal":0,"role":"text","t":"el"}}'],
      comparedTests: [{
        filePath: 'suite/checkout.test.ts',
        testName: 'checkout happy path',
        lane: 'fingerprint',
        covered: false,
      }],
    },
    stabilityRunsRequested: 3,
    stabilityRunsCompleted: 3,
    disposition: overrides.disposition ?? 'keep-eligible',
    evaluatedAt: overrides.evaluatedAt ?? 1_700_000_000_000,
  }
}

const tempDirs: string[] = []

function agentQaRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'draft-receipts-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function storeAt(root: string): ReturnType<typeof createDraftReceiptsStore> {
  return createDraftReceiptsStore({ resolveAgentQaRoot: () => root })
}

function receiptsDir(root: string): string {
  return join(root, DRAFT_RECEIPTS_DIR_NAME)
}

describe('the draft-receipts store (the proposals-store idiom)', () => {
  it('round-trips a receipt by its draftRef.contentDigest', async () => {
    const root = agentQaRoot()
    const store = storeAt(root)
    const receipt = receiptFixture()

    await store.put(receipt)

    expect(await store.get(DIGEST_A)).toEqual(receipt)
    expect(await store.list()).toEqual([receipt])
    // The filename scheme is part of the contract: one `<contentDigest>.json` per draft, so a
    // human (and a later reaper) can find a receipt from the digest alone.
    expect(readdirSync(receiptsDir(root))).toEqual([`${DIGEST_A}.json`])
  })

  it('replaces the record on a second put for the same digest', async () => {
    const root = agentQaRoot()
    const store = storeAt(root)
    await store.put(receiptFixture())
    const rerun = receiptFixture({ disposition: 'rejected', evaluatedAt: 1_700_000_999_000 })

    await store.put(rerun)

    expect(await store.get(DIGEST_A)).toEqual(rerun)
    // ONE file, not two: the replacement is a rename over the same name, never an accumulation.
    expect(readdirSync(receiptsDir(root))).toEqual([`${DIGEST_A}.json`])
  })

  it('returns undefined from a store whose directory does not exist', async () => {
    const store = storeAt(agentQaRoot())

    expect(await store.get(DIGEST_A)).toBeUndefined()
    // An absent directory and an empty store are the SAME answer about the same project.
    expect(await store.list()).toEqual([])
  })

  it('hard-fails on a persisted schemaVersion mismatch instead of coercing it', async () => {
    const root = agentQaRoot()
    const store = storeAt(root)
    await store.put(receiptFixture())
    const path = join(receiptsDir(root), `${DIGEST_A}.json`)
    const stored = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    writeFileSync(
      path,
      JSON.stringify({ ...stored, schemaVersion: CURRENT_DRAFT_RECEIPT_SCHEMA_VERSION + 1 }),
      'utf8',
    )

    await expect(store.get(DIGEST_A)).rejects.toThrow(DraftReceiptSchemaVersionError)
    await expect(store.list()).rejects.toThrow(DraftReceiptSchemaVersionError)
  })

  it('refuses a digest that would join outside the receipts directory', async () => {
    const root = agentQaRoot()
    const store = storeAt(root)
    mkdirSync(receiptsDir(root), { recursive: true })
    writeFileSync(join(root, 'escaped.json'), JSON.stringify(receiptFixture()), 'utf8')

    await expect(store.get('../escaped')).rejects.toThrow(DraftReceiptDigestError)
    await expect(store.put({
      ...receiptFixture(),
      draftRef: { ...receiptFixture().draftRef, contentDigest: '../escaped' },
    })).rejects.toThrow(DraftReceiptDigestError)
    // The refusal leaves no probe behind: nothing was read, nothing was written.
    expect(readdirSync(receiptsDir(root))).toEqual([])
  })

  it('refuses to persist a record the receipt schema rejects', async () => {
    const root = agentQaRoot()
    const store = storeAt(root)

    await expect(store.put({
      ...receiptFixture(),
      // A run payload smuggled onto the receipt. `.strict()` refuses it on the way OUT, so a
      // malformed document is never written for a later reader to discover.
      handoff: { runId: 'run-1' },
    } as unknown as DraftReceipt)).rejects.toThrow()

    // The refusal fires before the directory is even created — a rejected receipt leaves the
    // store in exactly the state it was in, with no empty dir to explain later.
    expect(existsSync(receiptsDir(root))).toBe(false)
  })

  it('lists every stored receipt in a deterministic order', async () => {
    const root = agentQaRoot()
    const store = storeAt(root)
    const second = receiptFixture({ contentDigest: DIGEST_B })
    await store.put(second)
    await store.put(receiptFixture())

    expect((await store.list()).map((entry) => entry.draftRef.contentDigest)).toEqual([
      DIGEST_A,
      DIGEST_B,
    ])
  })

  it('never enumerates an in-flight temp file', async () => {
    const root = agentQaRoot()
    const store = storeAt(root)
    await store.put(receiptFixture())
    writeFileSync(join(receiptsDir(root), `${DIGEST_B}.json.4242.tmp`), '{ half a doc', 'utf8')

    expect((await store.list()).map((entry) => entry.draftRef.contentDigest)).toEqual([DIGEST_A])
  })

  it('a receipt stored without a session ref lists with sessionRef absent', async () => {
    const root = agentQaRoot()
    const store = storeAt(root)
    await store.put(receiptFixture())

    const bytes = readFileSync(join(receiptsDir(root), `${DIGEST_A}.json`), 'utf8')
    expect(bytes).not.toContain('sessionRef')
    const listed = await store.list()
    expect(listed.map((entry) => entry.draftRef.contentDigest)).toEqual([DIGEST_A])
    // Absent, never defaulted in: a session-scoped window must leave this receipt out rather
    // than attribute it to whichever session happens to be asking.
    expect(listed[0]).not.toHaveProperty('sessionRef')
    expect((await store.get(DIGEST_A))?.sessionRef).toBeUndefined()
  })

  it('refuses a receipt stamped 1 by name', async () => {
    const root = agentQaRoot()
    const store = storeAt(root)
    await store.put(receiptFixture())
    const path = join(receiptsDir(root), `${DIGEST_A}.json`)
    const stored = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    writeFileSync(path, JSON.stringify({ ...stored, schemaVersion: 1 }), 'utf8')

    const refusal = expect.objectContaining({
      name: 'DraftReceiptSchemaVersionError',
      path,
      foundVersion: 1,
    })
    await expect(store.get(DIGEST_A)).rejects.toThrowError(refusal)
    await expect(store.list()).rejects.toThrowError(refusal)
  })

  it('round-trips a receipt that DOES carry a session ref', async () => {
    const root = agentQaRoot()
    const store = storeAt(root)
    await store.put({ ...receiptFixture(), sessionRef: 'sess-alpha' })

    expect((await store.get(DIGEST_A))?.sessionRef).toBe('sess-alpha')
  })
})
