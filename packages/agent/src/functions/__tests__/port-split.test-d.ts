// The read/write port split, pinned where it is decided (Phase 387 plan 06, KREV-01 / Pitfall 2).
//
// WHY A `.test-d.ts` AND NOT A `.test.ts`. Every claim in this file is a claim about an
// INTERFACE, and this package's `vitest.config.ts` sets `typecheck.include` to `*.test-d.ts`
// only — so a `.test.ts` is type-stripped by esbuild and never checked. 387-02 measured that
// blindness directly: deleting a field from `StepEvidence` outright left all 702 runtime cases
// green. A runtime assertion here would have been a control that cannot fail, and "the reader
// port has no write member" is exactly the sort of claim that reads like proof while pinning
// nothing.
//
// It lives under `__tests__/` rather than beside the module it pins. That is not taste: the
// arch dependency extractor treats any file OUTSIDE a `__tests__` directory as production
// source, so a `.test-d.ts` sibling of `spec.ts` typechecks fine and then fails `validate:arch`
// with `packages/agent external deps: unexpected vitest` (387-04 hit this exact trap). The
// vitest `typecheck.include` glob matches either location.

import type {
  BriefWhyInput, FeedbackPort, FeedbackReadsPort, QuarantineOperationsPort, RunsMarkInput,
} from '@vostride/agent-qa-schema'
import { describe, expectTypeOf, test } from 'vitest'

import type { mapStepEvidenceToWhy } from '../ops/knowledge-brief-why.js'
import type {
  FunctionDeps,
  KnowledgeChangeRequest,
  KnowledgeReaderPort,
  KnowledgeReviewPort,
  OptionalFunctionDepKey,
  RunsReaderPort,
  StepEvidenceLookup,
} from '../spec.js'
import type { OPTIONAL_FUNCTION_DEP_KEYS } from '../spec.js'

// ---- 1. The reader port carries NO write-shaped member ----------------------------------------
//
// Stated as an EXACT member set rather than as "does not have propose". A negative check per
// forbidden name is a list somebody has to remember to extend, and the write verb that arrives
// under a name nobody thought of is precisely the one it would miss. Exact equality fails on
// ANY arrival, which is the drift this pin exists to catch — including a `commit`, an `apply`,
// or a plausible-looking `promote`.
// 407 D-08 (2026-08-29) extends the set BY NAME rather than relaxing the equality, which is the
// whole mechanism working again: `canaryAttributions` is a fifth READ member — it answers what
// became of the canary lines a run served, out of the committed outcomes log — and `tsc` refused
// the port widening until this line acknowledged it. It is optional on the interface so every
// existing fake stays valid, and it is a read by construction: it takes tuples the caller already
// holds and returns observation ids and outcomes, with no verb through which anything can change.
expectTypeOf<keyof KnowledgeReaderPort>().toEqualTypeOf<
  // 2026-09-07, 417 D-01: extend the 407/416 read set BY NAME; never loosen equality.
  'listBundles' | 'inspectRecords' | 'diffSince' | 'showRecord' | 'showRecords' | 'canaryAttributions' | 'gateReceipts'
>()

// The same claim from the other side, and it is not redundant with the one above: it is what
// makes a WIDENING of the reader into the review port a compile error rather than something a
// reviewer has to notice. If someone folded the mutating verbs into the reader, this line would
// start passing — so it is asserted to be false.
expectTypeOf<KnowledgeReaderPort>().not.toMatchTypeOf<KnowledgeReviewPort>()

