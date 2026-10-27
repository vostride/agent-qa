import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  DISTILLED_OBSERVATION_SCHEMA_VERSION,
  BundleOutcomeEventSchema,
  asEvidenceToken,
  type Anchor,
  type Delta,
  type RecordId,
} from '@vostride/agent-qa-schema'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  AUTHORED_CHECKPOINT_SCHEMA_VERSION,
  CURATION_QUEUE_SCHEMA_VERSION,
  acquireWriterLease,
  candidateContentAddress,
  commitCurationDelta,
  deriveBundleTrust,
  loadBundle,
  openKnowledgeReader,
  rebuildIndex,
  retrieve,
  type AuthoredDeltaCheckpoint,
  type BuildCurationCandidateAddressFieldsInput,
  type CommitCurationDependencies,
  type CommitCurationJob,
  type PublishBundleOutcome,
} from '../index.js'
import { publishBundle } from '../bundle-publish.test-helper.js'
import {
  makeBundleDraftFixture,
  makeScreenStateFixture,
} from './fixtures/bundle-fixture.js'
import { candidateAddressFixture } from './fixtures/curation-candidate-fixture.js'

type PublishedBundle = Extract<PublishBundleOutcome, { kind: 'published' }>

const PRODUCT = 'rename-bridge-storefront'
const SCOPE = { tier: 'product', key: PRODUCT } as const
const PAGE: Anchor = { t: 'page', route: '/checkout' }
const SELECTOR = {
  t: 'selector',
  literal: '[data-testid="checkout-submit"]',
} as const satisfies Anchor
const OLD_ELEMENT: Anchor = {
  t: 'el',
  role: 'button',
  name: 'Place order',
  ordinal: 0,
}
const NEW_ELEMENT: Anchor = {
  t: 'el',
  role: 'button',
  name: 'Complete purchase',
  ordinal: 0,
}
const OLD_ANCHORS = [OLD_ELEMENT, PAGE, SELECTOR] as const
const NEW_ANCHORS = [NEW_ELEMENT, PAGE, SELECTOR] as const

let root: string
let knowledgeRoot: string
let epoch: number
let leaseId: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'knowledge-rename-bridge-'))
  knowledgeRoot = join(root, 'agent-qa-knowledge')
  mkdirSync(knowledgeRoot, { recursive: true })
  const lease = acquireWriterLease(knowledgeRoot)
  if (lease.kind !== 'acquired') throw new Error('expected a fresh writer lease')
  epoch = lease.epoch
  leaseId = lease.leaseId
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function publishVictim(): PublishedBundle {
  const outcome = publishBundle(
    {
      knowledgeRoot,
      productKey: PRODUCT,
    },
    {
      draft: makeBundleDraftFixture({
        anchors: [...OLD_ANCHORS],
        scope: SCOPE,
        summary: 'Place order is the legacy checkout control',
        body: 'The Place order button submits the legacy checkout form.',
      }),
      discriminant: {
        kind: 'fact',
        subtype: 'selector',
        elementRef: { role: 'button', name: 'Place order' },
      },
      originClass: 'agent-verified',
      createdAtOrdinal: 10,
      screenStates: [makeScreenStateFixture()],
      initialEvents: [
        BundleOutcomeEventSchema.parse({
          type: 'promoted',
          evidenceToken: 'rename-victim-promoted',
          curationJobId: 'rename-victim-publish',
          buildOrdinal: 10,
        }),
      ],
      relations: [],
      provenance: {
        mode: 'standalone',
        sourceDescription: 'rename bridge acceptance victim',
      },
      artifacts: [],
    },
  )
  if (outcome.kind !== 'published') {
    throw new Error(`expected victim publication, got ${outcome.kind}`)
  }
  return outcome
}

function publishLexicalDistractors(): void {
  const suffixes = ['amber', 'bronze', 'cobalt', 'denim', 'emerald', 'fuchsia', 'gold', 'hazel']
  for (const [index, suffix] of suffixes.entries()) {
    const name = `Unrelated ${suffix} shipping control`
    const outcome = publishBundle(
      {
        knowledgeRoot,
        productKey: PRODUCT,
      },
      {
        draft: makeBundleDraftFixture({
          anchors: [
            { t: 'el', role: 'link', name },
            { t: 'page', route: `/shipping-${suffix}` },
          ],
          scope: SCOPE,
          summary: `${name} opens an unrelated shipping workflow`,
          body: `Fixture ${index} records shipping-only behavior.`,
        }),
        discriminant: {
          kind: 'fact',
          subtype: 'selector',
          elementRef: { role: 'link', name },
        },
        originClass: 'agent-verified',
        createdAtOrdinal: index + 1,
        screenStates: [],
        initialEvents: [],
        relations: [],
        provenance: {
          mode: 'standalone',
          sourceDescription: `rename bridge lexical distractor ${index}`,
        },
        artifacts: [],
      },
    )
    if (outcome.kind !== 'published') {
      throw new Error(`expected distractor publication, got ${outcome.kind}`)
    }
  }
}

