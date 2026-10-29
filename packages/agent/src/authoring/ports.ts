// Capabilities from `core` and `knowledge-local` arrive as structural mirrors the host binds.

import type {
  AuthoringBrief,
  AuthoringVerifyDraftInput,
  CompletedRunHandoff,
  DraftReceipt,
  RunStartAcknowledgement,
  RunsStartInput,
  ScopeKey,
  TestEditPatchSet,
  TestFileWrite,
} from '@vostride/agent-qa-schema'

import type { JobModelCapability } from '../jobs/record-llm-authorship.js'

/**
 * A parsed draft, reduced to what the four gates and the receipt read.
 *
 * The HOST parses: `parseTestFile` lives in `core` and yields steps as `string | { step: string }`,
 * so the caller narrows to text before handing them down (the parse-at-host precedent in
 * `cli/src/curation/authoring-test-discovery.ts`). This is the same posture
 * `ParsedDraftStepsLike` takes in `assertion-strength.ts`, widened with the identity fields the
 * receipt and the member-outcome join need.
 *
 * `testName` is spelled `testName`, not `name`, on purpose. The stable identity is
 * (`filePath`, `testName`) — the project-wide rule, never `testId` — and gate 1 finds the draft's
 * own member inside a run document by comparing against `PerTestOutcome.testName`. A mirror that
 * spelled it `name` would put a rename at exactly the join where using the wrong field is the
 * mistake the rule exists to prevent.
 */
export interface ParsedDraftLike {
  /** The parser's canonical `t_` id. Provenance on the receipt; never the join key. */
  readonly testId: string
  /** Identity half one, as the runner records it on `PerTestOutcome.filePath`. */
  readonly filePath: string
  /** Identity half two: the parsed test's display name, as `PerTestOutcome.testName`. */
  readonly testName: string
  // Checked at compile because it is not editable, and a child run throws on an undeclared name.
  readonly target: string
  /** Pre-interpolation NL step text. Post-interpolation text can carry resolved secrets. */
  readonly steps: readonly string[]
  // Pre-interpolation, because resolved text can carry secrets; patches can write this root.
  readonly context?: string
  /** Digest of the draft bytes evaluated, so a later edit cannot inherit this receipt. */
  readonly contentDigest: string
}

// `runs.start` copies both gate-run markers off the durable record, so a missing one means refused.
export interface DraftRunPortLike {
  start(input: RunsStartInput): Promise<RunStartAcknowledgement>
  get(runId: string): Promise<CompletedRunHandoff | undefined>
}

// Synchronous over a local SQLite table; a bound index is already scoped to one product.
export interface SuiteFingerprintIndexLike {
  // Empty table, empty union.
  elementUnion(): ReadonlySet<string>
  /** The identities that HAVE fingerprint rows — the fingerprint lane's population. */
  coveredTests(): readonly SuiteTestIdentity[]
  /** One identity's ordered elements, for the per-test subsumption row on the finding. */
  elementsForTest(filePath: string, testName: string): readonly string[]
}

/** The stable test identity, spelled once. */
export interface SuiteTestIdentity {
  readonly filePath: string
  readonly testName: string
}

// Suite tests the derived index has no rows for; the host builds that set, not the index.
export interface SuiteTextCorpusEntryLike {
  readonly filePath: string
  readonly testName: string
  /** Pre-interpolation step text, same rule as the draft's. */
  readonly stepsText: readonly string[]
}

// Only `put`: the evaluator writes and never reads back.
export interface DraftReceiptsStoreLike {
  put(receipt: DraftReceipt): Promise<void>
}

// Read-only and separate from the write port, so the funnel cannot overwrite what it reports on.
export interface DraftReceiptsReadPortLike {
  list(): Promise<DraftReceipt[]>
}

// The loop's host halves: reading what the project knows, and compiling with a model and a shelf.

