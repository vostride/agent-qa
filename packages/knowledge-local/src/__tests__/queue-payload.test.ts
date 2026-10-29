import { DISTILLED_OBSERVATION_SCHEMA_VERSION } from '@vostride/agent-qa-schema'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, expectTypeOf, it } from 'vitest'

import * as knowledgeLocal from '../index.js'
import {
  COMMIT_INTENT_SCHEMA_VERSION,
  commitIntentSchema,
  listCommitIntents,
  writeCommitIntent,
} from '../journal/intent-journal.js'
import {
  CURATION_JOB_STATE_SCHEMA_VERSION,
  curationJobStateSchema,
  readJobState,
  writeJobStateWithinCurrentAuthority,
} from '../queue/job-state.js'
import {
  CURATION_QUEUE_SCHEMA_VERSION,
  buildCurationCandidateAddressFields,
  candidateContentAddress,
  curationCandidatePayloadSchema,
  curationCandidateProjectionSchema,
  type BuildCurationCandidateAddressFieldsInput,
  type CurationCandidateAddressFields,
  type CurationCandidateProjection,
} from '../queue/queue-payload.js'
import type { CurationArtifactDescriptor, CurationArtifactRole } from '../index.js'
import { readCurationCandidatePayload } from '../queue/curation-queue.js'
import { queuedCandidateDir } from '../queue/queue-layout.js'
import { enqueueArtifactFreeCandidateProjection } from './fixtures/curation-candidate-fixture.js'

function candidateAddressInput(): BuildCurationCandidateAddressFieldsInput {
  return {
    schemaVersion: CURATION_QUEUE_SCHEMA_VERSION,
    sourceRunId: 'run-queue-contract',
    scope: { tier: 'product', key: 'storefront' },
    buildOrdinal: 42,
    executionContext: 'local-interactive',
    kind: 'fact',
    subtype: 'selector',
    anchors: [{ t: 'el', role: 'button', name: 'Checkout' }],
    summarySeed: 'Checkout button selector',
    bodySeed: 'The checkout button was resolved and verified.',
    distilledObservations: [
      {
        schemaVersion: DISTILLED_OBSERVATION_SCHEMA_VERSION,
        step: { naturalKey: 'checkout-click', ordinal: 0 },
        platform: 'web',
        element: { naturalKey: 'button:checkout' },
        observedAtOrdinal: 42,
      },
    ],
    evidenceToken: 'evidence-queue-contract',
    attributingObservationId: 'run-queue-contract:test-0:step-0',
    artifactInventory: [],
    emittedAt: '2026-07-15T10:00:00.000Z',
  }
}

function strictAddressInput(): Parameters<
  typeof buildCurationCandidateAddressFields
>[0] {
  return {
    ...candidateAddressInput(),
    artifactInventory: [
      {
        relativePath: `artifacts/${'b'.repeat(64)}`,
        sha256: 'b'.repeat(64),
        bytes: 128,
        stepIndex: 0,
        role: 'dom-snapshot',
        originalName: 'step-0.dom.json',
      },
    ],
  }
}