// ---- 2. The write port is OPTIONAL and joins the reporting vocabulary --------------------------
//
// `OptionalFunctionDepKey` is what makes an absent binding a VISIBLE `unbound` rather than a
// call that fails far away, and `spec.ts` requires every further optional member to join it.
// Pinned as an exact union so an optional dep can never arrive without that reporting: adding
// `knowledgeReview?` to `FunctionDeps` and forgetting this union would leave the mutating verbs
// unable to declare what they are bound through.
// 388 D-14 extends the union BY NAME rather than relaxing the equality: `postProcessing` is the
// third optional member, and the pin is what forced this line to be edited in the same change
// that added it — which is the whole mechanism.
// 389 D-10/D-08 extend it again, by name again: `analysis` (the artifact reader analysis.get
// binds through) and `recurrence` (the live-join seam the renderer consumes — optional because
// its absence is an honest no-history clause, never a refusal). The pin fired on both.
// 390 D-12/D-13 extends it a fourth time, by name again: `quarantine` — the committed ledger's
// three verbs. It fired on this one too, and that is the whole mechanism working: `tsc` refused
// the union edit until this line acknowledged it. (Note the dual-witness rule — vitest reported
// `Type Errors  no errors` for the same tree; only `tsc --noEmit` saw it.)
// 391 PROP-03 extends it a fifth time, by name again: `proposalsInbox` — the enumerable inbox's
// three verbs. It fired on this one too, and once more only under `tsc --noEmit`.
// 391 PROP-01 / D-03 extends it a sixth time, by name again: `standingGrants` — the committed
// grant ledger's list/record/revoke. It fired on this one too. Note that `record` is a member of
// the PORT and of no registered op, so this union is also the only place a reader can see that the
// mint capability exists at all: the accept escalation is its one caller.
// 392 D-24 extends it a seventh time, by name again: `chatTurn` — the assembled turn engine
// `agent.ask` runs behind. It fired on this one too, and once more only under `tsc --noEmit`.
// 393 D-01 extends it an eighth time, by name again: `draftEvaluation` — the two host halves one
// keep-gate evaluation needs. It fired on this one too, and once more only under `tsc --noEmit`
// (vitest printed `Type Errors  no errors` for the same tree; 393-05 measured the mechanical
// cause — `typecheck.include` never looks at a `.test.ts`, and this is a `.test-d.ts`, which is
// exactly why the dual-witness rule keeps `tsc` as the authority).
// 394 D-01 extends it a ninth and tenth time, by name again, and this pair is the first that has
// to be read as a pair: `authoringRead` (the brief + the suite text corpus, stages 1-2) and
// `draftShelf` (the model + the shelf + the verify dispatch, stages 3-4). `authoring.draft.write`
// names only `draftShelf` in `boundThrough` — a spec may name one key — and refuses on EITHER
// half at the invoke, because a host bound to compile but not to read would serve an empty brief
// rather than say so. The pin fired on both, and once more only under `tsc --noEmit`.
// 394-07 D-12/WTST-05 extends it an eleventh time, by name again: `authoringFunnel` — the honesty
// funnel's reads (the receipts store, the proposals inbox, and D-14's optional outcome/quarantine
// halves). It is a SEPARATE key from `draftShelf` rather than a member of it, and the reason is
// the direction of the capability: the shelf WRITES drafts and the funnel only READS what was
// written, so a host able to report on authoring history without being able to author is a real
// posture and one key for both would make it unsayable. It fired on this one too, and once more
// only under `tsc --noEmit` (vitest printed `Type Errors  no errors` for the same tree — the
// dual-witness rule, hit for the seventh consecutive plan).
// 394-10 D-06/WTST-01 extends it a twelfth time, by name again: `draftApply` — the one-commit
// apply an accepted `test-draft` reaches. It is NOT a member of `draftShelf`, and the split is the
// same one the funnel's is, taken on the other axis: every member of that bundle is a capability
// the authoring LOOP exercises, and this one is exercised by `proposals.accept` on a host that
// need not be able to author anything at all. It is also the first key in this union bound WITHOUT
// its neighbour's condition — the shelf requires a run executor, and committing an
// already-decided draft requires a checkout root and nothing else.
// 394-18 D-05/D-11/WTST-05 extends it a thirteenth time, by name again: `authoringProposals` —
// where a finished loop outcome becomes a proposal a person can find. It rides the SAME conditional
// spread as `authoringRead`/`draftShelf` rather than a condition of its own, and that is the
// opposite call from `draftApply` one paragraph up, taken on the evidence: filing is what the loop
// DOES with what it produced, and a host that could author a draft and not file it would spend up
// to nine child runs on an artifact nobody can ever decide on. It is a separate KEY from the shelf
// for the funnel's reason read the other way — the shelf's members are all capabilities that make a
// draft, and this one disposes of the result. The pin fired on this one too, and once more only
// under `tsc --noEmit` (vitest printed `Type Errors  no errors` for the same tree — the
// dual-witness rule, hit for the eleventh consecutive plan).
// 394-26 (WINDOWS 110) extends it a fourteenth time, by name again: `authoringScope` — which
// product this project authors for when the caller named none. It is a SEPARATE key from
// `authoringRead` rather than a third verb on it, and the split is the funnel's argument on a new
// axis: the brief needs a knowledge index, the derivation needs the resolved config and the
// workspace's committed tests, and a host can genuinely hold one without the other. Folding it in
// would make a composition that can derive a scope but serve no brief report the whole read half
// absent. The pin fired on this one too, and once more only under `tsc --noEmit` (vitest printed
// `Type Errors  no errors` for the same tree — the dual-witness rule, hit for the twelfth
// consecutive plan).
// 395-01 D-01/D-03/D-17 extends it FOUR MORE TIMES, by name each: `configFiles`, `configValidate`,
// `configApply` and `configProposals` — the config editor's host half. Four keys rather than one
// bundle, and the split is the funnel's argument on this phase's axis: reading committed config
// bytes, validating a whole candidate config against `core`'s schema, committing to a person's git
// history and writing a proposal record are four capabilities a host can genuinely hold
// independently, and three of the four are already held independently by hosts that hold their
// 394 analogues. Bundling them would make a composition that can read config but cannot commit
// report the whole config story absent — which is exactly the state `unbound` exists to
// distinguish from a capability that never existed.
// 395-04 extended it a NINETEENTH time with the construction-time secret scan's key, bound to the
// host's masking seed sources. 2026-10-14 (441-39, D-15): a config change is no longer scanned, and
// that key leaves the union with the scan.
// 395-06 D-07 extends it a TWENTIETH time, by name: `configUndoSource` — the repository's own
// account of the last agent configuration commit. It is a key of its own rather than a verb on
// `configApply`, and the split is the funnel's argument read on the read/write axis this phase is
// entirely about: that port WRITES a commit a person accepted, this one READS a commit somebody
// already made. Folding a read into the one port through which committed configuration changes
// would enlarge the write surface for no reason and make "this host can commit config" and "this
// host can see what it committed" one claim — and only the second is what `config.undo.propose`
// needs, which is why its absence makes exactly that op unavailable and nothing else.
// 395-08 D-04 extends it a TWENTY-FIRST time, by name: `scaffoldContent` — the shared scaffold
// substance, rendered by the host that owns it. It is a key of its own rather than a verb on
// `configFiles` because the two answer opposite questions about opposite files: that port reads
// bytes a project HAS, this one produces bytes a project does not have yet. It is a port at all
// only because the content lives in `packages/cli` beside `init`'s own write path, which is D-04's
// no-drift claim expressed as a module boundary — the alternative is a second copy of the scaffold
// in this package, failing silently the first time either one is edited.
// 398 D-09 extends it a TWENTY-SECOND time, by name: `capabilityCatalog` — the committed catalog as
// data, the model's citation over it, and the two coverage hooks, as ONE port. One and not four on
// the `draftEvaluation` bundle's reasoning: a host that could load the catalog but not cite over it
// would list `agent.explain` as `bound` and answer every question with a ghost citation, which
// abstains safely and uselessly and reports nothing. Its absence makes exactly one op unavailable,
// and the op says so BY NAME — which matters more here than anywhere else in this union, because a
// degraded explain is an explain answering from model memory, the one behaviour XPLN-02 forbids.
// 403-01 D-03 extends it a TWENTY-THIRD time, by name: `liveView` — the signer, the served origin
// and the live-run read, as ONE port. One and not three because a host that could sign but had no
// origin could mint a URL that resolves to nothing, which is a wrong answer wearing a correct one's
// clothes; its absence is the genuine host fact that a terminal serves no HTTP, and `runs.liveurl`
// says so BY NAME rather than inventing a link.
// 405-01 D-03 extends it a TWENTY-FOURTH time, by name: `runDetail` — ONE run's durable projection
// rows, read from the dashboard database the composing host owns. It is a key of its own rather
// than a verb on `runs` for the read/write-independent reason the union keeps splitting on: that
// port reads the RUNNER's handoff documents, this one reads the DASHBOARD's projection of the same
// run's bus, and the two exist in different hosts — a CLI holds handoffs and no dashboard
// database, a dashboard holds both. Folding them would make "this host can list runs" and "this
// host can render a run's step tree" one claim, and only the second is what `runs.detail` needs.
// 405-05 D-12/D-13 extends it a TWENTY-FIFTH time, by name: `evidenceBlobs` — one run's
// content-addressed evidence bytes, read through the same store the runner wrote them with. A key
// of its own rather than a verb on `runs` for the blast-radius reason: `RunsReaderPort` is
// REQUIRED, so a blob verb on it would make every daemon, MCP and test implementer satisfy a
// method most of them have no storage for — and a host that could list runs but hold no blobs
// would have to answer that verb with something. Optional, it is instead an honest `unbound`.
// 2026-09-08, 419 GATE3-01: feedback is the twenty-eighth member, pinned BY NAME.
// 2026-09-15, 423 D-19: feedbackReads is the twenty-ninth, a read-only port beside the writer.
// 2026-09-30, 432-07 D-05/D-07: configWrite is the thirtieth, the direct config writer.
// 2026-10-01, 432-17 D-05/D-07/D-09: proposalsInbox, draftApply, authoringProposals, configApply,
// configProposals and configUndoSource leave with the inbox, the apply ops and the undo (24 members).
// 2026-10-01, 432-18 D-03/D-15: standingGrants leaves with the grant ops and the ledger (23 members).
// 2026-10-14, 441-16 D-06: secretMask joins (24 members); 441-39 D-15: the scan key leaves (23).
expectTypeOf<OptionalFunctionDepKey>()
  .toEqualTypeOf<
    | 'liveView'
    | 'runInvocation'
    | 'knowledgeReview'
    | 'postProcessing'
    | 'runDetail'
    | 'evidenceBlobs'
    | 'analysis'
    | 'recurrence'
    | 'quarantine'
    | 'chatTurn'
    | 'draftEvaluation'
    | 'authoringRead'
    | 'authoringScope'
    | 'draftShelf'
    | 'authoringFunnel'
    | 'configFiles'
    | 'configValidate'
    | 'scaffoldContent'
    | 'capabilityCatalog'
    | 'feedback'
    | 'feedbackReads'
    | 'configWrite'
    | 'secretMask'
  >()

