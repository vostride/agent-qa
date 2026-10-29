// The v47 persistence scaffold, carved up. 2026-07-29.
//
// What LEFT this port, and why each departure is a deletion rather than a move:
//
// The two conversation methods are gone outright. Chat's state of record is the session log,
// so they never had an implementation to lose — but an unimplemented method is not harmless.
// A port that can store a transcript beside a job is an open invitation to make chat a job
// with a transcript attached, which is precisely the unification JOBQ-04 forbids. The
// cheapest way to keep that refactor from looking reasonable is for there to be no surface it
// could be written against.
//
// The job and checkpoint CRUD methods are gone too, and this is the deletion D-05 is really
// about. Generic CRUD lets a caller express any interleaving it likes and leaves atomicity to
// review; the queue's own store port replaced them with compound transactional verbs, where a
// wrong interleaving is not a bug a reviewer has to catch but a sentence the type surface
// cannot form. Keeping both would leave the unsafe spelling available beside the safe one.
//
// The 385 note above left one pair standing as "a placeholder for the phase with a phase of
// its own to derive it". Phase 391 IS that phase, and the derivation went the other way:
// the write side it built is a proposal envelope enumerated out of a file store and a standing
// grant folded out of a committed event log, neither of which is a save/get over an id. So the
// pair is gone too — not because the surface it named turned out to be unreal, but because the
// phase that made it real declined this shape for it. A placeholder that outlives the phase it
// was held for stops being a promise and becomes a second, unimplemented way to spell a
// capability that already exists somewhere else.
//
// What STAYS is patches, on exactly the footing the departed pair had: a real surface, no
// implementation yet, a phase of its own still ahead of it, and nothing about its presence
// suggesting a design already ruled out.
//
// Every departure on this port is described by role rather than by name on purpose. A token
// scan is one of the ways these deletions get checked, and prose quoting the identifiers it
// removed is indistinguishable, to such a scan, from prose that brought them back. The
// assertion that actually holds the line is the exact `keyof PersistencePort` pin in the port
// type tests.

import type { Patch, PatchId } from '@vostride/agent-qa-schema'

export interface PersistencePort {
  savePatch(patch: Patch): Promise<void>
  getPatch(id: PatchId): Promise<Patch | undefined>
}
