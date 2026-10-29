// The quarantine subsystem's identity LEAF.
//
// This module imports NOTHING — not the schema package, not the projection, not a sibling. That is
// its whole job. Every module that has to decide "are these two lines the same test?" needs the
// identity key: the detection ladder, `ledger.ts`'s `foldQuarantineLedgerState`, and
// `operations.ts`'s `triageOrder`/`entryFor`. While the key lived in `detection.ts`, reaching it
// meant acquiring an import edge INTO the detection ladder, and `detection.ts` re-exports §7.3's
// window from the projection — so `ledger.ts`'s keying import closed a four-edge VALUE cycle
// (`ledger.ts -> detection.ts -> fingerprint-window-read.ts -> run-outcomes.ts -> ledger.ts`),
// measured by grep at 390-31's HEAD. Nothing broke, because every binding on that chain is consumed
// inside a function body; but the comment justifying the import claimed an acyclicity check that
// had only been run one hop deep (round-5 gap 3a).
//
// A leaf has no outgoing edges, so an import OF it can sit on no cycle by construction. That is a
// property of this file's import list, checkable in one glance, and it is the reason the key lives
// here rather than being documented where it was.
//
// SCOPE. This module holds the key and its input type — nothing else. `compareQuarantineIdentity`
// and the module-private `compareBytes` stay in `detection.ts`, where their two real call sites
// are; widening the leaf to pull them in would re-open 390-28's IN-01 visibility closure.

/** The identity a quarantine record is keyed on: `(product, filePath, testName)`, never `testId`. */
export interface QuarantineIdentity {
  product: string
  filePath: string
  testName: string
}

/**
 * The identity key, spelled ONCE for the whole subsystem.
 *
 * `JSON.stringify` of the triple rather than a joined string: the parts are caller data and may
 * contain any character, and a separator that can appear inside a part is a collision waiting to
 * happen.
 *
 * ONCE IS TRUE OF THE CODE, NOT ONLY OF THE SENTENCE. Every keying site in the
 * subsystem IMPORTS this function rather than carrying a byte-identical copy: the detection ladder
 * in `detection.ts`, `ledger.ts`'s `foldQuarantineLedgerState`, which keys per-entry state on it,
 * and `operations.ts`'s `triageOrder`, which keys the triage queue on it. Until 390-28 only the
 * `operations.ts` half of that de-duplication had happened and the fold carried a private twin —
 * measured by mutating this function's bytes, under which `ledger.test.ts` stayed 57/57 green. It
 * reds now, and since 390-31 the fold reaches this definition without an edge into detection.
 *
 * The recipe is load-bearing history, not an implementation detail: it decides which committed
 * ledger lines merge onto one entry, so changing these bytes re-keys ledger history that is already
 * on disk (the 389 D-13 re-keying hazard, applied to entries).
 */
export function quarantineIdentityKey(identity: QuarantineIdentity): string {
  return JSON.stringify([identity.product, identity.filePath, identity.testName])
}
