import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'

import {
  DISTILLED_OBSERVATION_SCHEMA_VERSION,
  asEvidenceToken,
  type Anchor,
  type BundleDraft,
  type Delta,
  type RecordId,
} from '@vostride/agent-qa-schema'
import { afterEach, describe, expect, it } from 'vitest'

import { deriveBundleTrust, loadBundle } from '../../bundle-read.js'
import { candidateAddressFixture } from '../../__tests__/fixtures/curation-candidate-fixture.js'
import { makeScreenStateFixture } from '../../__tests__/fixtures/bundle-fixture.js'
import { acquireWriterLease } from '../../lease/writer-lease.js'
import {
  CURATION_QUEUE_SCHEMA_VERSION,
  candidateContentAddress,
  type BuildCurationCandidateAddressFieldsInput,
} from '../../queue/queue-payload.js'
import {
  commitCurationDelta,
  type CommitCurationDependencies,
  type CommitCurationJob,
} from '../commit.js'
import type { AuthoredDeltaCheckpoint, DispositionProfile } from '../author-contract.js'
import { AUTHORED_CHECKPOINT_SCHEMA_VERSION } from '../author-contract.js'

// A correction keeps the victim's anchors, so the candidate keeps the Supersede's own identity.
const ANCHORS: Anchor[] = [
  { t: 'el', role: 'button', name: 'Acknowledge' },
  { t: 'page', route: '/notice' },
  { t: 'selector', literal: '[data-testid="acknowledge"]' },
]
const SCOPE = { tier: 'product', key: 'storefront' } as const

type Context = 'ci' | 'local-interactive'

interface Workspace {
  root: string
  knowledgeRoot: string
  epoch: number
  leaseId: string
}

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function workspace(): Workspace {
  const root = mkdtempSync(join(tmpdir(), 'knowledge-proposed-supersession-'))
  roots.push(root)
  const knowledgeRoot = join(root, 'agent-qa-knowledge')
  const lease = acquireWriterLease(knowledgeRoot)
  if (lease.kind !== 'acquired') throw new Error('expected a fresh writer lease')
  return { root, knowledgeRoot, epoch: lease.epoch, leaseId: lease.leaseId }
}

function draft(summary: string, body: string): BundleDraft {
  return {
    kind: 'fact',
    subtype: 'selector',
    anchors: ANCHORS,
    scope: SCOPE,
    summary,
    body,
    distilledEvidenceRef: { id: 'proposed-supersession-evidence', sha: 'c'.repeat(64) },
    originStage: 'run-curation',
  }
}

function job(
  ws: Workspace,
  overrides: Partial<BuildCurationCandidateAddressFieldsInput>,
): CommitCurationJob {
  const fields = candidateAddressFixture({
    schemaVersion: CURATION_QUEUE_SCHEMA_VERSION,
    sourceRunId: 'run-proposed-supersession',
    scope: SCOPE,
    buildOrdinal: 42,
    executionContext: 'ci',
    kind: 'fact',
    subtype: 'selector',
    anchors: ANCHORS,
    summarySeed: 'Acknowledge button selector',
    bodySeed: 'The acknowledge button was resolved.',
    distilledObservations: [
      {
        schemaVersion: DISTILLED_OBSERVATION_SCHEMA_VERSION,
        step: { naturalKey: 'acknowledge-click', ordinal: 0 },
        platform: 'web',
        element: { naturalKey: 'button:acknowledge' },
        locator: { selector: '[data-testid="acknowledge"]' },
        observedAtOrdinal: 42,
      },
    ],
    evidenceToken: 'evidence-victim',
    attributingObservationId: 'run-444:test-0:step-0',
    artifactInventory: [],
    emittedAt: '2026-10-18T10:00:00.000Z',
    ...overrides,
  })
  const payload = { candidateId: candidateContentAddress(fields), ...fields }
  const candidateDir = join(ws.root, 'claimed', payload.candidateId)
  const artifactsDir = join(candidateDir, 'artifacts')
  mkdirSync(artifactsDir, { recursive: true })
  writeFileSync(join(candidateDir, 'payload.json'), JSON.stringify(payload), 'utf8')
  return {
    kind: 'claimed',
    candidateId: payload.candidateId,
    leaseId: ws.leaseId,
    payload,
    candidateDir,
    payloadPath: join(candidateDir, 'payload.json'),
    artifactsDir,
    screenStates: [makeScreenStateFixture()],
  }
}

function checkpoint(delta: Delta, neighborIds: readonly RecordId[]): AuthoredDeltaCheckpoint {
  return {
    schemaVersion: AUTHORED_CHECKPOINT_SCHEMA_VERSION,
    delta,
    neighborIds: [...neighborIds],
    preconditions: [...(delta.precondition ?? [])],
    authorship: delta.authorship!,
  }
}

