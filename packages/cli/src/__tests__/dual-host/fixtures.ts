import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  CURATION_QUEUE_SCHEMA_VERSION,
  LEASE_HEARTBEAT_TTL_MS,
  buildCurationCandidateAddressFields,
  candidateContentAddress,
  curationCandidatePayloadSchema,
  queuedCandidateDir,
  type CurationCandidatePayload,
  type CurationJobView,
  type CuratorAuthor,
} from '@vostride/agent-qa-knowledge-local'
import { DISTILLED_OBSERVATION_SCHEMA_VERSION, canonicalJson, CurationSnapshotSchema } from '@vostride/agent-qa-schema'
import type { ExecutionContext } from '@vostride/agent-qa-schema'

export const FIXTURE_RUN_ID = 'run-dual-host-byte-proof'
export const FIXTURE_PRODUCT = 'dual-host-storefront'
export const OVER_TTL_SLACK_MS = 1_500
export const PERMITTED_RUN_RECEIPT_DIFF_FIELDS = [
  'drainKind',
  'handoffHolderPid',
] as const
// Written only beside a validated snapshot, so they share its asymmetry.
export const SNAPSHOT_BOUND_RUN_RECEIPT_FIELDS = ['curated', 'deprecated'] as const

export type FixtureVariant = 'mixed' | 'over-ttl' | 'empty'

export interface SerializedCandidate {
  readonly candidateId: string
  /** Exact payload.json text, including its terminal newline. */
  readonly payloadBytes: string
}

export interface DualHostFixture {
  readonly schemaVersion: 1
  readonly variant: FixtureVariant
  readonly candidates: readonly SerializedCandidate[]
  readonly delayedCandidateId: string | null
}

/** Only an inline drain against a hand-off to a live standing writer may omit completion fields. */
function completionOnlyAsymmetry(
  oneShot: Record<string, unknown>,
  daemon: Record<string, unknown>,
): boolean {
  return Object.hasOwn(oneShot, 'snapshot') && !Object.hasOwn(daemon, 'snapshot')
    && oneShot.drainKind === 'drained' && oneShot.handoffHolderPid === null
    && daemon.drainKind === 'handed-off' && typeof daemon.handoffHolderPid === 'number'
    && Number.isInteger(daemon.handoffHolderPid) && daemon.handoffHolderPid > 0
}

/**
 * Compare every receipt field, validating completion-only snapshot asymmetry separately.
 * New, missing, or mutated fields are named in the failure instead of being hidden by a projection.
 */
export function compareRunReceipts(
  oneShot: Record<string, unknown>,
  daemon: Record<string, unknown>,
): void {
  const permitted = new Set<string>(PERMITTED_RUN_RECEIPT_DIFF_FIELDS)
  const snapshotBound = new Set<string>(SNAPSHOT_BOUND_RUN_RECEIPT_FIELDS)
  const fields = [...new Set([...Object.keys(oneShot), ...Object.keys(daemon)])].sort()
  const unexpected = fields.filter((field) => {
    if (permitted.has(field)) return false
    const oneShotHasField = Object.hasOwn(oneShot, field)
    const daemonHasField = Object.hasOwn(daemon, field)
    if (field === 'snapshot') {
      if ((oneShotHasField && !CurationSnapshotSchema.safeParse(oneShot.snapshot).success)
        || (daemonHasField && !CurationSnapshotSchema.safeParse(daemon.snapshot).success)) return true
      if (oneShotHasField !== daemonHasField) return !completionOnlyAsymmetry(oneShot, daemon)
    }
    if (snapshotBound.has(field)) {
      const unbound = (receipt: Record<string, unknown>): boolean => Object.hasOwn(receipt, field)
        && (!Object.hasOwn(receipt, 'snapshot') || typeof receipt[field] !== 'number'
          || !Number.isInteger(receipt[field]) || receipt[field] < 0)
      if (unbound(oneShot) || unbound(daemon)) return true
      if (oneShotHasField !== daemonHasField) {
        return !(oneShotHasField && completionOnlyAsymmetry(oneShot, daemon))
      }
    }
    if (oneShotHasField !== daemonHasField) return true
    return canonicalJson(oneShot[field]) !== canonicalJson(daemon[field])
  })
  if (unexpected.length > 0) {
    throw new Error(`unexpected run receipt difference: ${unexpected.join(', ')}`)
  }
}