describe('curation candidate projection and payload contracts', () => {
  it('requires source descriptors before copy', () => {
    const {
      schemaVersion: _schemaVersion,
      artifactInventory: _artifactInventory,
      ...projectionFields
    } = candidateAddressInput()
    void _schemaVersion
    void _artifactInventory
    const projection = curationCandidateProjectionSchema.parse({
      ...projectionFields,
      artifactDescriptors: [
        {
          ref: { id: 'decision-screenshot', sha: 'a'.repeat(64) },
          stepIndex: 0,
          role: 'screenshot',
          originalName: 'step-0.png',
        },
      ],
    })

    expect(projection).not.toHaveProperty('candidateId')
    expect(projection.artifactDescriptors[0]).toMatchObject({
      role: 'screenshot',
      originalName: 'step-0.png',
    })
    expectTypeOf<CurationCandidateProjection>().not.toHaveProperty('candidateId')

    const required = {
      ...projection,
      artifactDescriptors: undefined,
    }
    expect(curationCandidateProjectionSchema.safeParse(required).success).toBe(false)
    expect(
      curationCandidateProjectionSchema.safeParse({
        ...projection,
        candidateId: 'c'.repeat(64),
      }).success,
    ).toBe(false)
  })

  it('requires queue version 2 and finalized artifact metadata', () => {
    const input = strictAddressInput()
    const fields: CurationCandidateAddressFields =
      buildCurationCandidateAddressFields(input)
    expect(CURATION_QUEUE_SCHEMA_VERSION).toBe(2)
    expect(fields).toEqual(input)
    expectTypeOf<CurationCandidateAddressFields['artifactInventory'][number]>()
      .toMatchTypeOf<{ role: CurationArtifactRole; originalName: string }>()

    const payload = {
      candidateId: candidateContentAddress(fields),
      ...fields,
    }
    expect(curationCandidatePayloadSchema.parse(payload)).toEqual(payload)

    const artifact = payload.artifactInventory[0]!
    const { role: _role, ...artifactWithoutRole } = artifact
    const { originalName: _originalName, ...artifactWithoutOriginalName } = artifact
    void _role
    void _originalName
    const invalidPayloads: unknown[] = [
      { ...payload, schemaVersion: 1 },
      { ...payload, artifactInventory: [artifactWithoutRole] },
      { ...payload, artifactInventory: [artifactWithoutOriginalName] },
    ]

    for (const invalidPayload of invalidPayloads) {
      expect(curationCandidatePayloadSchema.safeParse(invalidPayload).success).toBe(false)
    }
  })

  it('addresses every populated address fact while excluding only emittedAt', () => {
    const input = strictAddressInput()
    const baseline = buildCurationCandidateAddressFields(input)
    const baselineId = candidateContentAddress(baseline)
    const artifact = input.artifactInventory[0]!
    const changedDigest = 'c'.repeat(64)

    const variants = [
      buildCurationCandidateAddressFields({
        ...input,
        artifactInventory: [
          {
            ...artifact,
            relativePath: `artifacts/${changedDigest}`,
            sha256: changedDigest,
          },
        ],
      }),
      buildCurationCandidateAddressFields({
        ...input,
        artifactInventory: [{ ...artifact, role: 'ax-snapshot' }],
      }),
      buildCurationCandidateAddressFields({
        ...input,
        artifactInventory: [{ ...artifact, originalName: 'step-0.safe.dom.json' }],
      }),
      buildCurationCandidateAddressFields({ ...input, executionContext: 'ci' }),
    ]

    for (const variant of variants) {
      expect(candidateContentAddress(variant)).not.toBe(baselineId)
    }
    expect(
      candidateContentAddress(
        buildCurationCandidateAddressFields({
          ...input,
          emittedAt: '2099-01-01T00:00:00.000Z',
        }),
      ),
    ).toBe(baselineId)
  })

  it('rejects unknown and raw-value-shaped keys at every finalized boundary', () => {
    const input = strictAddressInput()
    const invalidInputs: unknown[] = [
      { ...input, rawValue: 'secret' },
      {
        ...input,
        artifactInventory: [{ ...input.artifactInventory[0]!, value: 'secret' }],
      },
    ]

    for (const invalid of invalidInputs) {
      expect(() => buildCurationCandidateAddressFields(invalid as never)).toThrow()
    }
  })
})

