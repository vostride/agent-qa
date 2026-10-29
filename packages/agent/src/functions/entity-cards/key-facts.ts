// The per-kind `keyFacts[]` projections.
//
// a key fact is COMPUTED DETERMINISTICALLY FROM STORE DATA and is never LLM-authored.
// This module is where that promise is kept, and it is kept structurally rather than by
// discipline: every function here is a pure function of values it is handed, it imports
// nothing but the schema vocabulary, and it has no parameter through which a model, a clock,
// a filesystem or a network could be reached. A companion source scan asserts the absence of
// a model import with a planted-violation control, because "no LLM wrote this" is exactly the
// kind of claim that is easy to state and easy to stop being true.
//
// WHAT A KIND MAY SAY IS A TABLE, not a switch — `KEY_FACT_PROJECTIONS` is written
// `satisfies Record<EntityKind, …>`, so a sixth kind is a type error here rather than a
// card that silently renders the generic facts. That table is also the SEAM the phase's
// stubs land on: today an `EntityDescriptor` carries the identity a store reported, the title,
// the status and (for a renamed target) the successor, and nothing else, because only the
// `MEM` sighting source is registered in any composition (387-01, unchanged by 387-03). A run's
// verdict ordinal and a bundle's record count are facts the store does not yet HAND anybody,
// and inventing labels for values nothing produces would be exactly the LLM-authored-content
// failure this module exists to exclude, wearing a deterministic costume. Each kind's richer
// facts land in its row below on the day its sighting source reports them.
//
// The one place richer content exists TODAY is the forget receipt, which is designed
// to be both the apply verb's return value and the content a forgotten entity's permanent
// address resolves to afterwards. `forgetReceiptKeyFacts` is that second use.

import { ENTITY_IDENTITY_FACT_LABELS, formatEntityUri } from '@vostride/agent-qa-schema'
import type {
  EntityDescriptor,
  EntityKind,
  ForgetReceiptV1,
  KeyFact,
  QuarantineEntryState,
} from '@vostride/agent-qa-schema'

/**
 * What each kind CALLS the machine id its address maps FROM — RE-EXPORTED, declared in `schema`.
 *
 * The table moved to `schema/src/entity/entity-card.ts` in 400-08 and this line is the re-export
 * every existing importer keeps reading. It moved because it is the only thing that makes the
 * machine id readable OFF a card: the card shape carries no `machineId` field, so the dashboard's
 * entity-card renderer — which routes to pages keyed by machine id — has to be able to NAME the
 * fact that carries it. A second copy in the surface would be a label free to drift from the one
 * the producer writes with; fishing the id out of an `actions[]` seed would be the
 * addressing-by-coincidence `actions.ts` forbids. One declaration, beside the card contract, read
 * by the writer here and by every reader there.
 */
export { ENTITY_IDENTITY_FACT_LABELS }

/** The label the D-03 rename fact renders under, named once so a test can pin it. */
export const ENTITY_RENAMED_TO_FACT_LABEL = 'renamed to'

/**
 * The labels a quarantined `TST` card projects under, in the order they render.
 *
 * Three facts, and the third is the only interesting choice. D-17 puts the OCCURRENCE COUNT
 * ("3rd occurrence in 5 builds") in the rendered sentence, where a live provider join can compute
 * it; this producer is pure by construction and takes no ports, so it carries the occurrence
 * context the LEDGER ITSELF records — which class of failure recurred, and since when. Reaching
 * for the count here would mean giving the card producer a store handle, which is the one thing
 * ENTY-02's determinism claim rests on it not having.
 *
 * THAT RULE DOES NOT RANGE THE RE-ENTRY HISTORY. D-17's occurrence count is a count over
 * BUILDS — "3rd occurrence in 5 builds" is a join against a live provider, and it is still out of
 * reach here for exactly the reason above. `enteredCount` and `firstEnteredAt` are a different
 * number: the fold DERIVES them from `entered` events already committed to the ledger, and they
 * arrive ON THE ENTRY this module is handed, beside the `owner` and `expiresAt` it has always
 * rendered. Stating them costs this producer no handle, no port and no clock read — it stays a
 * pure function of its argument, which is the whole of what ENTY-02 pins. This distinction is
 * written down because the paragraph above, read alone, looks like it forbids that render, and a
 * reader who found no answer here would be RIGHT to delete a purity violation.
 */