function candidate(
  executionContext: ExecutionContext,
  buildOrdinal: number,
  suffix: string,
  identitySalt = 0,
): SerializedCandidate {
  const fields = buildCurationCandidateAddressFields({
    schemaVersion: CURATION_QUEUE_SCHEMA_VERSION,
    sourceRunId: FIXTURE_RUN_ID,
    scope: { tier: 'product', key: FIXTURE_PRODUCT },
    buildOrdinal,
    executionContext,    kind: 'fact',
    subtype: 'selector',
    anchors: [
      {
        t: 'el',
        role: 'button',
        name: suffix === 'ci' ? 'Dual host replacement' : 'Dual host original',
        ordinal: 0,
      },
      { t: 'page', route: '/dual-host/shared' },
      { t: 'selector', literal: '[data-testid="dual-host-shared"]' },
    ],
    summarySeed: 'Use the deterministic dual-host shared control.',
    bodySeed: `The ${suffix} control was observed in the dual-host fixture.`,
    distilledObservations: [{
      schemaVersion: DISTILLED_OBSERVATION_SCHEMA_VERSION,
      step: { naturalKey: `dual-host-${suffix}`, ordinal: 0 },
      platform: 'web',
      element: {
        naturalKey: `button:${suffix === 'ci' ? 'dual host replacement' : 'dual host original'}:0`,
      },
      locator: { selector: '[data-testid="dual-host-shared"]' },
      observedAtOrdinal: buildOrdinal,
    }],
    evidenceToken: `dual-host-evidence-${suffix}-${identitySalt}`,
    attributingObservationId: `${FIXTURE_RUN_ID}:${suffix}:${identitySalt}`,
    artifactInventory: [],
    emittedAt: '2026-07-30T00:00:00.000Z',
  })
  const payload = curationCandidatePayloadSchema.parse({
    candidateId: candidateContentAddress(fields),
    ...fields,
  })
  return {
    candidateId: payload.candidateId,
    payloadBytes: `${canonicalJson(payload)}\n`,
  }
}

export function buildFixture(variant: FixtureVariant): DualHostFixture {
  if (variant === 'empty') {
    return { schemaVersion: 1, variant, candidates: [], delayedCandidateId: null }
  }
  const localInteractive = candidate('local-interactive', 101, 'local-interactive')
  let salt = 0
  let ci = candidate('ci', 102, 'ci', salt)
  while (ci.candidateId.localeCompare(localInteractive.candidateId) <= 0) {
    ci = candidate('ci', 102, 'ci', ++salt)
  }
  // Claim order is now deliberately local-interactive Add, then posture-sensitive CI Supersede.
  const candidates = [localInteractive, ci]
  return {
    schemaVersion: 1,
    variant,
    candidates,
    delayedCandidateId: variant === 'over-ttl' ? candidates[0]!.candidateId : null,
  }
}

export function writeFixture(file: string, fixture: DualHostFixture): void {
  writeFileSync(file, `${canonicalJson(fixture)}\n`, 'utf8')
}

export function readFixture(file: string): DualHostFixture {
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as DualHostFixture
  if (parsed.schemaVersion !== 1) throw new Error('unsupported dual-host fixture version')
  return parsed
}

/** Copy the parent-produced bytes verbatim into this leg's durable queue. */
export function enqueueFixtureBytes(
  knowledgeRoot: string,
  fixture: DualHostFixture,
): void {
  for (const item of fixture.candidates) {
    const dir = queuedCandidateDir(knowledgeRoot, item.candidateId)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'payload.json'), item.payloadBytes, 'utf8')
  }
}

export function payloadsForFixture(fixture: DualHostFixture): CurationCandidatePayload[] {
  return fixture.candidates.map(({ payloadBytes }) =>
    curationCandidatePayloadSchema.parse(JSON.parse(payloadBytes) as unknown))
}

function deterministicBundle(job: CurationJobView) {
  return {
    kind: job.kind,
    ...(job.subtype === undefined ? {} : { subtype: job.subtype }),
    anchors: job.anchors,
    scope: job.scope,
    summary: job.summarySeed,
    body: job.bodySeed,
    distilledEvidenceRef: {
      id: `dual-host-${job.candidateId}`,
      sha: job.candidateId,
    },
    originStage: 'run-curation' as const,
  }
}

function deterministicDelta(job: CurationJobView) {
  const authorship = {
    path: 'llm' as const,
    model: { id: 'dual-host:scripted-author' },
    executionContext: job.executionContext,
  }
  return {
    kind: 'authored' as const,
    authorship,
    deltas: [{
      kind: 'Add' as const,
      origin: 'agent' as const,
      scope: job.scope,
      citedIds: [],
      authorship,
      bundle: deterministicBundle(job),
    }],
  }
}

export function createScriptedAuthor(
  fixture: DualHostFixture,
  authorOrder: string[],
): CuratorAuthor {
  return async (job) => {
    authorOrder.push(job.candidateId)
    if (job.candidateId === fixture.delayedCandidateId) {
      await new Promise((resolve) =>
        setTimeout(resolve, LEASE_HEARTBEAT_TTL_MS + OVER_TTL_SLACK_MS))
    }
    return deterministicDelta(job)
  }
}

export function emitReportForFixture(fixture: DualHostFixture) {
  return {
    enqueued: fixture.candidates.length,
    coalesced: 0,
    capExceeded: 0,
    refused: 0,
    details: payloadsForFixture(fixture).map((payload) => ({
      candidateId: payload.candidateId,
      kind: payload.kind,
      outcome: { kind: 'enqueued' as const, candidateId: payload.candidateId },
    })),
  }
}
