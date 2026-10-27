// C432-PROPOSAL-FILES-UNREAD: old proposal files stay on disk and nothing opens them (432-17,
// D-02 / D-05 / D-22).
//
// RE-SPELLED 2026-10-01 (432-17). This file was the corpus for the Phase 391 proposals inbox over
// 387's store substrate: the `.rejected.json` sibling, enumeration over the five durable name shapes,
// expiry computed at read, the WR-03 orphaned-claim reap and the absorb-as-data reading of 387-era
// bare documents. 432 deletes that inbox with the store, the claim/rename machinery and the
// envelope, so every one of those claims lost its subject. What survives is the claim the inbox
// owed the files it leaves behind: a workspace that still holds them is a fresh workspace (D-02),
// they are never read, claimed, published, reaped or migrated (D-22), and a malformed one cannot
// break anything because nothing parses it.
//
// HOW "NEVER OPENED" IS MEASURED. `node:fs` and `node:fs/promises` are wrapped for this file's
// module graph, so every path-taking call made by the knowledge-local sources under test is
// recorded. The cells run the shipped explicit change door and the shipped reads with old and
// malformed proposal files planted beside the knowledge root, then assert that no recorded path
// lies under `<agentQaRoot>/proposals` and that the directory's bytes are unchanged. A recorder that
// could not see such a call would make that a vacuous pass, so a control cell drives one through
// the same wrapper and requires it to be recorded.
//
// AUTOMATIC CANDIDATE STATE IS NOT THE INBOX. Curation's `proposed-supersession-of` relation and
// the CI/cloud propose-only profile are a knowledge-candidate disposition and survive (D-08); the
// last cell keeps them measured beside the absence.

import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { BundleRelationsSchema } from '@vostride/agent-qa-schema'
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
import { resolveDispositionProfile } from '../../curator/author-contract.js'
import { diffSince } from '../../diff-since.js'
import { inspectRecords } from '../../inspect.js'
import { listBundles } from '../../list-bundles.js'
import { showRecord } from '../../show-record.js'
import {
  makeBundleDraftFixture,
  makeScreenStateFixture,
  scaffoldKnowledgeRoot,
} from '../../__tests__/fixtures/bundle-fixture.js'
import * as knowledgeLocal from '../../index.js'
import { applyExplicitReview } from '../apply-review.js'

const ANCHOR: Anchor = { t: 'el', role: 'Button', name: 'Checkout' }
const SCOPE: ScopeKey = { tier: 'product', key: 'unread-storefront' }
const CONTEXTS = ['local-interactive', 'local-headless', 'ci', 'cloud'] as const satisfies
  readonly ExecutionContext[]

/**
 * The exports the deleted store, inbox and proposal apply door published from this package. Each
 * is named so a returning member reds by name rather than by a count.
 */
const RETIRED_EXPORTS = [
  'PROPOSALS_DIR_NAME',
  'ProposalNotFoundError',
  'ProposalApplyInFlightError',
  'ProposalRejectedError',
  'ProposalTargetVanishedError',
  'APPLY_IN_FLIGHT_POLL_MS',
  'APPLY_IN_FLIGHT_WAIT_MS',
  'applyReview',
  'proposeReview',
  'createProposalsInbox',
  'decidePendingProposal',
  'extractStoredKnowledgeProposal',
  'extractStoredProposal',
  'isProcessAlive',
  'listProposalEnvelopes',
  'mintProposalId',
  'observeProposalEnvelope',
  'pendingProposalExists',
  'proposalsDir',
  'readAppliedProposal',
  'readPendingProposal',
  'readProposal',
  'readRejectedProposal',
  'rejectPendingProposal',
  'showProposalEnvelope',
  'writePendingProposalRecord',
] as const

/** The three store modules the inbox was built from. */
const RETIRED_MODULES = ['proposals-store.ts', 'proposals-inbox.ts', 'proposals-data.ts'] as const

/**
 * Old proposal files as earlier versions left them, written as bytes: one per durable name shape
 * the deleted store produced, plus files no version of it could parse. Nothing in this build can
 * produce them any more, which is why they are literals.
 */
const LEGACY_FILES: Readonly<Record<string, string>> = {
  // a 387-era bare knowledge proposal, pending
  'prop_0123456789ab.json': `${JSON.stringify({
    schemaVersion: 1, proposalId: 'prop_0123456789ab', verb: 'forget',
    targetRef: { grain: 'record', recordId: 'rec-legacy' }, deltas: [], proposedAt: 1, status: 'pending',
  }, undefined, 2)}\n`,
  // a 391-era wrapped record, pending
  'prop_abcdef012345.json': `${JSON.stringify({
    schemaVersion: 1, id: 'prop_abcdef012345', kind: 'config',
    origin: { emittedBy: 'agent', surface: 'mcp' }, payload: { schemaVersion: 1 },
  }, undefined, 2)}\n`,
  'prop_111111111111.applied.json': '{"proposal":{"proposalId":"prop_111111111111"},"decision":{"decision":"applied","at":2}}\n',
  'prop_222222222222.rejected.json': '{"proposal":{"proposalId":"prop_222222222222"},"decision":{"decision":"rejected","at":3}}\n',
  // an orphaned claim marker whose pid no process holds
  'prop_333333333333.json.claimed.4242': '{"schemaVersion":1,"proposalId":"prop_333333333333"}\n',
  // malformed: truncated JSON, a non-JSON body and an unknown kind
  'prop_444444444444.json': '{"schemaVersion": 1, "proposalId": "prop_4444',
  'prop_555555555555.json': 'not json at all\n',
  'prop_666666666666.json': '{"schemaVersion":1,"id":"prop_666666666666","kind":"unheard-of","payload":{}}\n',
  'notes.txt': 'left by a person\n',
}