export const QUARANTINE_FACT_LABELS = {
  owner: 'quarantine owner',
  expires: 'quarantine expires',
  occurrence: 'quarantine occurrence',
} as const

/** The labels a forget receipt projects under, in the order they render. */
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

/**
 * D-03's "with its rename visible", made literal.
 *
 * The old address keeps resolving to the old name — anything else would make an existing CI
 * log's reference quietly mean a different target — and the card is where a reader learns
 * what it became.
 *
 * It is reachable only from the `TGT` row of the table below, and the successor URI is built
 * for `TGT` unconditionally, which is why there is no `kind === 'TGT'` guard in here. There
 * WAS one, and a mutation probe measured it inert: with it removed every case still passed,
 * because the only thing that decides which kinds show a rename is the table. A second guard
 * that agrees with the table today is a second place the rule could stop being true with
 * nothing comparing them (387-01 D-1, same finding). The table is the one mechanism, and the
 * probe that pins it adds this projection to a kind that must not have it.
 */
function renameFact(descriptor: EntityDescriptor): KeyFact[] {
  if (descriptor.successorMachineId === undefined) return []
  return [{
    label: ENTITY_RENAMED_TO_FACT_LABEL,
    value: descriptor.successorMachineId,
    ref: formatEntityUri('TGT', `TGT-${descriptor.successorMachineId}`),
  }]
}

/**
 * An open quarantine window rendered as facts.
 *
 * Reached only from the `TST` row of the table below, and only for an entry the join already
 * decided is suppressing — an expired or released window contributes NOTHING here, because the
 * card's status says `active` for both and a fact announcing a quarantine beside it would be the
 * card contradicting itself.
 *
 * WHICH INSTANT THE OCCURRENCE FACT ANSWERS, and why it is not always the same one. An
 * entry on its FIRST window has one instant to state and states it exactly as it always has. An
 * entry on a LATER lap has two, and since 390-27 it states BOTH, in this order and for these
 * reasons: this test's quarantine history began at `firstEnteredAt`, which LEADS because it is the
 * key `triageOrder` (knowledge-local `quarantine/operations.ts`) sorts the triage queue on; the
 * CURRENT window opened at `enteredAt`, which follows because it is the premise the sibling
 * `expires` fact is DERIVED from. Each half answers a hazard the other cannot. Leading with the
 * current window's instant beside a clause promising RECURRENCE handed a human two different
 * answers to one question: the queue ordering a test by January while the card said April. Stating
 * the history's instant alone printed a computed deadline beside a premise the card had dropped,
 * so a reader could not check `expires` against anything the card showed. Stating both, in
 * that order, is what closes each without re-opening the other — see the `occurrenceValue`
 * docstring below, which renders exactly this. `quarantine-ledger.ts`'s own docstring calls these
 * two instants close enough to be exactly the first hazard; naming the sibling here is cheaper
 * than a test asserting the two agree, and it is what keeps the next edit from re-opening the
 * drift.
 */
function quarantineFacts(entry: QuarantineEntryState | undefined): KeyFact[] {
  if (entry === undefined) return []
  return [
    { label: QUARANTINE_FACT_LABELS.owner, value: entry.owner },
    { label: QUARANTINE_FACT_LABELS.expires, value: entry.expiresAt },
    { label: QUARANTINE_FACT_LABELS.occurrence, value: occurrenceValue(entry) },
  ]
}

