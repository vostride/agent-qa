// The retrieval degradation rung, as a recorded fact about ONE run.
//
// WHY A VOCABULARY AND NOT A STRING. The rung is what a banner PRINTS and what `doctor` grades,
// and an open string would let a producer invent a fifth rung no reader has a rendering for —
// the same reason `RETRIEVAL_TRACE_LEGS` next door is closed. Four names, folded once from the
// two real axes the host exposes (the index face `'index' | 'scan'` and the embedder outcome
// `native | floor | deferred | lexical-only`); the fold itself lives in `knowledge-local`, which
// is the only package that can see either axis, and it hands the recorded value back as this
// schema type. One vocabulary, three callers: the runner's evidence recorder, the run header's
// banner, and `doctor`'s three rows.
//
// WHAT THE RUNG DESCRIBES, EXACTLY. It is the HOST's retrieval ladder at the moment this run was
// served — not a claim about how any individual brief line was ranked. The run-brief serve path
// reads index rows directly and attributes channels 1 and 3 to the `anchor` leg by construction;
// the dense leg and the bundle-scan fallback live in the general `retrieve()` path used by the
// curator, the entity resolver and the authoring reader. A surface must therefore never render
// this value as "this brief was dense-ranked" — it renders "retrieval was on rung X for this run".
//
// RECORDED, NOT RE-DERIVED. A run served on the static floor stays labelled that way forever,
// even after the host is fixed: the banner is about the run, not about the machine reading it
// today. That is the same 387 D-13 posture the serve-time retrieval trace carries, and it is why
// this value is persisted beside the evidence rather than recomputed at read time.

import { z } from 'zod'

/**
 * The four rungs of the v51 degradation ladder, best first.
 *
 * `memidex` — the index is openable AND a native embedder is live: dense, lexical and anchor
 * legs all participate. `bundle-scan` — the index face degraded to `scan`, so no dense leg runs
 * regardless of the embedder (which is why the index axis is folded FIRST). `static-floor` — the
 * index is live but the embedder fell back to the static floor profile. `lexical-only` — the
 * index is live and no embedder resolved at all, so nothing dense participates.
 */
export const RETRIEVAL_RUNGS = ['memidex', 'bundle-scan', 'static-floor', 'lexical-only'] as const

export type RetrievalRung = (typeof RETRIEVAL_RUNGS)[number]

/**
 * WHY the ladder degraded, as a closed enum recorded beside the rung (D-15, widened by 423 D-22).
 *
 * Closed rather than free prose lifted from an error, because this string is rendered to a
 * person in a one-line banner and graded by `doctor` — an error message would be neither
 * stable nor safe to print. `cold-artifact` and `load-failure` are real `DeferReason` arms in
 * `embedder-acquire.ts` and a `static` PREFERRED profile is a real configuration, so the enum
 * has a home for each rather than folding distinct operator situations into one wrong word.
 *
 * The mapping of record (fold owner: `knowledge-local/src/retrieval-rung.ts`):
 * `index-not-built` — the index file is absent (fresh store or clone); bundle scan is authoritative.
 * `index-locked` — another connection held the index; transient contention.
 * `index-corrupt` — the index would not open or carries the wrong schema version; rebuild requested.
 * `index-unavailable` — HISTORICAL ONLY: a pre-423 scan whose cause was not recorded. No current
 *   fold mints it, and no reader may reinterpret it as one of the three causes above.
 * `native-runtime-unavailable` — the native ONNX runtime could not load; the floor took over.
 * `profile-static-configured` — the floor is serving because the PREFERRED profile is static.
 * `model-not-downloaded` — `DeferReason: 'cold-artifact'`.
 * `embedder-load-failed` — `DeferReason: 'load-failure'`.
 * `profile-unresolved` — `DeferReason: 'worker-unavailable'` (the 399 daemon posture).
 * `floor-disabled` — the floor factory itself refused, so retrieval is lexical by choice.
 */
export const RETRIEVAL_RUNG_REASONS = [
  'native-runtime-unavailable',
  'profile-unresolved',
  'model-not-downloaded',
  'embedder-load-failed',
  'index-unavailable',
  'floor-disabled',
  'profile-static-configured',
  'index-not-built',
  'index-locked',
  'index-corrupt',
] as const

export type RetrievalRungReason = (typeof RETRIEVAL_RUNG_REASONS)[number]

/** A recorded rung carries the current reason vocabulary. */
export const RecordedRetrievalRungSchema = z.object({
  schemaVersion: z.literal(2),
  rung: z.enum(RETRIEVAL_RUNGS),
  reason: z.enum(RETRIEVAL_RUNG_REASONS).optional(),
}).strict()

export type RecordedRetrievalRung = z.infer<typeof RecordedRetrievalRungSchema>