describe('format-local durability versions and strict public surface', () => {
  it('keeps job-state and commit-intent bytes on their own constants, independent of the queue', () => {
    expect(CURATION_QUEUE_SCHEMA_VERSION).toBe(2)
    expect(CURATION_JOB_STATE_SCHEMA_VERSION).toBe(2)
    expect(COMMIT_INTENT_SCHEMA_VERSION).toBe(2)
    expect(
      curationJobStateSchema.parse({
        schemaVersion: CURATION_JOB_STATE_SCHEMA_VERSION,
        candidateId: 'd'.repeat(64),
        lifecycle: 'queued',
        embedCrashCount: 0,
        updatedAt: '2026-07-15T10:00:00.000Z',
      }),
    ).toMatchObject({
      schemaVersion: 2,
      candidateId: 'd'.repeat(64),
      lifecycle: 'queued',
    })
    expect(
      commitIntentSchema.parse({
        schemaVersion: COMMIT_INTENT_SCHEMA_VERSION,
        candidateId: 'e'.repeat(64),
        bundleId: 'fact-checkout-button-0123456789abcdef',
        deltaKind: 'Add',
        epoch: 7,
      }),
    ).toEqual({
      schemaVersion: 2,
      candidateId: 'e'.repeat(64),
      bundleId: 'fact-checkout-button-0123456789abcdef',
      deltaKind: 'Add',
      epoch: 7,
    })

    const jobStateSource = readFileSync(
      new URL('../queue/job-state.ts', import.meta.url),
      'utf8',
    )
    const intentSource = readFileSync(
      new URL('../journal/intent-journal.ts', import.meta.url),
      'utf8',
    )
    const queueSource = readFileSync(
      new URL('../queue/queue-payload.ts', import.meta.url),
      'utf8',
    )
    expect(queueSource).toMatch(/export const CURATION_QUEUE_SCHEMA_VERSION = 2\b/u)
    expect(queueSource).not.toContain('Version-1 compatibility bridge')
    expect(jobStateSource).not.toContain('CURATION_QUEUE_SCHEMA_VERSION')
    expect(intentSource).not.toContain('CURATION_QUEUE_SCHEMA_VERSION')
    expect(jobStateSource).toContain('CURATION_JOB_STATE_SCHEMA_VERSION')
    expect(intentSource).toContain('COMMIT_INTENT_SCHEMA_VERSION')
  })

  it('round-trips queue, job-state and commit-intent bytes at their own constants', () => {
    const root = mkdtempSync(join(tmpdir(), 'curation-version-roundtrip-'))
    const candidateId = 'd'.repeat(64)
    try {
      const fields = buildCurationCandidateAddressFields(strictAddressInput())
      const payload = { candidateId: candidateContentAddress(fields), ...fields }
      expect(
        curationCandidatePayloadSchema.parse(JSON.parse(JSON.stringify(payload))),
      ).toEqual(payload)

      writeJobStateWithinCurrentAuthority({
        knowledgeRoot: root,
        candidateId,
        lifecycle: 'queued',
        authority: { leaseId: 'queue-payload-fixture', epoch: 0 },
      })
      expect(readJobState(root, candidateId)).toMatchObject({
        kind: 'parsed',
        state: { schemaVersion: 2, candidateId, lifecycle: 'queued' },
      })

      writeCommitIntent(root, {
        schemaVersion: COMMIT_INTENT_SCHEMA_VERSION,
        candidateId,
        bundleId: 'fact-checkout-button-0123456789abcdef',
        deltaKind: 'Add',
        epoch: 7,
      })
      expect(listCommitIntents(root)).toEqual([
        {
          parsed: {
            schemaVersion: 2,
            candidateId,
            bundleId: 'fact-checkout-button-0123456789abcdef',
            deltaKind: 'Add',
            epoch: 7,
          },
        },
      ])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('exports every queue migration contract and durability version from the barrel', () => {
    const surface = knowledgeLocal as unknown as Record<string, unknown>
    for (const symbol of ['buildCurationCandidateAddressFields']) {
      expect(surface[symbol], symbol).toBeTypeOf('function')
    }
    for (const symbol of [
      'curationArtifactDescriptorSchema',
      'curationCandidateProjectionSchema',
    ]) {
      expect(surface[symbol], symbol).toBeTypeOf('object')
    }
    expect(surface.CURATION_JOB_STATE_SCHEMA_VERSION).toBe(2)
    expect(surface.COMMIT_INTENT_SCHEMA_VERSION).toBe(2)

    expectTypeOf<CurationArtifactDescriptor>().toHaveProperty('originalName')
  })
})

describe('new queue payloads carry no retired fields', () => {
  const RETIRED_KEYS = [
    ['capture', 'Evidence'].join(''),
    ['step', 'Interactions'].join(''),
    ['capture', 'Receipt'].join(''),
  ]
  const RETIRED_FLAGS = [['secret', 'Flagged'].join(''), ['injection', 'Flagged'].join('')]

  it('a new payload carries neither flag', () => {
    const {
      schemaVersion: _schemaVersion,
      artifactInventory: _artifactInventory,
      ...projectionFields
    } = candidateAddressInput()
    void _schemaVersion
    void _artifactInventory
    for (const key of RETIRED_FLAGS) {
      expect(
        curationCandidateProjectionSchema.safeParse({
          ...projectionFields,
          artifactDescriptors: [],
          [key]: true,
        }).success,
        key,
      ).toBe(false)
      expect(
        () => buildCurationCandidateAddressFields({ ...candidateAddressInput(), [key]: true }),
        key,
      ).toThrow()
    }

    const root = mkdtempSync(join(tmpdir(), 'curation-payload-flags-'))
    const knowledgeRoot = join(root, 'agent-qa-knowledge')
    try {
      const outcome = enqueueArtifactFreeCandidateProjection({
        knowledgeRoot,
        projectionInput: { ...projectionFields, emittedAt: '2026-10-15T00:00:00.000Z' },
      })
      expect(outcome.kind).toBe('enqueued')
      if (outcome.kind !== 'enqueued') throw new Error('expected enqueued projection')
      const candidateDir = queuedCandidateDir(knowledgeRoot, outcome.candidateId)
      const parsed = readCurationCandidatePayload(candidateDir)
      if (parsed.kind !== 'parsed') throw new Error('expected parsed payload')
      const written = JSON.parse(readFileSync(join(candidateDir, 'payload.json'), 'utf8'))
      for (const key of RETIRED_FLAGS) {
        expect(parsed.payload).not.toHaveProperty(key)
        expect(written).not.toHaveProperty(key)
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('a new payload carries no capture fields', () => {
    const root = mkdtempSync(join(tmpdir(), 'curation-payload-capture-fields-'))
    const knowledgeRoot = join(root, 'agent-qa-knowledge')
    try {
      const outcome = enqueueArtifactFreeCandidateProjection({
        knowledgeRoot,
        projectionInput: {
          sourceRunId: 'run-441-25',
          scope: { tier: 'product', key: 'storefront' },
          buildOrdinal: 42,
          executionContext: 'local-interactive',
          kind: 'fact',
          subtype: 'selector',
          anchors: [{ t: 'el', role: 'button', name: 'Checkout' }],
          summarySeed: 'Checkout button selector',
          bodySeed: 'The checkout button was resolved and verified.',
          distilledObservations: [],
          evidenceToken: 'evidence-441-25',
          attributingObservationId: 'run-441-25:test-0:step-0',
          emittedAt: '2026-10-15T00:00:00.000Z',
        },
      })
      expect(outcome.kind).toBe('enqueued')
      if (outcome.kind !== 'enqueued') throw new Error('expected enqueued projection')
      const candidateDir = queuedCandidateDir(knowledgeRoot, outcome.candidateId)
      const parsed = readCurationCandidatePayload(candidateDir)
      expect(parsed.kind).toBe('parsed')
      if (parsed.kind !== 'parsed') throw new Error('expected parsed payload')

      const written = JSON.parse(readFileSync(join(candidateDir, 'payload.json'), 'utf8'))
      for (const key of RETIRED_KEYS) {
        expect(parsed.payload).not.toHaveProperty(key)
        expect(written).not.toHaveProperty(key)
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
