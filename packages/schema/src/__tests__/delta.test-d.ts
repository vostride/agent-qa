import { expectTypeOf } from 'vitest'
import type { Delta } from '../delta/delta'
import type {
  BundleDraft,
  BundleKind,
  CompareAndSet,
  DeltaEnvelope,
  FactSubtype,
} from '../delta/envelope'
import type { ArtifactRef } from '../ids/artifact-ref'
import type { EvidenceToken, RecordId } from '../ids/record-id'
import type { Anchor } from '../identity/anchor'
import type { ScopeKey } from '../identity/scope-key'

const recordId = 'record-1' as RecordId
const victimRecordId = 'record-2' as RecordId
const evidenceToken = 'evidence-1' as EvidenceToken

const scope: ScopeKey = { tier: 'test', key: 'checkout' }
const anchor: Anchor = { t: 'el', role: 'button', name: 'Submit' }
const distilledEvidenceRef: ArtifactRef = { id: 'screen-summary', sha: 'a'.repeat(64) }

const precondition: CompareAndSet = {
  recordId,
  observedStatus: 'active',
  observedOrdinal: 3,
}

const envelope: DeltaEnvelope = {
  origin: 'agent',
  scope,
  citedIds: [recordId],
  precondition: [precondition],
}

const bundle: BundleDraft = {
  kind: 'fact',
  subtype: 'behavioral',
  anchors: [anchor],
  scope,
  summary: 'Checkout submit is disabled until the card form validates.',
  body: 'The submit button remains disabled while the card number is incomplete.',
  distilledEvidenceRef,
  originStage: 'run-curation',
}

// @ts-expect-error proposal bundles omit trust; deterministic code disposes trust later.
bundle.trust = 0.5

const addDelta: Delta = {
  ...envelope,
  kind: 'Add',
  bundle,
}

const confirmDelta: Delta = {
  ...envelope,
  kind: 'Confirm',
  targetId: recordId,
  evidenceToken,
}

const supersedeDelta: Delta = {
  ...envelope,
  kind: 'Supersede',
  victimId: victimRecordId,
  newBundle: bundle,
  evidenceToken,
}

const delta: Delta = confirmDelta

// @ts-expect-error proposal deltas omit status; deterministic code disposes status later.
delta.status = 'confirmed'

expectTypeOf<Extract<Delta, { kind: 'FileIssue' }>>().toEqualTypeOf<never>()

const acceptBundleKind = (_: BundleKind) => {}

acceptBundleKind('procedure')

// @ts-expect-error BundleKind is closed; arbitrary strings cannot enter bundle identity.
acceptBundleKind('observed-flow')

expectTypeOf<BundleDraft['subtype']>().toEqualTypeOf<FactSubtype | undefined>()

type ProposalKeys = keyof BundleDraft | keyof Delta
expectTypeOf<Extract<ProposalKeys, 'trust' | 'status'>>().toEqualTypeOf<never>()

void addDelta
void confirmDelta
void supersedeDelta
