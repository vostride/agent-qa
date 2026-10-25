import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { asRecordId, canonicalJson } from '@vostride/agent-qa-schema'
import { enqueueCanaryOutcome } from '../canary-queue.js'
import { queuedRoot } from '../queue-layout.js'

import {
  buildCurationCandidateAddressFields,
  candidateContentAddress,
  curationCandidatePayloadSchema,
} from '../queue-payload.js'
import {
  CANARY_QUEUE_SCHEMA_VERSION,
  canaryOutcomeContentAddress,
  canaryOutcomePayloadSchema,
  readQueuedCanaryPayload,
  PAYLOAD_BENEFITS,
  type CanaryOutcomeAddressFields,
  type CanaryOutcomePayload,
} from '../canary-payload.js'

function validPayload(): CanaryOutcomePayload {
  return {
    schemaVersion: CANARY_QUEUE_SCHEMA_VERSION,
    jobKind: 'canary-outcome',
    candidateId: 'fact-checkout-button-0123456789abcdef',
    runId: 'run-canary-transport',
    testId: 'checkout::happy-path',
    testIndex: 1,
    buildOrdinal: 42,
    stepIndex: 3,
    outcome: 'positive',
    benefit: 'rode-along',
    exercisedAnchor: { t: 'el', role: 'button', name: 'Checkout' },
    attribution: 'The served checkout hypothesis was exercised by the passing step.',
    briefDigest: 'brief-digest-42',
  }
}

function payloadWithoutBenefit(stamp: number): Record<string, unknown> {
  const { benefit: _benefit, ...rest } = validPayload()
  return { ...rest, schemaVersion: stamp }
}

describe('Pin 3 canary outcome payload', () => {
  it('enqueueCanaryOutcome writes the current payload.json with attribution authority', () => {
    const root = mkdtempSync(join(tmpdir(), 'canary-payload-'))
    try {
      const { schemaVersion: _version, jobKind: _kind, outcome, candidateId, ...fields } = validPayload()
      const result = enqueueCanaryOutcome(root, {
        ...fields, candidateId: asRecordId(candidateId), runOutcome: outcome,
      })
      const bytes = readFileSync(join(queuedRoot(root), result.entryId, 'payload.json'), 'utf8')
      expect(JSON.parse(bytes)).toEqual(validPayload())
      expect(bytes).toBe(`${canonicalJson(validPayload())}\n`)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('content-addresses the benefit', () => {
    const payload = validPayload()
    expect(canaryOutcomeContentAddress({ ...payload, benefit: 'exercised-benefited' }))
      .not.toBe(canaryOutcomeContentAddress(payload))
  })
  it('queued payload.json is governed by the closed benefit and outcome words, in declaration order', () => {
    expect([...PAYLOAD_BENEFITS]).toEqual(['exercised-benefited', 'rode-along', 'exercised-harmed'])
    expect(canaryOutcomePayloadSchema.shape.benefit.options).toEqual(PAYLOAD_BENEFITS)
    expect(canaryOutcomePayloadSchema.shape.outcome.options).toEqual(['positive', 'negative'])
  })

  it('reads a current payload as current', () => {
    expect(readQueuedCanaryPayload(validPayload())).toEqual({
      kind: 'current', payload: validPayload(),
    })
  })

  it.each([
    { title: 'refuses a payload stamped 3 with every current field', planted: () => ({ ...validPayload(), schemaVersion: 3 }) },
    { title: 'refuses a payload stamped 2 without a benefit', planted: () => payloadWithoutBenefit(2) },
    { title: 'refuses a payload stamped 1 with every current field', planted: () => ({ ...validPayload(), schemaVersion: 1 }) },
  ])('$title', ({ planted }) => {
    expect(readQueuedCanaryPayload(planted())).toEqual({
      kind: 'refused', issues: ['Invalid queued canary payload'],
    })
    expect(canaryOutcomePayloadSchema.safeParse(planted()).success).toBe(false)
  })

  it('refuses a current payload missing benefit or carrying an unknown key', () => {
    const { benefit: _benefit, ...missing } = validPayload()
    expect(readQueuedCanaryPayload(missing).kind).toBe('refused')
    expect(readQueuedCanaryPayload({ ...validPayload(), unknown: true }).kind).toBe('refused')
  })

  it('accepts only the current schema version and the canary-outcome job kind', () => {
    const payload = validPayload()

    expect(canaryOutcomePayloadSchema.parse(payload)).toEqual(payload)
    expect(
      canaryOutcomePayloadSchema.safeParse(payloadWithoutBenefit(2)).success,
    ).toBe(false)
    expect(
      canaryOutcomePayloadSchema.safeParse({ ...payload, schemaVersion: 1 }).success,
    ).toBe(false)
    expect(
      canaryOutcomePayloadSchema.safeParse({ ...payload, jobKind: 'curation' }).success,
    ).toBe(false)
  })

  it('rejects unknown keys and outcomes outside positive or negative', () => {
    const payload = validPayload()

    expect(
      canaryOutcomePayloadSchema.safeParse({ ...payload, unexpected: true }).success,
    ).toBe(false)
    expect(
      canaryOutcomePayloadSchema.safeParse({ ...payload, outcome: 'ambiguous' }).success,
    ).toBe(false)
  })

  it('content-addresses deterministic fields independent of key order and wall clock', () => {
    const payload = validPayload()
    const first: CanaryOutcomeAddressFields = {
      ...payload,
      emittedAt: '2026-07-17T10:00:00.000Z',
    }
    const reordered = {
      emittedAt: '2026-07-18T10:00:00.000Z',
      briefDigest: payload.briefDigest,
      attribution: payload.attribution,
      exercisedAnchor: payload.exercisedAnchor,
      outcome: payload.outcome,
      benefit: payload.benefit,
      stepIndex: payload.stepIndex,
      buildOrdinal: payload.buildOrdinal,
      testIndex: payload.testIndex,
      testId: payload.testId,
      runId: payload.runId,
      candidateId: payload.candidateId,
      jobKind: payload.jobKind,
      schemaVersion: payload.schemaVersion,
    } satisfies CanaryOutcomeAddressFields

    expect(canaryOutcomeContentAddress(first)).toBe(
      canaryOutcomeContentAddress(reordered),
    )
  })

  it('leaves existing curation payloads without a jobKind untouched', () => {
    const fields = buildCurationCandidateAddressFields({
      schemaVersion: 2,
      sourceRunId: 'run-existing-curation',
      scope: { tier: 'product', key: 'storefront' },
      buildOrdinal: 42,
      executionContext: 'local-interactive',      kind: 'fact',
      subtype: 'selector',
      anchors: [{ t: 'el', role: 'button', name: 'Checkout' }],
      summarySeed: 'Checkout selector',
      bodySeed: 'The checkout button was verified.',
      distilledObservations: [],
      evidenceToken: 'evidence-existing-curation',
      attributingObservationId: 'run-existing-curation:test-0:step-0',
      artifactInventory: [],
      emittedAt: '2026-07-17T10:00:00.000Z',
    })
    const payload = { candidateId: candidateContentAddress(fields), ...fields }

    expect(payload).not.toHaveProperty('jobKind')
    expect(curationCandidatePayloadSchema.parse(payload)).toEqual(payload)
  })
})