// Every member of that union must actually be an optional member of the deps record — the half
// that would otherwise let the union name a dep nobody supplies.
expectTypeOf<OptionalFunctionDepKey>().toMatchTypeOf<keyof FunctionDeps>()
expectTypeOf<FunctionDeps['knowledgeReview']>().toEqualTypeOf<KnowledgeReviewPort | undefined>()
expectTypeOf<FunctionDeps['knowledge']>().toEqualTypeOf<KnowledgeReaderPort>()
// 390: the same two-sided claim for the quarantine dep — named in the union AND optional on the
// record, so neither half can arrive alone. The port TYPE is minted in schema (both `agent` and
// knowledge-local consume it and neither may import the other), which is why this is the one
// member here whose type is not declared in `spec.ts`.
expectTypeOf<FunctionDeps['quarantine']>().toEqualTypeOf<QuarantineOperationsPort | undefined>()
// Exactly three verbs, pinned for the same exact-set reason the review port's surface is: a
// fourth power arriving quietly would be one no host ever declared it could supply.
expectTypeOf<keyof QuarantineOperationsPort>().toEqualTypeOf<'list' | 'release' | 'add'>()

// The review port's own surface, pinned for the same exact-set reason as the reader's: 387-08
// implements against this and a third member arriving quietly would be a third power no host
// declared.
// 2026-09-30, 432-12 (D-05): `change` arrives BY NAME — the direct change every change op reaches.
// 2026-10-01, 432-17 (D-05/D-22): `propose` and `apply` are deleted with the inbox; `change` is the
// port's only member.
expectTypeOf<keyof KnowledgeReviewPort>().toEqualTypeOf<'change'>()
expectTypeOf<KnowledgeChangeRequest['verb']>().toEqualTypeOf<'accept' | 'reject' | 'forget'>()
expectTypeOf<KnowledgeChangeRequest['operationId']>().toEqualTypeOf<string | undefined>()

