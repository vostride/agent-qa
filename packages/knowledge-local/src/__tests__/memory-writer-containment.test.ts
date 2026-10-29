// A tracked symlink can point `memory/` or `policies/` anywhere, so writers refuse escaping links.
import { randomUUID } from 'node:crypto'
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'

import {
  FORGET_RECEIPT_SCHEMA_VERSION,
  DISTILLED_OBSERVATION_SCHEMA_VERSION,
  asEvidenceToken,
  ForgetReceiptV1Schema,
  type Anchor,
  type ScopeKey,
} from '@vostride/agent-qa-schema'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { appendOutcomeEvent } from '../bundle-append.js'
import { publishBundle, type BundleStoreConfig } from '../bundle-publish.test-helper.js'
import { openIndexWriter } from '../index-open.js'
import { COMMIT_INTENT_SCHEMA_VERSION, writeCommitIntent, writeReconciledEpochWithinCurrentAuthority } from '../journal/intent-journal.js'
import { acquireWriterLease } from '../lease/writer-lease.js'
import { materializePolicy } from '../policy/materialize.js'
import { writeJobState } from '../queue/job-state.js'
import { requestRebuild } from '../rebuild-marker.js'
import { recordForgetReceipt } from '../review/forget-receipt-journal.js'
import { enqueueArtifactFreeCandidateProjection } from './fixtures/curation-candidate-fixture.js'
import {
  makeBundleDraftFixture,
  makeScreenStateFixture,
  scaffoldKnowledgeRoot,
} from './fixtures/bundle-fixture.js'

const ANCHOR: Anchor = { t: 'el', role: 'Button', name: 'Checkout' }
const SCOPE: ScopeKey = { tier: 'product', key: 'containment-storefront' }
const CANDIDATE = 'a'.repeat(64)

let root: string
let knowledgeRoot: string
let outside: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'knowledge-memory-containment-'))
  knowledgeRoot = join(root, 'agent-qa-knowledge')
  outside = join(root, 'outside')
  mkdirSync(outside)
  scaffoldKnowledgeRoot(knowledgeRoot)
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/** Every path under a directory with its bytes (or `dir`), so any change shows. */
function tree(dir: string): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name)
      const rel = relative(dir, path)
      if (entry.isDirectory()) {
        out[rel] = 'dir'
        walk(path)
      } else {
        out[rel] = `${statSync(path).mtimeMs}:${readFileSync(path, 'utf8')}`
      }
    }
  }
  walk(dir)
  return out
}

function plant(linkAt: string, target = outside): void {
  const link = join(knowledgeRoot, linkAt)
  mkdirSync(dirname(link), { recursive: true })
  symlinkSync(target, link, 'dir')
}

function attempt(run: () => unknown): { kind: string; name?: string; message?: string } {
  try {
    run()
    return { kind: 'wrote' }
  } catch (error) {
    return { kind: 'threw', name: (error as Error).name, message: (error as Error).message }
  }
}

function authority(): { leaseId: string; epoch: number } {
  const lease = acquireWriterLease(knowledgeRoot)
  if (lease.kind !== 'acquired') throw new Error('expected an acquired writer lease')
  return { leaseId: lease.leaseId, epoch: lease.epoch }
}

function storeConfig(): BundleStoreConfig {
  return { knowledgeRoot, productKey: 'Containment Product' }
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
    provenance: { mode: 'run-linked', runId: `containment-${summary}`, testId: 't', stepIndex: 0 },
    artifacts: [],
  })
  if (outcome.kind !== 'published') throw new Error(`fixture publish failed: ${outcome.kind}`)
  return outcome.id
}