/**
 * The read half of the loop (stages 1-2).
 *
 * TWO VERBS, ONE FACT. `getAuthoringBrief` is the substrate stage 3 compiles from;
 * `suiteTextCorpus` is the comparison universe stage 2 screens the intent against. A host that
 * could serve one and not the other does not exist — both are reads of this project's own state
 * through capabilities the composition root holds together — so splitting them would make "can
 * this host run the loop's read stages" two questions with one answer, and would let a
 * composition report the op bound while dedup-before-author had nothing to compare against. An
 * empty corpus is a legitimate answer; an absent one is a host that cannot screen.
 *
 * `suiteTextCorpus` yields the SHIPPED {@link SuiteTextCorpusEntryLike} rather than a second
 * entry shape, so stage 2 and gate 3's degraded lane screen the same rows through the same
 * `textSimilarity` and cannot drift into two notions of what a suite test's text is.
 */
export interface AuthoringReadPortLike {
  getAuthoringBrief(intent: string, scope: ScopeKey): Promise<AuthoringBrief>
  suiteTextCorpus(): Promise<readonly SuiteTextCorpusEntryLike[]>
  // Target names, a separate read from the Scope block, which names a product.
  configuredTargetNames(): Promise<readonly string[]>
}

// Separate from the read half because it needs config and tests; it answers or throws.
export interface AuthoringScopePortLike {
  deriveDefault(): Promise<ScopeKey>
}

// Model YAML is parsed before it becomes a file, so an unparsable draft never reaches disk.
export type DraftStageOutcome =
  | { readonly kind: 'staged'; readonly draft: ParsedDraftLike }
  | { readonly kind: 'unparsable'; readonly reason: string }

/**
 * The compile half of the loop (stage 3).
 *
 * ONE BUNDLED CAPABILITY rather than two deps, on the shipped `draftEvaluation` precedent: a host
 * with a model and no shelf cannot author, and a host with a shelf and no model has nothing to
 * author with, so binding them separately would let a composition list this op `bound` and fail
 * far from whichever half was forgotten.
 *
 * `write` TAKES THE BYTES AND NOTHING ELSE. The digest is computed by the host over the bytes it
 * is writing, never supplied by the caller — `DraftRef.contentDigest`'s whole promise is that a
 * later edit cannot inherit an earlier receipt, and a caller that could name the digest could
 * name one that is not the digest of anything. The path is minted from that digest, so nothing
 * the model emitted reaches the filesystem as a path component either.
 *
 * The returned draft's `filePath` is WORKSPACE-RELATIVE, which is one spelling doing three jobs:
 * it is what `authoring.draft.verify` takes as `draftPath`, what `runs.start` accepts in
 * `patterns`, and what the runner records on `PerTestOutcome.filePath` so gates 1-2 can find the
 * draft's own member.
 */
export interface DraftShelfPortLike {
  // A factory, so a host that never authors a draft never constructs a model client.
  model(): Promise<JobModelCapability>
  /** Parse, then write, in that order. An unparsable draft leaves nothing on disk. */
  write(contents: string): Promise<DraftStageOutcome>
  // Bound by the host over `core`'s CST applier, which this package cannot import.
  applyPatches(draft: ParsedDraftLike, patchSet: TestEditPatchSet): Promise<DraftStageOutcome>
  // The handoff reader, because routing needs per-step evidence that a `RunDetail` does not carry.
  readonly runs: DraftRunPortLike
  // A closure the composition root mints over its registry, so this package never names one.
  verifyDraft(input: AuthoringVerifyDraftInput): Promise<DraftReceipt>
  // The loop decides whether to call it; the host guards the path and digest and writes by rename.
  publish(request: TestFilePublishRequestLike): Promise<TestFileWrite>
}

/** One final draft to write: the shelf copy, where it goes, and what that path held when read. */
export interface TestFilePublishRequestLike {
  /** The staged draft's workspace-relative shelf path — where the bytes come from. */
  readonly draftPath: string
  /** Where they go. Boundary-checked at the host by the identity mint and the real path. */
  readonly targetPath: string
  /** The digest of the bytes the caller read at `targetPath`; absent means it must not exist. */
  readonly sourceDigest?: string
}