function replacementJob(): CommitCurationJob {
  const address: BuildCurationCandidateAddressFieldsInput = candidateAddressFixture({
    schemaVersion: CURATION_QUEUE_SCHEMA_VERSION,
    sourceRunId: 'rename-bridge-run',
    scope: SCOPE,
    buildOrdinal: 20,
    executionContext: 'local-interactive',    kind: 'fact',
    subtype: 'selector',
    anchors: [...NEW_ANCHORS],
    summarySeed: 'Complete purchase is the renamed checkout control',
    bodySeed: 'The Complete purchase button submits the current checkout form.',
    distilledObservations: [
      {
        schemaVersion: DISTILLED_OBSERVATION_SCHEMA_VERSION,
        step: { naturalKey: 'complete-purchase-click', ordinal: 0 },
        platform: 'web',
        element: { naturalKey: 'button:complete purchase:0' },
        locator: { selector: SELECTOR.literal },
        observedAtOrdinal: 20,
      },
    ],
    evidenceToken: 'rename-bridge-evidence',
    attributingObservationId: 'rename-bridge-run:test-0:step-0',
    artifactInventory: [],
    emittedAt: '2026-07-16T00:00:00.000Z',
  })
  const payload = {
    candidateId: candidateContentAddress(address),
    ...address,
  }
  const candidateDir = join(root, 'claimed', payload.candidateId)
  const artifactsDir = join(candidateDir, 'artifacts')
  mkdirSync(artifactsDir, { recursive: true })
  return {
    kind: 'claimed',
    candidateId: payload.candidateId,
    leaseId,
    payload,
    candidateDir,
    payloadPath: join(candidateDir, 'payload.json'),
    artifactsDir,
    screenStates: [makeScreenStateFixture(2)],
  }
}

function renameCheckpoint(
  victimId: RecordId,
  job: CommitCurationJob,
): AuthoredDeltaCheckpoint {
  const precondition = {
    recordId: victimId,
    observedStatus: 'active',
    observedOrdinal: 10,
  } as const
  const replacement = makeBundleDraftFixture({
    anchors: [...NEW_ANCHORS],
    scope: SCOPE,
    summary: job.payload.summarySeed,
    body: job.payload.bodySeed,
  })
  const delta: Extract<Delta, { kind: 'Supersede' }> = {
    kind: 'Supersede',
    origin: 'agent',
    scope: SCOPE,
    citedIds: [victimId],
    precondition: [precondition],
    authorship: {
      path: 'llm',
      model: { id: 'rename-bridge-curator' },
      executionContext: 'local-interactive',
    },
    victimId,
    newBundle: replacement,
    evidenceToken: asEvidenceToken(job.payload.evidenceToken),
  }
  return {
    schemaVersion: AUTHORED_CHECKPOINT_SCHEMA_VERSION,
    delta,
    neighborIds: [victimId],
    preconditions: [precondition],
    authorship: delta.authorship!,
  }
}

function dependencies(): CommitCurationDependencies {
  return {
    knowledgeRoot,
    epoch,
    profile: { mode: 'drain-to-active' },
    drainState: { supersedesSeenByAnchorKey: new Map() },
  }
}

describe('rename bridge fixture acceptance (DCAY-03/DCAY-04 D-22)', () => {
  it('closes old recall and preserves scrub-safe new-to-old audit traversal', async () => {
    const victim = publishVictim()
    publishLexicalDistractors()
    const job = replacementJob()
    const committed = commitCurationDelta(
      dependencies(),
      job,
      renameCheckpoint(victim.id, job),
    )
    expect(committed.kind).toBe('applied')
    if (committed.kind !== 'applied') throw new Error(`expected applied, got ${committed.kind}`)

    const oldBundle = loadBundle(victim.dir)
    expect(oldBundle.kind).toBe('loaded')
    if (oldBundle.kind !== 'loaded') throw new Error('expected loaded victim')
    expect(deriveBundleTrust(oldBundle.bundle)).toMatchObject({
      status: 'superseded',
      validity: { openedAtOrdinal: 10, closedAtOrdinal: 20 },
    })

    const newBundle = loadBundle(committed.bundleDir)
    expect(newBundle.kind).toBe('loaded')
    if (newBundle.kind !== 'loaded') throw new Error('expected loaded replacement')
    expect(newBundle.bundle.relations.relations).toContainEqual({
      type: 'renamed-from',
      targetId: victim.id,
      addedAtOrdinal: 20,
      curationJobId: job.candidateId,
    })

    const rebuilt = await rebuildIndex({ writerAuthority: { knowledgeRoot, leaseId, epoch }, knowledgeRoot })
    expect(rebuilt.scanIssues).toEqual([])

    const reader = openKnowledgeReader(knowledgeRoot)
    try {
      const options = { n: 8, product: PRODUCT, asOfBuild: 30 } as const
      const anchorServing = await retrieve(
        reader,
        { intent: '', anchors: [NEW_ELEMENT] },
        options,
      )
      const lexicalServing = await retrieve(
        reader,
        { intent: 'Complete purchase renamed current form', anchors: [] },
        options,
      )
      expect(anchorServing.map(({ id }) => id)).toContain(committed.bundleId)
      expect(anchorServing.map(({ id }) => id)).not.toContain(victim.id)
      expect(lexicalServing.map(({ id }) => id)).toContain(committed.bundleId)
      expect(lexicalServing.map(({ id }) => id)).not.toContain(victim.id)

      const audit = await retrieve(
        reader,
        { intent: '', anchors: [NEW_ELEMENT] },
        { ...options, includeSuperseded: true },
      )
      expect(audit.map(({ id }) => id)).toEqual(
        expect.arrayContaining([committed.bundleId, victim.id]),
      )
      expect(audit.find(({ id }) => id === victim.id)).toMatchObject({
        id: victim.id,
        status: 'superseded',
        audit: {
          status: 'superseded',
          openedAtOrdinal: 10,
          closedAtOrdinal: 20,
        },
      })
    } finally {
      reader.close()
    }
  })
})