function digestDirectory(dir: string): Readonly<Record<string, string>> {
  const out: Record<string, string> = {}
  for (const name of readdirSync(dir).sort()) {
    out[name] = createHash('sha256').update(readFileSync(join(dir, name))).digest('hex')
  }
  return out
}

describe('C432-PROPOSAL-FILES-UNREAD: old proposal files are never opened, claimed, published or migrated', () => {
  let root: string
  let knowledgeRoot: string
  let agentQaRoot: string
  let inbox: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'proposal-files-unread-'))
    knowledgeRoot = join(root, 'agent-qa-knowledge')
    agentQaRoot = join(root, '.agent-qa')
    inbox = join(agentQaRoot, 'proposals')
    scaffoldKnowledgeRoot(knowledgeRoot)
    mkdirSync(inbox, { recursive: true })
    for (const [name, body] of Object.entries(LEGACY_FILES)) writeFileSync(join(inbox, name), body, 'utf8')
    recorder.paths.length = 0
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  function storeConfig(): BundleStoreConfig {
    return { knowledgeRoot, productKey: 'Unread Product' }
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
      provenance: { mode: 'run-linked', runId: `unread-${summary}`, testId: 't', stepIndex: 0 },
      artifacts: [],
    })
    if (outcome.kind !== 'published') throw new Error(`fixture publish failed: ${outcome.kind}`)
    return outcome.id
  }

  function touchedInbox(): readonly string[] {
    const prefix = `${inbox}${sep}`
    return recorder.paths.filter((path) => path === inbox || path.startsWith(prefix))
  }

  it('C432-PROPOSAL-FILES-UNREAD: the recorder sees a call that does reach the proposals directory', () => {
    // The control. Without it, "no recorded path" could be a recorder that records nothing.
    expect(readdirSync(inbox).length).toBe(Object.keys(LEGACY_FILES).length)
    expect(touchedInbox()).toEqual([inbox])
  })

  // Twelve real fsync'd writes across four contexts: 2.1 s alone, past vitest's 15 s default in
  // 432-17 gate run 5 at load average 18. Same budget as C432-EXPLICIT-ALL-CONTEXTS (432-14).
  it('C432-PROPOSAL-FILES-UNREAD: explicit accept, reject and forget apply in every context and never open an old proposal file', async () => {
    const before = digestDirectory(inbox)
    // Fixture publication is not under measurement; only the door and the reads are.
    const targets = CONTEXTS.map((context) => ({
      context,
      accept: publish(`accept ${context}`),
      reject: publish(`reject ${context}`),
      forget: publish(`forget ${context}`),
    }))
    recorder.paths.length = 0

    for (const [index, { context, accept, reject, forget }] of targets.entries()) {
      const base = { agentQaRoot, knowledgeRoot, executionContext: context, opId: 'knowledge.accept' }
      const accepted = await applyExplicitReview({ ...base, operationId: `unread-accept-${index}1`,
        request: { verb: 'accept', input: { target: { grain: 'record', recordId: accept } } } })
      expect(accepted, `${context} accept`).toMatchObject({ outcome: 'applied', recordIds: [accept] })
      const rejected = await applyExplicitReview({ ...base, opId: 'knowledge.reject',
        operationId: `unread-reject-${index}2`,
        request: { verb: 'reject', input: { target: { grain: 'record', recordId: reject }, reason: 'wrong' } } })
      expect(rejected, `${context} reject`).toMatchObject({ outcome: 'applied', recordIds: [reject] })
      const forgotten = await applyExplicitReview({ ...base, opId: 'knowledge.forget',
        operationId: `unread-forget-${index}3`,
        request: { verb: 'forget', input: { target: { grain: 'record', recordId: forget } } } })
      expect(forgotten, `${context} forget`).toMatchObject({ outcome: 'applied', recordIds: [forget] })
    }

    expect(recorder.paths.length, 'the door made no recorded filesystem call, so this cell measures nothing')
      .toBeGreaterThan(0)
    expect(touchedInbox(), 'an explicit change opened, listed or renamed an old proposal file').toEqual([])
    expect(digestDirectory(inbox), 'an old proposal file was claimed, published, cleaned up or migrated')
      .toEqual(before)
  }, 120_000)

  it('C432-PROPOSAL-FILES-UNREAD: a retried explicit change answers its first outcome and still opens no old proposal file', async () => {
    const before = digestDirectory(inbox)
    const recordId = publish('retry')
    recorder.paths.length = 0
    const input = {
      agentQaRoot, knowledgeRoot, executionContext: 'local-headless' as const, opId: 'knowledge.accept',
      operationId: 'unread-retry-1',
      request: { verb: 'accept' as const, input: { target: { grain: 'record' as const, recordId } } },
    }

    const first = await applyExplicitReview(input)
    const retried = await applyExplicitReview(input)

    expect(first).toMatchObject({ outcome: 'applied', recordIds: [recordId] })
    expect(retried).toMatchObject({ outcome: 'applied', recordIds: [recordId] })
    expect(recorder.paths.length).toBeGreaterThan(0)
    expect(touchedInbox(), 'a retry looked for an old proposal file to dedupe against').toEqual([])
    expect(digestDirectory(inbox)).toEqual(before)
  }, 120_000)

  it('C432-PROPOSAL-FILES-UNREAD: an old proposal id is not a change target, and naming one opens nothing', async () => {
    const before = digestDirectory(inbox)
    recorder.paths.length = 0

    const outcome = await applyExplicitReview({
      agentQaRoot, knowledgeRoot, executionContext: 'local-headless', opId: 'knowledge.forget',
      operationId: 'unread-old-id-1',
      request: { verb: 'forget', input: { target: { grain: 'record', recordId: 'prop_0123456789ab' } } },
    })

    expect(outcome).toMatchObject({ outcome: 'target-not-found' })
    expect(touchedInbox(), 'naming an old proposal id reached its file').toEqual([])
    expect(digestDirectory(inbox)).toEqual(before)
  })

  it('C432-PROPOSAL-FILES-UNREAD: a change applies while the old proposals directory cannot be read at all', async () => {
    const recordId = publish('unreadable')
    chmodSync(inbox, 0o000)
    try {
      const outcome = await applyExplicitReview({
        agentQaRoot, knowledgeRoot, executionContext: 'local-headless', opId: 'knowledge.reject',
        operationId: 'unread-locked-1',
        request: { verb: 'reject', input: { target: { grain: 'record', recordId }, reason: 'wrong' } },
      })
      expect(outcome).toMatchObject({ outcome: 'applied', recordIds: [recordId] })
    } finally {
      chmodSync(inbox, 0o700)
    }
    expect(Object.keys(digestDirectory(inbox)).sort()).toEqual(Object.keys(LEGACY_FILES).sort())
  }, 120_000)

  it('C432-PROPOSAL-FILES-UNREAD: the knowledge reads answer with old and malformed proposal files present and never open one', () => {
    const before = digestDirectory(inbox)
    const recordId = publish('read')
    recorder.paths.length = 0

    expect(listBundles(knowledgeRoot).map((row) => row.bundleId)).toContain(recordId)
    expect(inspectRecords({ knowledgeRoot, filter: {} }).map((row) => row.recordId)).toContain(recordId)
    expect(diffSince({ knowledgeRoot, sinceOrdinal: 0 }).length).toBeGreaterThan(0)
    expect(showRecord({ knowledgeRoot, recordId })).toMatchObject({ kind: 'found' })
    expect(showRecord({ knowledgeRoot, recordId: 'prop_0123456789ab' }), 'an old proposal id names no record')
      .toMatchObject({ kind: 'not-found' })

    expect(recorder.paths.length).toBeGreaterThan(0)
    expect(touchedInbox(), 'a knowledge read opened or listed an old proposal file').toEqual([])
    expect(digestDirectory(inbox)).toEqual(before)
  })

  it('C432-PROPOSAL-FILES-UNREAD: no store, inbox or proposal apply door is exported or present to open them', () => {
    const exported = new Set(Object.keys(knowledgeLocal))
    expect(RETIRED_EXPORTS.filter((name) => exported.has(name)), 'a retired proposal member is exported')
      .toEqual([])
    const reviewDir = join(dirname(fileURLToPath(import.meta.url)), '..')
    expect(RETIRED_MODULES.filter((name) => existsSync(join(reviewDir, name))), 'a retired proposal module is present')
      .toEqual([])
    // The direct door that replaced them is still the barrel's.
    expect(typeof knowledgeLocal.applyExplicitReview).toBe('function')
  })

  it('C432-PROPOSAL-FILES-UNREAD: automatic candidate state remains — CI and cloud still propose, and the relation still parses', () => {
    expect(resolveDispositionProfile('ci')).toEqual({ mode: 'propose-only' })
    expect(resolveDispositionProfile('cloud')).toEqual({ mode: 'propose-only' })
    expect(resolveDispositionProfile('local-headless')).toEqual({ mode: 'drain-to-active' })
    const relations = BundleRelationsSchema.safeParse({
      schemaVersion: 1,
      relations: [{ type: 'proposed-supersession-of', targetId: 'rec-a', addedAtOrdinal: 1, curationJobId: 'job-1' }],
    })
    expect(relations.success, 'the automatic proposed-supersession relation stopped parsing').toBe(true)
  })
})