// ---- 3. The step-evidence read distinguishes four situations, not two -------------------------
//
// The why-verb's honesty rests on telling "no such run" from "no such step" from "your address
// matches more than one step". A `StepEvidence | undefined` return would have collapsed all
// three into one silence, and the arm that matters most — ambiguity — would have been reported
// as an absence. Pinned as the exact discriminant set.
expectTypeOf<StepEvidenceLookup['kind']>().toEqualTypeOf<
  'found' | 'run-not-recorded' | 'step-not-found' | 'ambiguous-step-address'
>()

// The read is on the RUNS port, never the knowledge port. That placement is the whole reason
// re-running retrieval is not a temptation the why-verb has to resist: its substrate is a run's
// recorded evidence, and the op is handed no serving capability at all.
expectTypeOf<RunsReaderPort>().toHaveProperty('readStepEvidence')
expectTypeOf<KnowledgeReaderPort>().not.toHaveProperty('readStepEvidence')

// ---- 4. The why-verb's ANSWERING function is handed no deps ------------------------------
//
// This is the structural half of D-15's "never re-runs retrieval". `mapStepEvidenceToWhy`
// decides what the answer is, and its parameter list is exactly (lookup, input) — so there is
// no handle in its scope through which any index could be reached, and an edit that gave it
// one would have to change this signature. The op's `invoke` does receive the full deps record
// (every op does); that it touches only `deps.runs` is a SOURCE claim, scanned and probed in
// `brief-why-source.test.ts`. The two are different strengths of guarantee and are pinned
// separately on purpose.
expectTypeOf<Parameters<typeof mapStepEvidenceToWhy>>().toEqualTypeOf<
  [StepEvidenceLookup, BriefWhyInput]