function deps(ws: Workspace, profile: DispositionProfile): CommitCurationDependencies {
  return {
    knowledgeRoot: ws.knowledgeRoot,
    epoch: ws.epoch,
    profile,
    drainState: { supersedesSeenByAnchorKey: new Map() },
  }
}

function seedVictim(ws: Workspace, context: Context) {
  const victim = draft('Acknowledge button selector', 'The acknowledge button was resolved.')
  const delta: Extract<Delta, { kind: 'Add' }> = {
    kind: 'Add',
    origin: 'agent',
    scope: SCOPE,
    citedIds: [],
    authorship: { path: 'deterministic-fallback', executionContext: context },
    bundle: victim,
  }
  const outcome = commitCurationDelta(
    deps(ws, context === 'ci' ? { mode: 'propose-only' } : { mode: 'drain-to-active' }),
    job(ws, { executionContext: context }),
    checkpoint(delta, []),
  )
  if (outcome.kind !== 'applied') throw new Error(`expected the victim Add to apply: ${outcome.kind}`)
  return outcome
}

function correction(ws: Workspace, victimId: RecordId, context: Context) {
  const replacement = draft(
    'Acknowledge button selector (corrected)',
    'The acknowledge button is the notice dismissal control.',
  )
  const supersede: Extract<Delta, { kind: 'Supersede' }> = {
    kind: 'Supersede',
    origin: 'agent',
    scope: SCOPE,
    citedIds: [victimId],
    precondition: [{ recordId: victimId, observedStatus: 'candidate', observedOrdinal: 42 }],
    authorship: { path: 'llm', model: { id: 'curator-fixture' }, executionContext: context },
    victimId,
    newBundle: replacement,
    evidenceToken: asEvidenceToken('evidence-correction'),
  }
  const claimed = job(ws, {
    buildOrdinal: 43,
    executionContext: context,
    summarySeed: replacement.summary,
    bodySeed: replacement.body,
    evidenceToken: 'evidence-correction',
    attributingObservationId: 'run-444:test-0:step-1',
  })
  return { supersede, claimed, authored: checkpoint(supersede, [victimId]) }
}

function fileHashes(dir: string): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (current: string) => {
    for (const name of readdirSync(current).sort()) {
      const path = join(current, name)
      if (statSync(path).isDirectory()) walk(path)
      else out[relative(dir, path)] = createHash('sha256').update(readFileSync(path)).digest('hex')
    }
  }
  walk(dir)
  return out
}

describe('proposed supersession in ci', () => {
  it('in ci a same-anchor correction is a separate candidate and the victim stays byte-unchanged', () => {
    const ws = workspace()
    const victim = seedVictim(ws, 'ci')
    const before = fileHashes(victim.bundleDir)
    expect(Object.keys(before)).toEqual(
      expect.arrayContaining(['record.md', 'provenance.json', 'relations.json', 'manifest.json']),
    )

    const { claimed, authored } = correction(ws, victim.bundleId, 'ci')
    const outcome = commitCurationDelta(deps(ws, { mode: 'propose-only' }), claimed, authored)

    expect(outcome).toMatchObject({ kind: 'downgraded', reason: 'propose-only' })
    if (outcome.kind !== 'downgraded') throw new Error('expected a propose-only downgrade')
    expect(outcome.bundleId).not.toBe(victim.bundleId)
    expect(fileHashes(victim.bundleDir)).toEqual(before)

    const loaded = loadBundle(outcome.bundleDir)
    if (loaded.kind !== 'loaded') throw new Error('expected the proposed candidate to load')
    expect(deriveBundleTrust(loaded.bundle).status).toBe('candidate')
    const proposed = loaded.bundle.relations.relations.filter(
      (relation) => relation.type === 'proposed-supersession-of',
    )
    expect(proposed.map((relation) => relation.targetId)).toEqual([victim.bundleId])
  })

  it('the proposed candidate has the id a local Supersede of the same delta mints', () => {
    const ci = workspace()
    const ciVictim = seedVictim(ci, 'ci')
    const ciCorrection = correction(ci, ciVictim.bundleId, 'ci')
    const proposed = commitCurationDelta(
      deps(ci, { mode: 'propose-only' }),
      ciCorrection.claimed,
      ciCorrection.authored,
    )
    if (proposed.kind !== 'downgraded') throw new Error(`expected a downgrade: ${proposed.kind}`)

    const local = workspace()
    const localVictim = seedVictim(local, 'local-interactive')
    expect(localVictim.bundleId).toBe(ciVictim.bundleId)
    const localCorrection = correction(local, localVictim.bundleId, 'local-interactive')
    const applied = commitCurationDelta(
      deps(local, { mode: 'drain-to-active' }),
      localCorrection.claimed,
      localCorrection.authored,
    )
    if (applied.kind !== 'applied') throw new Error(`expected the local Supersede to apply: ${applied.kind}`)

    expect(applied.bundleId).not.toBe(localVictim.bundleId)
    expect(proposed.bundleId).toBe(applied.bundleId)
  })
})
