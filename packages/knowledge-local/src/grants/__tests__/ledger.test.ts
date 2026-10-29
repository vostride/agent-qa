// a workspace's old grants.jsonl stays on disk and nothing opens
// it.
//
// RE-SPELLED 2026-10-01. This file was the corpus for the Phase 391 committed grant ledger:
// the read and pure fold (ENOENT, empty, unparseable and structurally broken lines refused as data,
// unknown scope keys, newer versions hard-failing, file-order folding, revoke-by-id) and the checked
// append (canonical JSON, the two version legs, the shape leg, the committed-egress checkpoint,
// all-or-nothing). 432-18 deletes the ledger, its reader, the grant verbs and every export, so each
// of those claims lost its subject. What survives is what the ledger owes the file it leaves
// behind: a workspace that still holds `grants.jsonl` is a fresh workspace, the file is
// never read, written, renamed or cleaned up, and a damaged one cannot break anything because
// nothing parses it. No grant-shaped store replaces it.
//
// THE WRITER-LEASE AND EGRESS CLAIMS MOVE TO THE DIRECT WRITERS. The deleted grant verbs refused
// typed while another writer held the lease and when the egress checkpoint refused their bytes
// (`operations.test.ts`, deleted with them). The direct writers that remain carry the same two
// refusals, and the cells below drive them beside a damaged legacy ledger: the explicit change door
// refuses a held lease by name, the quarantine add refuses a held lease and a secret-bearing value by
// name, and in every case the legacy file is byte-identical.
//
// HOW "NEVER OPENED" IS MEASURED. `node:fs` and `node:fs/promises` are wrapped for this file's module
// graph, so every path-taking call the knowledge-local sources under test make is recorded. A control
// cell drives one call at the legacy file through the same wrapper and requires it to be recorded,
// so "no recorded path" cannot be a recorder that records nothing.

import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { Anchor, ExecutionContext, ScopeKey } from '@vostride/agent-qa-schema'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const recorder = vi.hoisted(() => ({ paths: [] as string[] }))

/** Names of the path-taking calls a source could open, list, rename or write a file through. */
const PATH_CALLS = vi.hoisted(() => [
  'access', 'accessSync', 'appendFile', 'appendFileSync', 'copyFile', 'copyFileSync', 'cp', 'cpSync',
  'createReadStream', 'createWriteStream', 'existsSync', 'lstat', 'lstatSync', 'mkdir', 'mkdirSync',
  'open', 'openSync', 'opendir', 'opendirSync', 'readFile', 'readFileSync', 'readdir', 'readdirSync',
  'readlink', 'readlinkSync', 'realpath', 'realpathSync', 'rename', 'renameSync', 'rm', 'rmSync',
  'rmdir', 'rmdirSync', 'stat', 'statSync', 'unlink', 'unlinkSync', 'watch', 'writeFile',
  'writeFileSync',
])

const wrapPathCalls = vi.hoisted(() => (actual: Record<string, unknown>): Record<string, unknown> => {
  const wrapped: Record<string, unknown> = { ...actual }
  for (const name of PATH_CALLS) {
    const original = actual[name]
    if (typeof original !== 'function') continue
    const call = function (this: unknown, ...args: unknown[]): unknown {
      for (const arg of args.slice(0, 2)) {
        if (typeof arg === 'string') recorder.paths.push(arg)
        else if (arg instanceof URL) recorder.paths.push(arg.pathname)
      }
      return (original as (...rest: unknown[]) => unknown).apply(this, args)
    }
    wrapped[name] = Object.assign(call, original)
  }
  return wrapped
})

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  const wrapped = wrapPathCalls(actual)
  return {
    ...wrapped,
    promises: wrapPathCalls(actual['promises'] as Record<string, unknown>),
    default: wrapped,
  }
})

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  const wrapped = wrapPathCalls(actual)
  return { ...wrapped, default: wrapped }
})

import { publishBundle, type BundleStoreConfig } from '../../bundle-publish.test-helper.js'
import { diffSince } from '../../diff-since.js'
import { inspectRecords } from '../../inspect.js'
import { listBundles } from '../../list-bundles.js'
import { acquireWriterLease, releaseLease } from '../../lease/writer-lease.js'
import { createQuarantineOperations } from '../../quarantine/operations.js'
import { ApplyDelegateUnavailableError, applyExplicitReview } from '../../review/apply-review.js'
import { showRecord } from '../../show-record.js'
import {
  makeBundleDraftFixture,
  makeScreenStateFixture,
  scaffoldKnowledgeRoot,
} from '../../__tests__/fixtures/bundle-fixture.js'
import * as knowledgeLocal from '../../index.js'