>()

// ---- 5. C423-FEEDBACK-BINDINGS-EXACT: the feedback bindings, in counted blocks --------------
//
// 2026-09-15, 423-37: an independent oracle for plan 423-23's mutation. The union below is spelled
// by hand again rather than shared with section 2, and every assertion sits inside a `test` block
// so vitest counts it; the top-level pins above typecheck but report no tests.
// 2026-10-01 (432-17): the six proposal, apply and undo deps leave the hand-spelled union too.
// 2026-10-01 (432-18): standingGrants leaves it with the grant ops.
// 2026-10-14 (441-39, D-15): the construction scan's key leaves it with the scan.
type HandSpelledOptionalDepKey =
  | 'liveView' | 'runInvocation' | 'knowledgeReview' | 'postProcessing' | 'runDetail'
  | 'evidenceBlobs' | 'analysis' | 'recurrence' | 'quarantine'
  | 'chatTurn' | 'draftEvaluation' | 'authoringRead' | 'authoringScope'
  | 'draftShelf' | 'authoringFunnel' | 'configFiles'
  | 'configValidate'
  | 'scaffoldContent' | 'capabilityCatalog' | 'feedback' | 'feedbackReads' | 'configWrite'
  | 'secretMask'

describe('C423-FEEDBACK-BINDINGS-EXACT', () => {
  test('pins the optional dep key union and its runtime roster in both directions', () => {
    expectTypeOf<OptionalFunctionDepKey>().toEqualTypeOf<HandSpelledOptionalDepKey>()
    expectTypeOf<(typeof OPTIONAL_FUNCTION_DEP_KEYS)[number]>().toEqualTypeOf<HandSpelledOptionalDepKey>()
    expectTypeOf<Exclude<OptionalFunctionDepKey, (typeof OPTIONAL_FUNCTION_DEP_KEYS)[number]>>().toEqualTypeOf<never>()
    expectTypeOf<Exclude<(typeof OPTIONAL_FUNCTION_DEP_KEYS)[number], OptionalFunctionDepKey>>().toEqualTypeOf<never>()
  })

  test('binds the feedback writer and the read-only feedback observations as two optional deps', () => {
    expectTypeOf<Extract<OptionalFunctionDepKey, `feedback${string}`>>().toEqualTypeOf<'feedback' | 'feedbackReads'>()
    expectTypeOf<FunctionDeps['feedback']>().toEqualTypeOf<FeedbackPort | undefined>()
    expectTypeOf<FunctionDeps['feedbackReads']>().toEqualTypeOf<FeedbackReadsPort | undefined>()
  })

  test('pins the read binding to history and preview, with no writer verb', () => {
    expectTypeOf<keyof FeedbackReadsPort>().toEqualTypeOf<'history' | 'preview'>()
    expectTypeOf<keyof FeedbackPort>().toEqualTypeOf<'mark' | 'marksFor'>()
    expectTypeOf<Extract<keyof FeedbackReadsPort, keyof FeedbackPort>>().toEqualTypeOf<never>()
    expectTypeOf<Parameters<NonNullable<FeedbackReadsPort['preview']>>>().toEqualTypeOf<[RunsMarkInput]>()
  })
})

