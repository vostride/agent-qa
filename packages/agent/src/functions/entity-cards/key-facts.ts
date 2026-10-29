// Pure functions of handed values only, so no model, clock, filesystem or network is reachable.

import { ENTITY_IDENTITY_FACT_LABELS, formatEntityUri } from '@vostride/agent-qa-schema'
import type {
  EntityDescriptor,
  EntityKind,
  ForgetReceiptV1,
  KeyFact,
  QuarantineEntryState,
} from '@vostride/agent-qa-schema'

// Re-exported from schema, so the dashboard's renderer names the same machine-id fact.
export { ENTITY_IDENTITY_FACT_LABELS }

export const ENTITY_RENAMED_TO_FACT_LABEL = 'renamed to'

// Occurrence counts over builds need a live join; re-entry counts arrive on the entry itself.
export const QUARANTINE_FACT_LABELS = {
  owner: 'quarantine owner',
  expires: 'quarantine expires',
  occurrence: 'quarantine occurrence',
} as const

export const FORGET_RECEIPT_FACT_LABELS = {
  records: 'records forgotten',
  recordIds: 'record ids',
  projections: 'projections scrubbed',
  forgottenAt: 'forgotten at',
} as const

function identityFact(descriptor: EntityDescriptor): KeyFact {
  return {
    label: ENTITY_IDENTITY_FACT_LABELS[descriptor.kind],
    value: descriptor.machineId,
  }
}

// Only the table decides which kinds show a rename, so this function has no kind guard.
function renameFact(descriptor: EntityDescriptor): KeyFact[] {
  if (descriptor.successorMachineId === undefined) return []
  return [{
    label: ENTITY_RENAMED_TO_FACT_LABEL,
    value: descriptor.successorMachineId,
    ref: formatEntityUri('TGT', `TGT-${descriptor.successorMachineId}`),
  }]
}

// History start leads because the triage queue sorts on it; `expires` derives from `enteredAt`.
function quarantineFacts(entry: QuarantineEntryState | undefined): KeyFact[] {
  if (entry === undefined) return []
  return [
    { label: QUARANTINE_FACT_LABELS.owner, value: entry.owner },
    { label: QUARANTINE_FACT_LABELS.expires, value: entry.expiresAt },
    { label: QUARANTINE_FACT_LABELS.occurrence, value: occurrenceValue(entry) },
  ]
}

// No humanised duration, because the producer holds no clock; a later lap states both instants.
function occurrenceValue(entry: QuarantineEntryState): string {
  const history = entry.enteredCount > 1
    ? `${entry.enteredCount} quarantine windows since ${entry.firstEnteredAt}` +
      `; current window since ${entry.enteredAt}`
    : `quarantined since ${entry.enteredAt}`
  return `${entry.verdictClass} failures recurring; ${history}`
}

// Ids are one sorted fact, so the list stays complete and the card stays deterministic.
export function forgetReceiptKeyFacts(receipt: ForgetReceiptV1): KeyFact[] {
  const recordIds = [...receipt.tombstonedRecords]
    .map((record) => record.recordId)
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
  const projections = [...receipt.projectionsScrubbed].sort(
    (left, right) => (left < right ? -1 : left > right ? 1 : 0),
  )

  return [
    {
      label: FORGET_RECEIPT_FACT_LABELS.records,
      value: String(recordIds.length),
    },
    ...(recordIds.length === 0 ? [] : [{
      label: FORGET_RECEIPT_FACT_LABELS.recordIds,
      value: recordIds.join(', '),
    }]),
    ...(projections.length === 0 ? [] : [{
      label: FORGET_RECEIPT_FACT_LABELS.projections,
      value: projections.join(', '),
    }]),
    {
      label: FORGET_RECEIPT_FACT_LABELS.forgottenAt,
      value: new Date(receipt.forgottenAt).toISOString(),
    },
  ]
}

/** What a projection is handed: the store's descriptor, plus the receipt when one survives. */
export interface KeyFactInput {
  readonly descriptor: EntityDescriptor
  readonly forgetReceipt?: ForgetReceiptV1
  // The suppressing window, joined by the producer and handed in so this module stays pure.
  readonly quarantineEntry?: QuarantineEntryState
}

type KeyFactProjection = (input: KeyFactInput) => KeyFact[]

/**
 * THE per-kind projection table.
 *
 * `satisfies Record<EntityKind, …>` is the completeness guarantee: adding a sixth kind and
 * forgetting to say what its card shows is a type error, not a card that renders whatever the
 * fallback happened to be. There is deliberately no fallback.
 */
export const KEY_FACT_PROJECTIONS = {
  TST: ({ descriptor, quarantineEntry }) => [
    identityFact(descriptor),
    ...quarantineFacts(quarantineEntry),
  ],
  RUN: ({ descriptor }) => [identityFact(descriptor)],
  MEM: ({ descriptor, forgetReceipt }) => [
    identityFact(descriptor),
    ...(forgetReceipt === undefined ? [] : forgetReceiptKeyFacts(forgetReceipt)),
  ],
  POL: ({ descriptor }) => [identityFact(descriptor)],
  TGT: ({ descriptor }) => [identityFact(descriptor), ...renameFact(descriptor)],
} as const satisfies Record<EntityKind, KeyFactProjection>

// Bounded by construction: every row emits a fixed number of facts, so `.max()` never fires.
export function projectKeyFacts(input: KeyFactInput): KeyFact[] {
  return KEY_FACT_PROJECTIONS[input.descriptor.kind](input)
}