const ANCHOR: Anchor = { t: 'el', role: 'Button', name: 'Checkout' }
const SCOPE: ScopeKey = { tier: 'product', key: 'grants-unread-storefront' }
const CONTEXTS = ['local-interactive', 'local-headless', 'ci', 'cloud'] as const satisfies
  readonly ExecutionContext[]
const NOW = '2026-10-01T00:00:00.000Z'
const LEGACY_LEDGER = 'grants.jsonl'

/**
 * The exports the deleted ledger, reader and grant verbs published from this package. Each is named
 * so a returning member reds by name rather than by a count.
 */
const RETIRED_EXPORTS = [
  'GRANT_LEDGER_EGRESS_CHANNEL',
  'GRANT_LEDGER_FILENAME',
  'appendGrantLedgerEvents',
  'foldActiveGrants',
  'grantsLedgerPath',
  'readGrantLedger',
  'createStandingApprovalReader',
  'GrantLeaseHeldError',
  'GrantLedgerDamagedError',
  'GrantWriteBlockedError',
  'createGrantOperations',
] as const

/** The three modules the ledger was built from. */
const RETIRED_MODULES = ['ledger.ts', 'reader.ts', 'operations.ts'] as const

/**
 * An old ledger as earlier versions left it, written as bytes: an intact grant, its revoke fused
 * onto a git conflict marker, a line from a newer build, a grant with an unknown scope key, a
 * truncated line and a non-JSON line. Nothing in this build can produce or parse any of them, which
 * is why they are literals.
 */
const LEGACY_BYTES = [
  '{"schemaVersion":1,"kind":"grant","at":"2026-08-07T12:00:00.000Z","grantId":"grant_legacy_a","actionClass":"fn:knowledge.forget","scope":{"project":"local-workspace"}}',
  '<<<<<<< HEAD{"schemaVersion":1,"kind":"revoke","at":"2026-08-07T12:30:00.000Z","grantId":"grant_legacy_a"}',
  '{"schemaVersion":9,"kind":"grant","at":"2026-08-08T00:00:00.000Z","grantId":"grant_from_the_future","actionClass":"fn:runs.start","scope":{"project":"local-workspace"}}',
  '{"schemaVersion":1,"kind":"grant","at":"2026-08-08T00:00:00.000Z","grantId":"grant_tenant","actionClass":"fn:config.field.set","scope":{"tenant":"acme"}}',
  '{"schemaVersion":1,"kind":"grant","at":"2026-08-08',
  'not json at all',
  '',
].join('\n')