// ---- 6. C432-GRANT-DEPS-ABSENT: the standing-grant port leaves the deps record ------------------
//
// 2026-10-01, 432-18 (D-03/D-15). The type half of the claim whose runtime half is the same-named
// block in optional-dep-keys.test.ts. Each assertion sits in a `test` block so vitest counts it.
describe('C432-GRANT-DEPS-ABSENT', () => {
  test('C432-GRANT-DEPS-ABSENT: FunctionDeps declares no standingGrants member', () => {
    expectTypeOf<Extract<keyof FunctionDeps, 'standingGrants'>>().toEqualTypeOf<never>()
  })

  test('C432-GRANT-DEPS-ABSENT: OptionalFunctionDepKey has no standingGrants member', () => {
    expectTypeOf<Extract<OptionalFunctionDepKey, 'standingGrants'>>().toEqualTypeOf<never>()
    expectTypeOf<Extract<(typeof OPTIONAL_FUNCTION_DEP_KEYS)[number], 'standingGrants'>>().toEqualTypeOf<never>()
  })

  // RE-SPELLED 2026-10-14 (441-16, D-06) from '… still counts 23 members …': secretMask joins.
  // RE-SPELLED 2026-10-14 (441-39, D-15) from '… still counts 24 members …': the scan key leaves.
  test('C432-GRANT-DEPS-ABSENT: the roster still counts 23 members, so the absence is not vacuous', () => {
    expectTypeOf<(typeof OPTIONAL_FUNCTION_DEP_KEYS)['length']>().toEqualTypeOf<23>()
  })
})
