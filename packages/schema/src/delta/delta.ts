import type { EvidenceToken, RecordId } from '../ids/record-id'
import type { BundleDraft, DeltaEnvelope } from './envelope'

type Add = DeltaEnvelope & {
  kind: 'Add'
  bundle: BundleDraft
}

type Confirm = DeltaEnvelope & {
  kind: 'Confirm'
  targetId: RecordId
  evidenceToken: EvidenceToken
}

type Supersede = DeltaEnvelope & {
  kind: 'Supersede'
  victimId: RecordId
  newBundle: BundleDraft
  evidenceToken: EvidenceToken
}

type Deprecate = DeltaEnvelope & {
  kind: 'Deprecate'
  targetId: RecordId
  reason: string
}

type MintUnknown = DeltaEnvelope & {
  kind: 'MintUnknown'
  conflict: {
    recordIds: RecordId[]
    kind: 'contradiction' | 'drift' | 'clarification'
  }
}

type Noop = DeltaEnvelope & {
  kind: 'Noop'
}

export type Delta = Add | Confirm | Supersede | Deprecate | MintUnknown | Noop

// `satisfies` refuses an entry naming no arm; `review-dtos.test-d.ts` catches an arm with no entry.
export const DELTA_KINDS = [
  'Add',
  'Confirm',
  'Supersede',
  'Deprecate',
  'MintUnknown',
  'Noop',
] as const satisfies readonly Delta['kind'][]

export type DeltaKind = (typeof DELTA_KINDS)[number]