/**
 * The occurrence sentence's two arms — ONE fact either way.
 *
 * The history rides in the sentence rather than in a second fact deliberately: the card's bound
 * is on fact COUNT, and a test being quarantined more often must not be able to move a number
 * {@link projectKeyFacts} reasons about below. Both arms are a fixed shape over the entry.
 *
 * The first-window arm is not an optimisation, it is the honest render. "1 quarantine window
 * since <the same instant the sentence would otherwise have named>" announces a lap count of one
 * and repeats itself, and every card rendered before the history existed was a first-window card
 * that must stay byte-identical.
 *
 * NO DURATION, NO HUMANISED INTERVAL. The instant is what the ledger holds and what every other
 * quarantine fact renders; "214 days ago" would make this fact a function of the wall clock in a
 * producer whose determinism is pinned and which holds no clock to read.
 *
 * THE LATER-LAP ARM CARRIES BOTH INSTANTS. The sibling `expires` fact is DERIVED
 * from `enteredAt`, and an arm stating only `firstEnteredAt` put a computed deadline on the card
 * beside a premise the card had dropped — a human reading "expires 2026-09-04" next to "4 windows
 * since 2026-06-01" cannot check the one against the other, because the instant the deadline was
 * measured from appears nowhere. The two instants answer DIFFERENT questions, in the fold's own
 * words (`quarantine/ledger.ts`): `firstEnteredAt` is when this test's quarantine history began —
 * what `triageOrder` sorts on, so the history clause still LEADS — and `enteredAt` is when the
 * CURRENT window opened, which is what `expiresAt` and the computed state are about. Stating both
 * is what makes the card self-checkable; dropping either re-opens one of the two defects.
 *
 * A first window has only one instant to state and states it exactly as it always has, so this
 * addition cannot reach the first-window arm: that arm is byte-identical to the render that
 * shipped before any history existed.
 */
function occurrenceValue(entry: QuarantineEntryState): string {
  const history = entry.enteredCount > 1
    ? `${entry.enteredCount} quarantine windows since ${entry.firstEnteredAt}` +
      `; current window since ${entry.enteredAt}`
    : `quarantined since ${entry.enteredAt}`
  return `${entry.verdictClass} failures recurring; ${history}`
}

/**
 * A forget receipt rendered as facts.
 *
 * The record ids are rendered as ONE fact carrying the whole list rather than as one fact per
 * record, and that is the reconciliation of two rules that would otherwise fight: D-19 says
 * forgetting a bundle lists every member record and nothing is silently partial, while the
 * card contract bounds the number of facts. A per-record fact would have had to be truncated,
 * which is precisely the silent partiality D-19 forbids; a single fact carrying the full list
 * keeps the enumeration complete and the card scannable.
 *
 * Ids are SORTED. A receipt's own array order is whatever the forget verb walked, and a card
 * whose facts reorder between two renders of unchanged state is not deterministic (ENTY-02's
 * ordering edge). Sorting is what makes the projection a function of the receipt's CONTENT
 * rather than of the order it happened to arrive in.
 */
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
  /** The forget receipt for a forgotten `MEM` bundle, when the caller holds one. */
  readonly forgetReceipt?: ForgetReceiptV1
  /**
   * The SUPPRESSING quarantine window for a `TST` entity (390), already joined by the producer.
   *
   * Handed in as a value for the same reason the receipt is: this module is pure over what it is
   * given, and a member through which a ledger could be read would be a port in disguise. The
   * join itself is spelled once, beside the status it also decides.
   */
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

/**
 * Project one entity's key facts.
 *
 * BOUNDED BY CONSTRUCTION, not by truncation, and the difference is the whole reason the
 * receipt renders as it does. Every row above emits a fixed, small number of facts whatever
 * its input contains — the receipt's record ids are ONE fact carrying the whole list rather
 * than one fact per record — so no store state can push a card past
 * `ENTITY_CARD_MAX_KEY_FACTS` and the schema's `.max()` can never fire.
 *
 * An earlier revision truncated here with a `.slice()`. A mutation probe measured it
 * unreachable: removing it left every case green, because the largest projection any input
 * can produce is five facts. It was a second bound that agreed with the first, and it would
 * have been the WRONG repair anyway — silently dropping the tail of a forget receipt is
 * exactly the silent partiality D-19 forbids. What replaced it is a test that exhausts the
 * projection table and a probe that makes the enumeration per-record, which is the mutation
 * the bound actually protects against.
 */
export function projectKeyFacts(input: KeyFactInput): KeyFact[] {
  return KEY_FACT_PROJECTIONS[input.descriptor.kind](input)
}