/** Writers that need nothing to exist beforehand: the outside sentinel must stay empty. */
const freshWriters: ReadonlyArray<readonly [string, readonly string[], () => unknown]> = [
  ['queue: enqueue a curation candidate', ['memory', 'memory/queue'], () =>
    enqueueArtifactFreeCandidateProjection({ knowledgeRoot, projectionInput: {
      sourceRunId: 'run-containment', scope: { tier: 'product', key: 'storefront' }, buildOrdinal: 42,
      executionContext: 'local-interactive', kind: 'fact',
      subtype: 'selector', anchors: [{ t: 'el', role: 'button', name: 'containment' }],
      summarySeed: 'containment selector', bodySeed: 'containment was resolved and verified.',
      distilledObservations: [{ schemaVersion: DISTILLED_OBSERVATION_SCHEMA_VERSION, step: { naturalKey: 'containment-step', ordinal: 0 },
        platform: 'web', element: { naturalKey: 'button:containment' }, observedAtOrdinal: 42 }],
      evidenceToken: 'evidence-containment', attributingObservationId: 'observation-containment',
      emittedAt: '2026-07-15T10:00:00.000Z' } as never })],
  ['queue: write a job state', ['memory', 'memory/queue'], () =>
    writeJobState({ knowledgeRoot, candidateId: CANDIDATE, lifecycle: 'queued', authority: authority() })],
  ['journal: write a commit intent', ['memory', 'memory/queue'], () =>
    writeCommitIntent(knowledgeRoot, { schemaVersion: COMMIT_INTENT_SCHEMA_VERSION, candidateId: CANDIDATE, bundleId: 'bundle-x',
      deltaKind: 'Add', epoch: 1 })],
  ['journal: write the reconciled epoch', ['memory', 'memory/queue'], () =>
    writeReconciledEpochWithinCurrentAuthority(knowledgeRoot, 1)],
  ['journal: record a forget receipt', ['memory', 'memory/queue'], () =>
    recordForgetReceipt(knowledgeRoot, authority(), ForgetReceiptV1Schema.parse({ schemaVersion: FORGET_RECEIPT_SCHEMA_VERSION,
      proposalId: `prop_${randomUUID()}`, tombstonedRecords: [], projectionsScrubbed: [],
      resultingBundleStatus: 'forgotten', forgottenAt: 1 }))],
  ['index: request a rebuild', ['memory', 'memory/index'], () =>
    requestRebuild({ knowledgeRoot, reason: 'absent', detail: 'containment' })],
  ['index: open the index writer', ['memory', 'memory/index'], () => openIndexWriter(knowledgeRoot).close()],
  ['bundles: publish a bundle', ['memory'], () => publish('fresh')],
  ['policies: materialize a policy', ['policies'], () =>
    materializePolicy({ knowledgeRoot, recordId: 'policy-containment', scope: 'shop',
      ruleText: 'Dismiss the cookie banner first', writerAuthority: authority() })],
]

describe('every knowledge writer refuses a link out of the knowledge root', () => {
  for (const [writer, links, run] of freshWriters) {
    for (const linkAt of links) {
      it(`${writer}, through ${linkAt} linked outside`, () => {
        plant(linkAt)

        const outcome = attempt(run)

        expect(tree(outside), 'the outside sentinel stays empty').toEqual({})
        expect(outcome).toMatchObject({ kind: 'threw', name: 'KnowledgeRootContainmentError' })
        expect(outcome.message).toContain(join(knowledgeRoot, linkAt))
      })
    }
  }

  it('bundles: an append to an existing bundle through memory/ linked outside changes nothing there', () => {
    const recordId = publish('existing')
    // The whole memory tree now lives outside, reached through a link, as a planted link would.
    const moved = join(outside, 'memory')
    renameSync(join(knowledgeRoot, 'memory'), moved)
    plant('memory', moved)
    const before = tree(outside)

    const outcome = attempt(() => appendOutcomeEvent(storeConfig(), recordId as never, {
      type: 'confirmed', evidenceToken: asEvidenceToken('containment'), curationJobId: 'containment',
      buildOrdinal: 43 } as never))

    expect(tree(outside), 'nothing outside changed').toEqual(before)
    expect(outcome).toMatchObject({ kind: 'threw', name: 'KnowledgeRootContainmentError' })
  })

  it('a link that stays inside the knowledge root is still followed', () => {
    mkdirSync(join(knowledgeRoot, 'real-memory'))
    plant('memory', join(knowledgeRoot, 'real-memory'))
    writeCommitIntent(knowledgeRoot, { schemaVersion: COMMIT_INTENT_SCHEMA_VERSION, candidateId: CANDIDATE, bundleId: 'bundle-x',
      deltaKind: 'Add', epoch: 1 })
    requestRebuild({ knowledgeRoot, reason: 'absent', detail: 'inside' })
    expect(readdirSync(join(knowledgeRoot, 'real-memory')).sort()).toEqual(['index', 'queue'])
  })
})
