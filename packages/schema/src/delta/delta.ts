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

/**
 * The §7.3 delta kinds as a RUNTIME value.
 *
 * `Delta` is a type-only union with no runtime declaration anywhere in the tree, because
 * until now nothing validated a delta at a boundary — deltas were constructed in-process and
 * handed straight to `commit()`. The 387 proposal DTO changes that: a proposal is a document
 * that crosses a process boundary between propose and apply, so its deltas arrive as
 * untrusted values and something has to be able to say which discriminants exist.
 *
 * This is a PROJECTION of the union above, not a second declaration of it: the `satisfies`
 * clause makes an entry that names no arm a compile error, and the reverse direction (an arm
 * that no entry names) is pinned in `__tests__/review-dtos.test-d.ts`. Adding a delta arm
 * without teaching this table about it therefore cannot be done silently.
 */
export const DELTA_KINDS = [
  'Add',
  'Confirm',
  'Supersede',
  'Deprecate',
  'MintUnknown',
  'Noop',
] as const satisfies readonly Delta['kind'][]

export type DeltaKind = (typeof DELTA_KINDS)[number]