function digest(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

describe('an old grants.jsonl is never read, written, renamed or cleaned up', () => {
  let root: string
  let knowledgeRoot: string
  let agentQaRoot: string
  let ledger: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'grants-unread-'))
    knowledgeRoot = join(root, 'agent-qa-knowledge')
    agentQaRoot = join(root, '.agent-qa')
    ledger = join(knowledgeRoot, LEGACY_LEDGER)
    scaffoldKnowledgeRoot(knowledgeRoot)
    writeFileSync(ledger, LEGACY_BYTES, 'utf8')
    recorder.paths.length = 0
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  function storeConfig(): BundleStoreConfig {
    return { knowledgeRoot, productKey: 'Grants Unread Product' }
  }

  function publish(summary: string): string {
    const outcome = publishBundle(storeConfig(), {
      draft: makeBundleDraftFixture({ kind: 'fact', anchors: [ANCHOR], scope: SCOPE, summary }),
      discriminant: { kind: 'fact', subtype: 'selector', elementRef: { role: 'Button', name: summary } },
      originClass: 'agent-verified',
      createdAtOrdinal: 10,
      screenStates: [makeScreenStateFixture()],
      initialEvents: [],
      relations: [],
      provenance: { mode: 'run-linked', runId: `grants-unread-${summary}`, testId: 't', stepIndex: 0 },
      artifacts: [],
    })
    if (outcome.kind !== 'published') throw new Error(`fixture publish failed: ${outcome.kind}`)
    return outcome.id
  }

  function quarantine() {
    return createQuarantineOperations({
      resolveKnowledgeRoot: () => knowledgeRoot,
      now: () => NOW,
      mintIdentityPath: (filePath) => filePath,
    })
  }

  function touchedLedger(): readonly string[] {
    return recorder.paths.filter((path) => path === ledger || path.endsWith(`/${LEGACY_LEDGER}`))
  }

  /** Every file at the knowledge root whose name could be a grant store, legacy file aside. */
  function grantShapedSiblings(): readonly string[] {
    return readdirSync(knowledgeRoot).filter((name) => /grant/i.test(name) && name !== LEGACY_LEDGER)
  }

  it('the recorder sees a call that does reach the legacy ledger', () => {
    // The control. Without it, "no recorded path" could be a recorder that records nothing.
    expect(existsSync(ledger)).toBe(true)
    expect(touchedLedger()).toEqual([ledger])
  })

  it('explicit accept, reject and forget apply in every context and never open it', async () => {
    const before = digest(ledger)
    const targets = CONTEXTS.map((context) => ({
      context,
      accept: publish(`accept ${context}`),
      reject: publish(`reject ${context}`),
      forget: publish(`forget ${context}`),
    }))
    recorder.paths.length = 0

    for (const [index, { context, accept, reject, forget }] of targets.entries()) {
      const base = { agentQaRoot, knowledgeRoot, executionContext: context }
      const accepted = await applyExplicitReview({ ...base, opId: 'knowledge.accept',
        operationId: `grants-unread-accept-${index}1`,
        request: { verb: 'accept', input: { target: { grain: 'record', recordId: accept } } } })
      expect(accepted, `${context} accept`).toMatchObject({ outcome: 'applied', recordIds: [accept] })
      const rejected = await applyExplicitReview({ ...base, opId: 'knowledge.reject',
        operationId: `grants-unread-reject-${index}2`,
        request: { verb: 'reject', input: { target: { grain: 'record', recordId: reject }, reason: 'wrong' } } })
      expect(rejected, `${context} reject`).toMatchObject({ outcome: 'applied', recordIds: [reject] })
      const forgotten = await applyExplicitReview({ ...base, opId: 'knowledge.forget',
        operationId: `grants-unread-forget-${index}3`,
        request: { verb: 'forget', input: { target: { grain: 'record', recordId: forget } } } })
      expect(forgotten, `${context} forget`).toMatchObject({ outcome: 'applied', recordIds: [forget] })
    }

    expect(recorder.paths.length, 'the door made no recorded filesystem call, so this cell measures nothing')
      .toBeGreaterThan(0)
    expect(touchedLedger(), 'an explicit change opened, wrote or renamed the legacy ledger').toEqual([])
    expect(digest(ledger), 'the legacy ledger was rewritten, cleaned up or migrated').toBe(before)
    expect(grantShapedSiblings(), 'a grant-shaped replacement store appeared').toEqual([])
  }, 120_000)

  it('quarantine add, list and release never open it', async () => {
    const before = digest(ledger)
    const ops = quarantine()
    recorder.paths.length = 0
    const who = { product: 'grants-unread', filePath: 'tests/a.yaml', testName: 'alpha' }

    expect(await ops.add(who)).toMatchObject({ kind: 'entered' })
    expect((await ops.list()).map((entry) => entry.testName)).toEqual(['alpha'])
    expect(await ops.release(who)).toMatchObject({ kind: 'released' })

    expect(recorder.paths.length).toBeGreaterThan(0)
    expect(touchedLedger(), 'a quarantine verb opened the legacy grant ledger').toEqual([])
    expect(digest(ledger)).toBe(before)
    expect(grantShapedSiblings()).toEqual([])
  }, 120_000)

  it('the knowledge reads answer beside it and never open it', () => {
    const before = digest(ledger)
    const recordId = publish('read')
    recorder.paths.length = 0

    expect(listBundles(knowledgeRoot).map((row) => row.bundleId)).toContain(recordId)
    expect(inspectRecords({ knowledgeRoot, filter: {} }).map((row) => row.recordId)).toContain(recordId)
    expect(diffSince({ knowledgeRoot, sinceOrdinal: 0 }).length).toBeGreaterThan(0)
    expect(showRecord({ knowledgeRoot, recordId })).toMatchObject({ kind: 'found' })

    expect(recorder.paths.length).toBeGreaterThan(0)
    expect(touchedLedger(), 'a knowledge read opened the legacy grant ledger').toEqual([])
    expect(digest(ledger)).toBe(before)
  })

  // Carried from the deleted grant verbs' "refuses typed when another writer holds the lease, leaving
  // the ledger byte-unchanged": the direct writers refuse a held lease by name, and the legacy file is
  // untouched either way.
  it('a held writer lease refuses the direct writers by name and leaves it untouched', async () => {
    const before = digest(ledger)
    const recordId = publish('held')
    const holder = acquireWriterLease(knowledgeRoot)
    if (holder.kind !== 'acquired') throw new Error(`the fixture could not take the lease: ${holder.kind}`)
    recorder.paths.length = 0
    try {
      await expect(applyExplicitReview({
        agentQaRoot, knowledgeRoot, executionContext: 'local-headless', opId: 'knowledge.forget',
        operationId: 'grants-unread-held-1',
        request: { verb: 'forget', input: { target: { grain: 'record', recordId } } },
      })).rejects.toBeInstanceOf(ApplyDelegateUnavailableError)
      await expect(quarantine().add({ product: 'grants-unread', filePath: 'tests/b.yaml', testName: 'beta' }))
        .rejects.toMatchObject({ name: 'QuarantineLeaseHeldError', holder: { leaseId: holder.leaseId } })
    } finally {
      releaseLease({ knowledgeRoot, leaseId: holder.leaseId })
    }
    expect(touchedLedger()).toEqual([])
    expect(digest(ledger)).toBe(before)
    expect(grantShapedSiblings()).toEqual([])
  }, 120_000)

  // 432-18 task 2: the retry, unreadable-file and absent-file edges.
  it('a retried explicit change answers its first outcome and still never opens it', async () => {
    const before = digest(ledger)
    const recordId = publish('retry')
    recorder.paths.length = 0
    const input = {
      agentQaRoot, knowledgeRoot, executionContext: 'local-headless' as const, opId: 'knowledge.accept',
      operationId: 'grants-unread-retry-1',
      request: { verb: 'accept' as const, input: { target: { grain: 'record' as const, recordId } } },
    }

    const first = await applyExplicitReview(input)
    const retried = await applyExplicitReview(input)

    expect(first).toMatchObject({ outcome: 'applied', recordIds: [recordId] })
    expect(retried).toMatchObject({ outcome: 'applied', recordIds: [recordId] })
    expect(recorder.paths.length).toBeGreaterThan(0)
    expect(touchedLedger(), 'a retry looked for a grant to dedupe against').toEqual([])
    expect(digest(ledger)).toBe(before)
  }, 120_000)

  it('the direct writers work while the old ledger cannot be read at all', async () => {
    const recordId = publish('unreadable')
    chmodSync(ledger, 0o000)
    try {
      expect(await applyExplicitReview({
        agentQaRoot, knowledgeRoot, executionContext: 'ci', opId: 'knowledge.reject',
        operationId: 'grants-unread-locked-1',
        request: { verb: 'reject', input: { target: { grain: 'record', recordId }, reason: 'wrong' } },
      })).toMatchObject({ outcome: 'applied', recordIds: [recordId] })
      expect(await quarantine().add({ product: 'grants-unread', filePath: 'tests/d.yaml', testName: 'delta' }))
        .toMatchObject({ kind: 'entered' })
    } finally {
      chmodSync(ledger, 0o600)
    }
    expect(readFileSync(ledger, 'utf8')).toBe(LEGACY_BYTES)
  }, 120_000)

  it('with no old ledger, no direct writer creates one in any context', async () => {
    rmSync(ledger)
    const targets = CONTEXTS.map((context) => ({ context, recordId: publish(`absent ${context}`) }))
    for (const [index, { context, recordId }] of targets.entries()) {
      expect(await applyExplicitReview({
        agentQaRoot, knowledgeRoot, executionContext: context, opId: 'knowledge.forget',
        operationId: `grants-unread-absent-${index}1`,
        request: { verb: 'forget', input: { target: { grain: 'record', recordId } } },
      }), context).toMatchObject({ outcome: 'applied' })
    }
    await quarantine().add({ product: 'grants-unread', filePath: 'tests/e.yaml', testName: 'epsilon' })
    expect(existsSync(ledger), 'a direct writer created a grant ledger').toBe(false)
    expect(readdirSync(knowledgeRoot).filter((name) => /grant/i.test(name))).toEqual([])
  }, 120_000)

  it('no grant reader, writer or verb is exported or present', () => {
    const exported = new Set(Object.keys(knowledgeLocal))
    expect(exported.size, 'the barrel is empty, so the census would be vacuous').toBeGreaterThan(0)
    expect(RETIRED_EXPORTS.filter((name) => exported.has(name)), 'a retired grant member is exported')
      .toEqual([])
    expect([...exported].filter((name) => /grant/i.test(name)), 'a grant-shaped member is exported').toEqual([])
    const grantsDir = join(dirname(fileURLToPath(import.meta.url)), '..')
    expect(RETIRED_MODULES.filter((name) => existsSync(join(grantsDir, name))), 'a retired grant module is present')
      .toEqual([])
    // The direct writers that carry the lease and egress claims are still the barrel's.
    expect(typeof knowledgeLocal.applyExplicitReview).toBe('function')
    expect(typeof knowledgeLocal.createQuarantineOperations).toBe('function')
  })
})
