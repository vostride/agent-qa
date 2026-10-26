// The function-layer contract types (Phase 384, FUNC-01 / D-08 / D-09 / D-14 / D-15).
//
// `FunctionDeclaration` is the public, capability-free VIEW of an op: everything a
// surface needs to discover, describe, and project the capability (MCP tool listings,
// the 397 golden snapshot, the `agent-qa fn --list` catalog) and nothing that runs it.
// `FunctionSpec` adds the LIVE input/output validators and the implementation, and NEVER
// leaves this directory — the package barrel exports the declaration type only, so no
// surface can acquire a dispatch path that skips `invokeFunction`'s gate call (T-384-01),
// nor a handle on the schema objects that dispatch enforces with (T-384-14).

import type { EventLogPort } from '@vostride/agent-qa-runner'
import type { z } from 'zod'

import type {
  AgentAskInput,
  AgentAskResult,
  OutputContract,
  ClauseReceiptStatus,
  CompletedRunHandoff,
  CommitReceipt,
  CurationSnapshot,
  EntityDescriptor,
  EntityResolution,
  ForgetReceiptV1,
  FeedbackPort,
  FeedbackReadsPort,
  InspectRecordView,
  JobStatus,
  KnowledgeAcceptInput,
  KnowledgeBundleSummary,
  KnowledgeChangeOutput,
  KnowledgeGatesListResult,
  KnowledgeForgetInput,
  KnowledgeMarkInput,
  KnowledgeRecordShowInput,
  KnowledgeRecordShowResult,
  KnowledgeTargetRef,
  LiveStreamDeclaration,
  LiveUrlSigner,
  KnowledgeRecordsDiffInput,
  KnowledgeRecordsInspectInput,
  KnowledgeRejectInput,
  EvidenceBlobLookup,
  EvidenceBlobPresence,
  MaskFn,
  MaskedResolvedConfig,
  PostProcessingStageDetail,
  QuarantineOperationsPort,
  RecordChange,
  RecordedTargets,
  RiskActionDescriptor,
  RunAnalysisArtifact,
  RunDetailRows,
  RunId,
  RunNotification,
  RunsStartInput,
  StepEvidence,
} from '@vostride/agent-qa-schema'

import type { AuthoringFunnelPortLike } from '../authoring/funnel.js'
import type {
  ConfigFilesPortLike,
  ConfigScaffoldContentPortLike,
  ConfigValidatePortLike,
  ConfigWritePortLike,
} from '../config-mutation/ports.js'
import type { CapabilityCatalogPort } from '../explain/port.js'
import type { EvaluateDraftPorts } from '../authoring/verify-draft.js'
import type {
  AuthoringReadPortLike,
  AuthoringScopePortLike,
  DraftShelfPortLike,
  ParsedDraftLike,
} from '../authoring/ports.js'
import type { RecurrenceProvider } from '../analysis/render-sentence.js'
import type { ChainJobIds } from '../jobs/chain-identity.js'
import type { JobIdSource } from '../jobs/engine.js'

/**
 * How an op returns its result (D-08).
 *
 * `unary` resolves ONE value, validated against the spec's `output` contract.
 * `stream` resolves a {@link FunctionStream} whose elements each honour that same
 * `output` contract — the contract describes one element, never the iterable.
 */
export type FunctionResultKind = 'unary' | 'stream'

/**
 * A stream op's result (D-08): a typed async iterable of seq-stamped elements.
 *
 * Connection-independent by construction — every element carries its own resume token, so
 * a caller that observed token N re-invokes with that token and receives N + 1 onward.
 * Nothing about the iterable is bound to the transport that produced it, which is why
 * 386's live attach and this phase's completed-run replay are the SAME contract.
 */
export type FunctionStream<Element = unknown> = AsyncIterable<Element>

/**
 * One replayed run event, defined AS the element type the runner's `EventLogPort.read`
 * yields. Binding it to the runner contract rather than restating the envelope means the
 * layer cannot drift out of step with the log the runner actually writes.
 */
export type ReplayedRunEvent = ReturnType<EventLogPort['read']>[number]

/**
 * Whether the op's implementation is bound in THIS composition (D-09). A declared-but-
 * unbound op is a visible state, never a silent gap: coverage checks must treat
 * `unbound` as covered-but-unbound rather than as an absent capability.
 *
 * It is a property of a COMPOSITION, not of a spec, and since 385 (D-16) it is computed
 * that way: the field lives on {@link FunctionDeclaration} — which a registry mints from
 * the deps it was handed — and on no spec. A spec that carried a static `'bound'` would be
 * making a claim about compositions it is not part of, and the first composition that
 * omitted the implementation would report `bound` and lie. There is no literal to flip.
 */
export type FunctionBindingStatus = 'bound' | 'unbound'

/**
 * The OPTIONAL members of {@link FunctionDeps} — the deps whose presence varies by host.
 *
 * A spec naming one of these in {@link FunctionSpec.boundThrough} is bound exactly in the
 * compositions that supplied it. This union is the whole vocabulary: a capability cannot
 * become conditionally bound on something the deps record does not declare, so "which
 * compositions can run this op" is answerable by reading two lines.
 */
export type OptionalFunctionDepKey =
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
  | 'feedback' // 2026-09-08, 419 GATE3-01: the Gate-3 mark port
  | 'feedbackReads' // 2026-09-15, 423 D-19/D-16: read-only mark history and preview, no writer authority
  | 'configWrite' // 2026-09-30, 432-07 D-05/D-07: the direct config writer, no proposal and no git
  | 'secretMask' // 2026-10-14, 441-16 D-06: the declared-secret mask the run reads project through

/**
 * 419 GATE3-01: the union previously had only a type-level pin, invisible to vitest.
 * Like DELTA_ORIGINS and MARKS, this runtime projection makes removal measurable.
 */
export const OPTIONAL_FUNCTION_DEP_KEYS = [
  'liveView',
  'runInvocation',
  'knowledgeReview',
  'postProcessing',
  'runDetail',
  'evidenceBlobs',
  'analysis',
  'recurrence',
  'quarantine',
  'chatTurn',
  'draftEvaluation',
  'authoringRead',
  'authoringScope',
  'draftShelf',
  'authoringFunnel',
  'configFiles',
  'configValidate',
  'scaffoldContent',
  'capabilityCatalog',
  'feedback',
  'feedbackReads',
  'configWrite',
  'secretMask',
] as const satisfies readonly OptionalFunctionDepKey[]

type ExactlyEqual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
type _Cover = ExactlyEqual<(typeof OPTIONAL_FUNCTION_DEP_KEYS)[number], OptionalFunctionDepKey>
const _optionalFunctionDepKeysCover: _Cover = true
void _optionalFunctionDepKeysCover

/**
 * The capability is declared, but no implementation is bound in THIS composition (D-09).
 *
 * Deliberately distinct from `UnknownFunctionError`: the contract exists, is listed, and
 * projects into a catalog — what is absent is the binding. A caller (or a coverage check)
 * that could not tell those two apart would read a staged capability as a hole in the API,
 * which is the silent gap `bindingStatus` exists to prevent.
 *
 * Declared here beside {@link FunctionBindingStatus} rather than beside the pipeline's
 * other refusals so an unbound op can throw it without an op → invoke → registry → op
 * import cycle; `invoke.ts` re-exports it, so the layer's refusal vocabulary still reads
 * as one set at the call site.
 */
export class FunctionNotBoundError extends Error {
  constructor(readonly functionId: string) {
    super(`${functionId} is declared but not bound in this composition`)
    this.name = 'FunctionNotBoundError'
  }
}

/**
 * The scalar metadata every capability carries, shared by the public view and the
 * internal spec.
 *
 * `id` is dot-namespaced `domain.verb` (D-15) over ONE canonical domain taxonomy.
 *
 * 2026-08-16 (397 D-18): this docstring used to repeat D-15's original eight domains
 * (tests · runs · memory · analysis · eval · gates · config · agent), and six later phases
 * shipped ids in domains that list does not contain — so the sentence had been false for a
 * month by the time anyone checked it. The taxonomy is now DATA rather than prose, pinned in
 * the conformance suite's `domain-list.ts` with a one-line charter apiece and censused
 * against this registry in both directions. An id in an unpinned domain is a named RED
 * there; widening the taxonomy is a reviewed one-line diff to that table. Ids are never
 * renamed to suit it — they are the shipped, locked contract, and the taxonomy serves them.
 *
 * The two CONTRACT fields are deliberately NOT here. They are the one place the view and
 * the spec must differ in kind — a projection on one, a live validator on the other — and
 * splitting them out is what makes that difference a property of the type system rather
 * than a rule someone has to remember at the seam (BL-01 / T-384-08).
 */
export interface FunctionMetadata {
  id: string
  /** One-line human description; rendered by catalogs and `agent-qa fn --list`. */
  summary: string
  // 2026-10-02 (432-39, D-10/D-12): no `requiredScopes` and no `requiresHumanOrigin`. Both were
  // retired and unread since 432-20 and every op spec stopped spelling them by 432-27; the members
  // are deleted with the capability-scope union, so no metadata, spec or declaration can carry either.
  resultKind: FunctionResultKind
  /** The risk descriptor of this op: listings, MCP tool annotations and the read scope read it (no gate since 432-13). */
  risk: RiskActionDescriptor
}

/**
 * An INERT description of one declared contract: a JSON-Schema document, deep-frozen.
 *
 * A projection has no `parse` and no `safeParse` — there is nothing on it to run and
 * nothing on it to replace. That is the whole point. The surface-visible view used to
 * carry the live `z.ZodType`, and because ops assign the schema package's own exported
 * validators, a single write reached through a permitted `registry.list()` replaced the
 * contract vocabulary every firewalled surface imports, for the whole process. Publishing
 * a projection removes the object that write needed rather than adding a rule about it.
 *
 * D-14 already named the input contract "also the JSON-Schema projection source"; on the
 * declaration that description is now literal, and it is the shape 396's MCP tool listing
 * consumes.
 */
export type FunctionSchemaProjection = Readonly<Record<string, unknown>>

/**
 * What one clause's result MEANT, as the op that produced it reports (Phase 399.1, D-01/D-02/D-03).
 *
 * TWO FIELDS AND NO THIRD. `status` is the one bit a surface must not get wrong — whether the thing
 * was carried out — and `outcome` is the sentence that says which road it came in by. Anything
 * larger would be a second payload channel, and the payload has one (`results[]`).
 *
 * `not-run` IS ABSENT FROM THE STATUS SET, AND ITS ABSENCE IS THE POINT. That member describes a
 * clause the ENGINE deliberately never attempted after an earlier one failed — a fact about the
 * turn, which no op can know and none may claim. The three a classifier may return are derived from
 * the schema's own vocabulary rather than re-spelled, so a fifth receipt status cannot appear here
 * without somebody deciding whether an op may return it.
 *
 * THE `failed` MEMBER IS WHAT MAKES THIS FAIL-CLOSED POSSIBLE (D-03). A result the declared fold
 * cannot read reports `failed` with a named outcome, never `executed`: an unreadable result might be
 * a refusal, so success is the one claim a receipt must never default to.
 */
export interface ClauseVerdict {
  readonly status: Exclude<ClauseReceiptStatus, 'not-run'>
  /**
   * WHICH road, in the op's own vocabulary — `schema-fail`, `refs-only`, a proposal id.
   *
   * The empty string means "this op has nothing to add", and the engine falls back to the line it
   * has always printed. It is not a second spelling of absence: a fold that had nothing to say and a
   * fold that was never declared reach the same rendered line, which is the honest outcome for both.
   */
  readonly outcome: string
}

/**
 * The public, capability-free description of one registered capability.
 *
 * Carries no live validator and nothing runnable: every value reachable through a
 * declaration is data. `invokeFunction` reads the enforcing schema off the {@link
 * FunctionSpec} instead, which never leaves this directory.
 */
export interface FunctionDeclaration extends FunctionMetadata {
  /**
   * Whether THIS composition can run the op (D-09/D-16).
   *
   * Computed by the registry from the deps it was constructed with, never copied off a
   * spec. A listing is therefore a fact about the host a caller is talking to: the same
   * capability reads `bound` from a composition that supplied its implementation and
   * `unbound` from one that did not, and `invokeFunction` refuses on exactly that answer.
   */
  bindingStatus: FunctionBindingStatus
  // 2026-10-02 (432-42, D-14): no `discloses` flag. It projected the presence of the per-op
  // disclosure a confirm prompt showed; the prompt and the method are deleted, and so is the column.
  /**
   * This op folds its OWN result into a clause verdict (2026-08-20, Phase 399.1 D-01).
   *
   * PRESENCE, AS DATA — never the callable: {@link FunctionSpec.classify} stays where it is, and a
   * function-valued field on {@link FunctionMetadata} would put something runnable back on every
   * listing (BL-01).
   *
   * WHAT THE PROJECTION IS FOR, AND WHY IT IS NOT DECORATION. D-01 puts refusal knowledge in a
   * per-op fold rather than in a chat-side rule that pattern-matches values, because a rule that
   * can only refuse what it can NAME cannot be driven to zero by naming more things. The cost of
   * that choice is coverage: an op that never declared a fold reports the legacy `executed` for
   * every result it can return, silently. This boolean is what makes that countable — the census in
   * `packages/cli` cannot reach a spec by construction, so without it the coverage question could
   * only be answered by somebody reading forty-three op files.
   *
   * `true` is the only value: `false` and an absent key would be two spellings of one fact, and a
   * present `undefined` would make a golden column read `null` for an op that simply has no fold.
   */
  classifies?: true
  /**
   * This op composes its own human-facing lines on top of the default payload render (399.1 D-04).
   *
   * PRESENCE, AS DATA, on the two flags above. The fold ADDS legibility and can never suppress: the
   * default render is the complete payload and a declared fold is printed beside it, never instead
   * of it. That is a property of the render path rather than of this flag, and the flag is here so
   * a listing — and the golden ledger — can say which ops carry one.
   */
  rendersResult?: true
  /** Inert JSON-Schema projection of the runtime input contract (D-14). */
  input: FunctionSchemaProjection
  /**
   * Inert JSON-Schema projection of the runtime output contract (D-14).
   *
   * For a `unary` op the underlying contract describes the whole result. For a `stream`
   * op it describes ONE element, never the iterable, and a catalog reads this projection
   * as the element schema its transport (SSE frame, MCP notification) carries.
   */
  output: FunctionSchemaProjection
}

/**
 * INTERNAL: metadata plus the LIVE contracts plus the implementation. Deliberately absent
 * from the package barrel — exporting this type (or any helper taking one and running it)
 * would hand a surface a private power, which is precisely what the function layer
 * abolishes.
 *
 * A spec is NOT a declaration: it extends the shared scalar metadata and re-declares the
 * two contract fields as live `z.ZodType`s. `invokeFunction` is the only reader of those,
 * and it reaches them through the module-private internals seam.
 */
export interface FunctionSpec<Input = unknown, Output = unknown> extends FunctionMetadata {
  /**
   * The OPTIONAL dep this implementation dispatches through, when it has one (D-16).
   *
   * Absent — the ordinary case — means the implementation needs only the required deps,
   * which every composition supplies by type, so the op is bound wherever it is registered.
   * Present means the op is bound exactly in the compositions that supplied that dep, and
   * `unbound` everywhere else. This field is the whole of a spec's say in the matter: a
   * spec states what its implementation NEEDS, and the composition's answer to that need is
   * what the declaration reports.
   */
  boundThrough?: OptionalFunctionDepKey
  /** Runtime input contract (D-14) — the validator `invokeFunction` enforces with. */
  input: z.ZodType<Input>
  /**
   * Runtime output contract (D-14).
   *
   * For a `unary` op this is the contract for the whole result, and `invokeFunction`
   * validates against it. For a `stream` op it is the contract for ONE element: parsing
   * the iterable itself against it would be a category error.
   */
  output: z.ZodType<Output>
  /**
   * The canonical output document's companion, for an output zod cannot convert in output mode
   * (2026-09-28, 431-03 · D-03, research A1).
   *
   * OPTIONAL, and it never validates anything: `output` stays the one enforcing schema, and the
   * registry refuses a companion whose `runtimeSchema` is not that same object. What it changes is
   * only the declaration's output projection, which is read from the companion's output document
   * instead of the input-mode conversion.
   */
  outputRepresentation?: OutputContract<z.ZodType<Output>>
  // 2026-10-02 (432-42, D-14/D-15): no `disclose` method. It composed the per-invocation cost line
  // a confirm prompt showed before a person approved; no door asks, so nothing calls it.
  /**
   * What this op's OWN result means, as a clause verdict (2026-08-20, Phase 399.1 D-01/D-02).
   *
   * THE OP FOLDS ITS OWN UNION, AND NOTHING ELSE MAY. Chat cannot tell a refusal from a success by
   * looking at a result: 399's UAT measured a credential-blocked config mutation, a validation
   * failure and a real proposal all reported as `executed` in green, because the engine derived the
   * status from throw-vs-return and every one of the three RETURNED. The knowledge of which arm of
   * `ConfigProposeOutput` is a refusal lives in exactly one place — the op that declared the union —
   * and this is that place. The alternative D-01 rejects by name is a chat-side rule matching values
   * or field names, which can only ever refuse what somebody has already thought to name.
   *
   * IT LIVES ON THE SPEC, NOT ON {@link FunctionMetadata}, and its presence projects onto the
   * declaration as {@link FunctionDeclaration.classifies}: the callable stays here and only the
   * boolean fact crosses to a listing.
   *
   * PURE BY CONTRACT: it runs on the composition root's return path with the op's
   * own output in hand, and a port reached from here would be I/O between an act and the report of
   * what the act was.
   *
   * IT DECIDES NOTHING AND CANNOT WIDEN ANYTHING. The op has already run,
   * and the audit row is already written when this is called. What it produces is the REPORT.
   *
   * REQUIRED AS OF 2026-08-20 (399.1 plan 04), AND ENFORCED IN TWO PLACES THAT SEE DIFFERENT
   * THINGS. It was optional for one plan while the fan-out landed, and an op that declared none
   * reported the legacy `{ status: 'executed', outcome: '' }` — the same line every op reported
   * before this member existed. Forty ops reported it for two phases, silently, which is the cost
   * D-01 accepted when it put refusal knowledge on the op instead of in a chat-side rule.
   *
   * LAYER ONE IS `tsc`, AT THE KEYSTROKE. An op file that omits this does not compile, so the
   * ordinary way of shipping an unclassified op is closed at the moment it is written.
   *
   * LAYER TWO IS THE CONFORMANCE CENSUS ON THE SHIPPED REGISTRY
   * (`packages/cli/src/__tests__/conformance/classifier-census.test.ts`), AND IT IS NOT A
   * RESTATEMENT OF LAYER ONE. The type is defeatable: `registry.ts` already registers
   * `runsEventsSpec as FunctionSpec`, and an `as`-cast, a spread of a partial literal, or a
   * registry assembled from another type all satisfy `tsc` while shipping an op with no fold. The
   * census reads what the product CONTAINS — the declarations a composed root lists — so it answers
   * the question the type cannot, by op id, in both directions.
   *
   * AND THE RUNTIME NO LONGER DEFAULTS. `foldFunctionResult` used to answer `executed` for an
   * absent classifier; it answers `failed`/`unclassifiable-result` now, because with this member
   * required an absent one means a cast got past both layers, and success is the one claim a
   * receipt must never default to (D-03).
   */
  classify(output: Output): ClauseVerdict
  /**
   * Extra human lines this op's result deserves, on top of the complete payload render (399.1 D-04).
   *
   * ADDITIVE BY CONTRACT. The default render is the whole masked payload, pretty-printed, and a
   * declared fold is printed BESIDE it — never instead of it, never as a filter over it. D-04 makes
   * that a law rather than a convention because RC-2's lesson is that a hand-picked field join is a
   * drop site: the fan-out report and the explain lines are legibility a person is glad of, and
   * neither is a reason to stop showing them what the op actually returned.
   *
   * PURE BY CONTRACT and PRESENCE-PROJECTED as {@link FunctionDeclaration.rendersResult}, on
   * `classify`'s arrangement above.
   */
  renderResult?(output: Output): readonly string[]
  invoke(input: Input, deps: FunctionDeps): Promise<Output>
}

/**
 * INTERNAL: metadata plus live contracts plus the implementation for a `stream` op (D-08).
 *
 * `Element` is what the declared `output` contract describes — ONE element, never the
 * iterable. The stream is ACQUIRED inside `invoke` rather than lazily on first iteration,
 * so an acquisition refusal (a resume token below the replay floor, say) surfaces as an
 * invocation failure instead of as a stream that dies half-delivered.
 *
 * A stream spec is registered by widening to {@link FunctionSpec}: the registry stores one
 * spec shape, and `invokeFunction` branches on the DECLARED `resultKind`, never on what
 * the implementation happens to return.
 */
export interface FunctionStreamSpec<Input = unknown, Element = unknown>
  extends FunctionMetadata {
  boundThrough?: OptionalFunctionDepKey
  resultKind: 'stream'
  input: z.ZodType<Input>
  output: z.ZodType<Element>
  /**
   * What a stream op's RESULT meant, folded over the acquisition rather than over an element
   * (2026-08-20, Phase 399.1 D-01).
   *
   * IT IS HANDED THE STREAM, NOT AN ELEMENT, AND THE TYPE SAYS SO. `foldFunctionResult` runs on the
   * composition root's return path with whatever `invoke` answered in hand, and for a stream op
   * that is the iterable. Declaring this over `Element` would have been a signature promising an
   * argument the runtime never passes.
   *
   * IT MUST NOT CONSUME WHAT IT IS GIVEN. Reading an element to decide a verdict would eat the
   * first event of the caller's replay — a side effect, on a member both this and
   * {@link FunctionSpec.classify} contract as pure. What a stream op can honestly report is that
   * the acquisition SUCCEEDED, which is a real fact here: the header above insists the stream is
   * acquired inside `invoke` precisely so an acquisition refusal is a throw rather than a stream
   * that dies half-delivered.
   *
   * REQUIRED, on {@link FunctionSpec.classify}'s reasoning and for a sharper reason here: a stream
   * spec reaches the registry through `runsEventsSpec as FunctionSpec`, so this shape's own `tsc`
   * layer is the ONLY one that fires at the keystroke for it. An optional member here would leave
   * stream ops with no type-level census at all.
   */
  classify(output: FunctionStream<Element>): ClauseVerdict
  invoke(input: Input, deps: FunctionDeps): Promise<FunctionStream<Element>>
}

/**
 * Injected read port over the completed runs recorded for a project.
 *
 * `packages/agent` is `storageNeutral`: no host builtin is importable here. Every byte of run
 * state arrives through this port, built at the composition root over the concrete
 * `runner-local` handoff store.
 */
export interface RunsReaderPort {
  /** Every completed run this project can load. Missing run storage yields `[]`. */
  list(): Promise<readonly CompletedRunHandoff[]>
  /**
   * One completed run by id, or `undefined` when no such run is recorded.
   *
   * Absence is a RESULT, not an error: the typed refusal is the op's to throw, so the
   * "not found" vocabulary lives in this layer rather than in every composition root.
   * Implementations resolve the id against the runs they already enumerate — never by
   * joining a caller-supplied string onto a filesystem path (T-384-08).
   */
  get(runId: RunId): Promise<CompletedRunHandoff | undefined>
  /**
   * Replay one run's recorded event stream, starting at `fromSeq` and in `seq` order.
   *
   * The exact `EventLogPort.read(fromSeq)` contract the v49 bus already replays against,
   * lifted behind a port so this layer needs no host access. A run with no recorded
   * events replays as an ordinary empty result — nothing was truncated, so nothing is
   * refused. When events below `fromSeq` existed but are no longer available, the
   * implementation rejects with the runner's `ReplayIncompleteError` carrying the lowest
   * seq it can still serve; the op turns that into the layer's typed refusal. Serving a
   * silently truncated prefix is the one thing an implementation may never do.
   */
  readEvents(runId: RunId, fromSeq: number): Promise<readonly ReplayedRunEvent[]>
  /**
   * Read back ONE step's persisted evidence — the substrate `knowledge.brief.why` answers
   * from (Phase 387, KREV-02 / D-15).
   *
   * On the RUNS port and not on the knowledge port, and that placement is the whole honesty
   * argument rather than filing. A step's evidence is a record of what happened during a run;
   * the knowledge index is a record of what is true now. Answering "why did the brief say
   * this" out of the second would answer a different question than the one asked, and the op
   * that answers it is given no serving capability at all, so re-running retrieval is not a
   * temptation it has to resist.
   */
  readStepEvidence(
    runId: RunId,
    address: StepEvidenceAddress,
  ): Promise<StepEvidenceLookup>
  /**
   * The target names one completed run recorded WHEN IT RAN (431 D-08), never current
   * configuration. `unknown` when the run has no readable snapshot, including one that vanished
   * after `list()` answered. Optional: an unbound reader leaves every run unknown, and an unknown
   * run never matches a requested target. Implementations resolve only runs they enumerate.
   */
  getRecordedTargets?(runId: RunId): Promise<RecordedTargets>
}

/**
 * Which step's evidence is wanted.
 *
 * `testId` is optional and its optionality is the never-guess contract, not a convenience:
 * `StepEvidence.stepIndex` is numbered per MEMBER TEST, so a run with two tests has two step
 * 0s and `(runId, stepIndex)` addresses neither of them. A single-test run needs no
 * disambiguator; a multi-test run that omits it has asked an ambiguous question, and the
 * lookup says so by name rather than answering about whichever test happened to be first.
 */
export interface StepEvidenceAddress {
  readonly stepIndex: number
  readonly testId?: string
}

/**
 * What a step-evidence read found — four situations a caller phrases four different ways.
 *
 * A bare `StepEvidence | undefined` was the obvious shape and it is the wrong one: it
 * collapses "no such run was ever recorded", "that run has no such step" and "your address
 * matches more than one step" into one silence. The why-verb has to distinguish the first two
 * (its no-trace vocabulary already does, and a surface tells the reader to go looking in one
 * case and not the other), and it must never treat the third as an absence — an ambiguous
 * address answered with a `not found` would be a wrong answer wearing an honest one's clothes.
 */
export type StepEvidenceLookup =
  | { readonly kind: 'found'; readonly evidence: StepEvidence }
  | { readonly kind: 'run-not-recorded' }
  | { readonly kind: 'step-not-found' }
  | { readonly kind: 'ambiguous-step-address'; readonly testIds: readonly string[] }

/**
 * Injected read port over the committed knowledge store.
 *
 * Backed by the knowledge-local `/reader` package entry at the composition root. The
 * writer-gated main entry is unreachable from this layer by construction.
 */
export interface KnowledgeReaderPort {
  /**
   * 2026-09-06, 416 D-17: gate history and the current verdict. Optional so existing
   * implementations and fakes remain type-valid; an unbound read refuses by name.
   */
  gateReceipts?(input: { candidateId: string }): Promise<KnowledgeGatesListResult>
  /** Every committed bundle, already projected to the schema-owned listing row. */
  listBundles(): Promise<readonly KnowledgeBundleSummary[]>
  /**
   * The maintenance view of every record matching a closed structural filter (KREV-01).
   *
   * Wiring over the reader entry's own `inspectRecords`, and the return type says so: it is
   * that function's view schema and not a paraphrase of it. KREV-01's "no new memidex code"
   * claim survives only while that stays literally true, and the first field of a paraphrase
   * to drift would be the one nobody looked at.
   */
  inspectRecords(input: KnowledgeRecordsInspectInput): Promise<readonly InspectRecordView[]>
  /** Every record change since a build ordinal — the reader entry's `diffSince`, wired. */
  diffSince(input: KnowledgeRecordsDiffInput): Promise<readonly RecordChange[]>
  /**
   * One record with the provenance that justifies it, or a named absence.
   *
   * Absence is a RESULT here rather than a refusal the port throws, because a record id that
   * names nothing is an ordinary reviewer question and not a broken store. The op renders the
   * answer; it never decides what "found" means.
   */
  showRecord(input: KnowledgeRecordShowInput): Promise<KnowledgeRecordShowResult>
  /**
   * Current maintenance content for caller-supplied identities, in first-request order
   * with duplicates removed. Missing records remain per-ID results; an incomplete scan
   * retains the maintenance reader's typed failure for the caller to report honestly.
   * Optional for existing hosts: consumers refuse an unbound capability by name.
   * This read does not sight identities or change storage.
   */
  showRecords?(input: { recordIds: readonly string[] }): Promise<readonly KnowledgeRecordShowResult[]>
  /**
   * What became of the canary lines THIS run served (2026-08-29, Phase 407 · D-08).
   *
   * ONE ROW PER TUPLE ASKED ABOUT, in the order asked. The caller supplies the served-canary
   * tuples it already holds from the run's own evidence — `candidateId` is the served channel-1
   * line's id, which IS the curation candidate id — and the reader answers with the observation
   * id each tuple's outcome event would carry, plus that outcome when a surviving attributed
   * event exists. `outcome` ABSENT means "no attributed event survives for this tuple", which is
   * an ordinary state (curation has not settled, or it settled and attributed nothing) and NOT
   * an error; `observationId` is always present because it is DERIVED from the tuple —
   * `canaryOutcomeObservationId({ candidateId, runId, testId, testIndex, stepIndex })` — rather
   * than looked up, so a caller can name the event it is waiting for before that event exists.
   *
   * ON THE READER PORT AND NOT THE RUNS PORT, unlike `readStepEvidence` one interface up: the
   * SERVING half of a canary (the marker) is a fact about the run and is read from its evidence,
   * but the ATTRIBUTED half is a fact about the committed knowledge store's outcomes log. Asking
   * the runs port for it would be asking a record of what happened for a record of what is true.
   *
   * OPTIONAL, so every existing port implementation and every test fake stays type-valid. The
   * `/reader` entry implements it in 407-04 and agent-local binds it there; until then a caller
   * sees `undefined` and renders the honest not-yet-attributed state rather than a wrong badge.
   *
   * THE ANSWER CARRIES ITS OWN PARTIALITY (407-19, REVIEW WR-03). `skippedBundles` is the walk's
   * count of bundles it could not load — corrupt, truncated, or failing the integrity check that
   * catches tampering. `> 0` means the answer is PARTIAL, and a caller must not render an absent
   * `outcome` as a positive `not attributed`: on a partial walk that absence means "not found in
   * the part of the store I could read", which is a different sentence. The count rides HERE, on
   * the read that degraded, rather than being inferred from a sibling read failing on the same
   * file — an inference that does not survive the two reads seeing different stores.
   */
  canaryAttributions?(input: {
    runId: string
    tuples: readonly {
      candidateId: string
      testId: string
      testIndex: number
      stepIndex: number
    }[]
  }): Promise<{
    readonly rows: readonly {
      candidateId: string
      testIndex: number
      stepIndex: number
      observationId: string
      outcome?: 'confirmed' | 'contradicted' | 'helpful' | 'harmful'
    }[]
    readonly skippedBundles: number
  }>
}

/**
 * Injected WRITE capability over knowledge review — accept, reject and forget (Phase 387,
 * KREV-01 / D-17, declared here and implemented in 387-08; direct since 432-12).
 *
 * A SEPARATE port from {@link KnowledgeReaderPort}, and separate is the point. Widening the
 * reader with a write member would have handed a write path to every composition that only
 * ever wanted to list bundles — including the read-only surfaces the physically-separate
 * reader entry exists to keep write-free — and no lint could have told the two apart
 * afterwards, because they would have been one type. The split is what keeps "this host can
 * read knowledge" and "this host can change it" two different, separately answerable
 * questions.
 *
 * OPTIONAL on {@link FunctionDeps} and joined to {@link OptionalFunctionDepKey} for the same
 * reason `runInvocation` is: a host that cannot mutate knowledge — a listing registry, a
 * read-only surface — must report that as a VISIBLE `unbound` on the verbs by name, not as a call
 * that fails somewhere far away.
 *
 * 2026-09-30, 432-12 (D-04/D-05/D-09): `change` applies an explicit accept, reject or forget in the
 * call, through the explicit writer, in every execution context, under the writer lease. It is the
 * member every change op reaches. 2026-10-01 (432-17): `propose` and `apply` are deleted with the
 * proposal inbox; old proposal files are never read again (D-22).
 */
export interface KnowledgeReviewPort {
  /**
   * Apply one explicit knowledge change in the call and answer what it changed (432-12).
   *
   * Validation, target resolution, the writer lease, delegation to a live holder, delta
   * validation, bundle egress and every promotion gate belong to the writer behind this member.
   * A repeated `operationId` is the same change and lands once; an absent one is minted.
   */
  change(request: KnowledgeChangeRequest): Promise<KnowledgeChangeOutput>
}

/**
 * One explicit knowledge change (432-12): the verb, the input that verb takes, and the caller's
 * stable identity for it when the caller has one.
 *
 * Discriminated so `reject`'s required reason cannot be omitted by asking for an accept. A mark is
 * not here: it changes knowledge through `runs.mark`, which owns its own identity and checkpoints.
 */
export type KnowledgeChangeRequest = (
  | { readonly verb: 'accept'; readonly input: KnowledgeAcceptInput }
  | { readonly verb: 'reject'; readonly input: KnowledgeRejectInput }
  | { readonly verb: 'forget'; readonly input: KnowledgeForgetInput }
) & { readonly operationId?: string }

/**
 * Injected read port over the entity directory (Phase 387, ENTY-01 / D-09).
 *
 * Two verbs, and the split is the never-guess contract expressed as a type. `resolve` takes
 * anything a human or a model might say and answers with a closed three-arm union, so a
 * caller is structurally unable to receive a maybe. `get` takes an address that already
 * exists and answers with the entity or with nothing.
 *
 * Descriptor-level on purpose. The port carries FACTS about an entity and never a card,
 * which is what leaves exactly one card producer in this layer (ENTY-02): a composition
 * cannot render, because it is handed no vocabulary in which to do so.
 *
 * `get` may not mint. `resolve` sights, and sighting is what assigns a permanent address
 * (D-01); a `get` that could write would make every card render on every surface a
 * potential mutation of the one durable store this system never rebuilds.
 */
export interface EntityDirectoryPort {
  resolve(ref: string): Promise<EntityResolution>
  get(ref: string): Promise<EntityDescriptor | undefined>
}

/**
 * One post-run chain job as the chip projection needs to see it (Phase 388, D-14).
 *
 * Status and claim drive the chips; optional recorded facts drive the stage detail (423 D-12).
 * The claim remains separate from status, so running does not widen the job vocabulary.
 * Missing facts stay absent, including on older reader implementations.
 */
export interface PostProcessingJobRow extends Readonly<PostProcessingStageDetail> {
  readonly status: JobStatus
  /** Whether a drainer holds this job right now. `false` covers queued and terminal alike. */
  readonly claimed: boolean
}

/**
 * What one run's post-run chain has durably recorded, by member (Phase 388, D-14; narrowed to
 * the two chip stages — Phase 404, D-01, 2026-08-26).
 *
 * Every member is OPTIONAL, and each absence is a real, different situation: no analyze-run row
 * means nothing was ever enqueued for this run; no curate-memory row means the analysis has not
 * chained yet. Padding either of them with a synthetic row would erase exactly the distinction
 * the projection reads.
 */
export interface PostProcessingChainState {
  readonly analyzeRun?: PostProcessingJobRow
  readonly curateMemory?: PostProcessingJobRow
  /** Completed curation facts, available before the chain terminal is written. */
  readonly curationSnapshot?: CurationSnapshot
  /** The chain-terminal record, once the terminal transaction wrote it (D-09). */
  readonly notification?: RunNotification
}

/**
 * Injected read port over the durable post-run chain state (Phase 388, D-14).
 *
 * OPTIONAL on {@link FunctionDeps}, so a host with no queue storage lists `runs.postProcessing`
 * as `unbound` BY NAME rather than answering a confident all-pending about a chain it has no
 * way to see.
 *
 * The port carries the host's `idSource` rather than resolving ids itself, and that placement
 * is the load-bearing part. Chain identity is DERIVED (RESEARCH Pattern 2), and it must be
 * derived through the same source the host's queue enqueued with — a reader that owned its own
 * derivation would address rows under other ids the moment a composition configured a different
 * source, and would report `pending` about a chain that had already finished. So the function
 * layer derives, once, through `chainJobIdsForRun`, and the port only reads what it is handed.
 *
 * Reads are fence-free by design: reading claims no authority, so a status query neither adopts
 * an epoch nor competes with the drainer that holds one.
 */
export interface PostProcessingReaderPort {
  /** The id source THIS host's queue derives job ids with. */
  readonly idSource: JobIdSource
  /**
   * Durable state for the ids given, or `undefined` when this project holds no queue database
   * at all. Chain identity is still the job-kind layer's to derive, and this port only reads
   * what it is handed, and it may not derive an id of its own.
   *
   * `undefined` is a distinct answer from an empty state and both are honest: the first says
   * nothing has ever been enqueued here, the second says this chain's rows are not among the
   * ones that have. An implementation MUST NOT bring a database into existence to answer —
   * a status read that materialized a queue would make asking a question change the answer.
   */
  readChain(ids: ChainJobIds, runId: string): Promise<PostProcessingChainState | undefined>
}

/**
 * Injected read port over ONE run's durable dashboard projection (Phase 405, D-03).
 *
 * `packages/agent` is `storageNeutral`: no host builtin is importable here, so every row arrives
 * through this port, built at the composition root over the concrete dashboard SQLite database.
 * The port answers ROWS — members, steps, sub-actions — and nothing derived; the D-06 token sum is
 * the op's, computed once in the layer that owns the contract rather than once per host that
 * happens to hold a database.
 *
 * ABSENCE IS A RESULT, NEVER A PATH JOIN ON CALLER INPUT (the `RunsReaderPort.get` law, T-384-08).
 * A run id that names nothing answers `undefined`, and turning that into the layer's typed refusal
 * is `runs.detail`'s job — so the "not found" vocabulary lives here in one place rather than in
 * every composition root. An implementation resolves the id against the rows it already
 * enumerates; joining a caller-supplied string onto a filesystem path is the one thing it may
 * never do.
 *
 * OPTIONAL on {@link FunctionDeps} for the reason `postProcessing` is: a host with no dashboard
 * database genuinely cannot say what a run's steps were, and the alternative to reporting that by
 * name is answering an empty projection about a run it has never been able to see — a wrong answer
 * wearing a correct one's clothes.
 */
export interface RunDetailReaderPort {
  /** One run's projected rows, or `undefined` when the runs database holds no such run or does not exist yet. */
  read(runId: RunId): Promise<RunDetailRows | undefined>
  /**
   * 2026-10-18 (444-12, D-14): the run's own row status, or `undefined` when no row is recorded.
   * Optional: a host without it derives no `no-verdict` fact, because absence is not a status.
   */
  readRecord?(runId: RunId): Promise<{ status: string } | undefined>
}

/**
 * Injected read port over ONE run's content-addressed evidence blobs (Phase 405, D-12/D-13).
 *
 * `packages/agent` is `storageNeutral`: no filesystem is importable here, so the bytes arrive
 * through this port, built at the composition root over the SAME `FsEvidenceArtifactStore` the
 * runner wrote them with. The port answers BYTES and nothing derived — the content-type sniff is
 * `runs.artifact`'s, computed once in the layer that owns the contract rather than once per host
 * that happens to hold a runtime root.
 *
 * ABSENCE IS A RESULT, AND IT IS TWO RESULTS (D-15). See {@link EvidenceBlobLookup}: the concrete
 * store collapses "no such run" and "no such blob" into one `undefined`, and an implementation of
 * this port is where that distinction is recovered — because above it the two are different things
 * a page has to render. Turning either arm into a typed refusal is the op's job, so the "not
 * found" vocabulary lives in one place rather than in every composition root.
 *
 * THE PORT NEVER JOINS CALLER INPUT ONTO A PATH (the `RunsReaderPort.get` law, T-384-08 /
 * T-405-14). Containment is the STORE's own rule — `slugBranch` over the runId and a
 * 64-lowercase-hex check over the sha, both inside `FsEvidenceArtifactStore` — and an
 * implementation that assembled a path itself would be a second containment rule, free to be
 * weaker than the one the runner writes through.
 *
 * OPTIONAL on {@link FunctionDeps} for the reason `postProcessing` is, and for a sharper one: the
 * alternative was widening the REQUIRED {@link RunsReaderPort} with a blob verb, which every
 * daemon, MCP and test implementer of that port would then have to satisfy with storage most of
 * them do not have.
 */
export interface EvidenceBlobReaderPort {
  /** One blob's bytes, or which KIND of absence this host is reporting. */
  read(runId: RunId, sha: string): Promise<EvidenceBlobLookup>
  stat?(runId: RunId, sha: string): Promise<
    { status: 'found'; byteLength: number } | { status: 'unknown_run' | 'blob_absent' }
  >
  readRange?(runId: RunId, sha: string, start: number, end: number): Promise<EvidenceBlobLookup>
  /**
   * The same question asked as a STAT — are the bytes still there — for read-time presence
   * annotation on the durable reads (Phase 406, D-17).
   *
   * OPTIONAL SO THAT EVERY EXISTING IMPLEMENTATION AND FAKE KEEPS COMPILING, and for the sharper
   * reason that absence here is a real host condition rather than an oversight: a host that cannot
   * cheaply stat its blobs is not lying about anything, and an op that finds this member missing
   * OMITS presence rather than reporting refs it never looked at as absent. A claimed absence is
   * the one answer this field must never be able to give by accident, because it renders honest
   * evidence as `evidence-incomplete`.
   *
   * IT ANSWERS THE SAME THREE WORDS `read` DOES, so the two cannot disagree about WHICH absence a
   * ref is in — the read is this answer plus the bytes, never a second rule.
   */
  has?(runId: RunId, sha: string): Promise<EvidenceBlobPresence>
}

/**
 * Injected read port over a run's persisted analysis artifact (Phase 389, D-10/D-11).
 *
 * `analysis.json` is the analyze-run job's own receipt; the only legal reader routes its
 * bytes through `guardRunAnalysisArtifact` (the version guard), and an implementation of
 * this port does exactly that at the composition root — the op receives a guarded document
 * or a typed absence, never raw bytes.
 *
 * `undefined` is an ANSWER, not an error: a run whose analysis never ran (budget spent,
 * daemon down, chain still in flight) has no artifact, and the ops answer it through the
 * D-10 accessor's handoff floor. That is why `runs.get` treats an UNBOUND port the same
 * way — artifact-absent — while `analysis.get` refuses by name: a listing that cannot see
 * artifacts still lists truthfully off the floor, but a caller asking for THE analysis of
 * a run must be told this host cannot serve one.
 */
export interface AnalysisArtifactReaderPort {
  /** The guarded artifact for one run, or `undefined` when none is on disk. */
  getArtifact(runId: string): RunAnalysisArtifact | undefined
}

/**
 * Injected read port over the resolved project configuration.
 *
 * The port's name says what its security contract is: it yields a config whose
 * secret-bearing values were dropped while the DTO was CONSTRUCTED. There is deliberately
 * no unmasked variant on this port — a capability that could ask for one would make the
 * masking optional, and optional masking is not masking (T-384-07).
 */
export interface ConfigReaderPort {
  getMasked(): Promise<MaskedResolvedConfig>
}

/**
 * Injected capability that STARTS a run (D-16, Phase 385).
 *
 * Its one verb resolves the identity of the run it started and nothing else. That narrowness
 * is the point: the acknowledgment a caller receives is not assembled from what this port
 * SAYS happened, it is read back off the run's own durable record through
 * {@link RunsReaderPort} — the same port `runs.get` answers from. A host that returned an id
 * without running anything therefore fails at the join rather than at a promise nobody can
 * check.
 *
 * Owning the process model is what makes this a port rather than shared code (the plan-08
 * dissection rule): a terminal host runs a suite one way, a daemon another, and neither
 * would call the other's orchestration as written.
 */
export interface RunInvocationPort {
  /**
   * Start a run for this request and resolve when the run has been recorded.
   *
   * Rejects if the run could not be started or did not complete. An implementation that
   * cannot honour the request must throw, never resolve a run id it did not produce.
   */
  start(request: RunsStartInput): Promise<StartedRun>
}

/** What {@link RunInvocationPort.start} reports: the identity of the run it started. */
export interface StartedRun {
  readonly runId: RunId
}

/**
 * The injected-dependency record every op implementation receives. Ops are pure
 * functions of (validated input, deps) — they never reach for a host API.
 *
 * The four READ ports are required and non-partial on purpose: a composition that omits one
 * fails to typecheck. Phase 387 adds `entities` as the fourth, and it joins as REQUIRED
 * rather than optional deliberately — every host that can list a capability can also resolve
 * an address, so a host that omitted it would not be reporting a real absence, it would be
 * reporting that somebody forgot. That is precisely the state the required/optional split
 * exists to distinguish, and widening the optional side to cover a forgetting would have
 * made `unbound` mean two different things.
 *
 * The OPTIONAL members' optionality is not a relaxation of that discipline but the mechanism
 * behind it. Not every host can start a run — a read-only surface, a registry built for a
 * listing, 386's daemon before it wires its own executor — and D-09 requires that state to be
 * VISIBLE rather than a call that fails somewhere far away. Omitting `runInvocation` makes
 * `runs.start` list as `unbound` and refuse by name; supplying it makes the same capability
 * bound. Any further optional member must join {@link OptionalFunctionDepKey} so the same
 * reporting applies to it.
 *
 * `knowledgeReview` (387, KREV-01) is the second, and it is the one that makes the required/
 * optional split earn its keep on the WRITE side: the ability to read committed knowledge and
 * the ability to change it are separate powers, so they are separate members. A host that
 * supplies only the reader lists the mutating verbs as `unbound` by name — which is a true
 * statement about that host, and is exactly what widening the reader port with a write member
 * would have made unsayable.
 */
/**
 * The live-view seam `runs.liveurl` mints through (403 D-03).
 *
 * OPTIONAL, and its absence is a GENUINE HOST FACT rather than a degraded mode: a CLI run in a
 * terminal serves no origin, so there is no URL it could honestly hand back. A host that binds it
 * supplies the per-process signer, the origin it is actually listening on, and a read of the live
 * run registry — never a token, and never a parse.
 *
 * `capabilityOf` answers `undefined` for a run this host has no live session for (the op turns
 * that into `unknown_run`) and a `LiveStreamDeclaration` — possibly `{ kind: 'none' }` — otherwise.
 * `onMinted` observes every minted token value. 2026-10-14 (441-16, D-01): no shipped host binds it
 * (a minted token is not a declared secret); tests use it to capture what the op really minted.
 *
 * `editorCapabilityOf` is the editor subject's read (428 D-07), through which `editor.liveurl`
 * mints. ABSENT means this host serves no live editor — the standalone MCP host and the MCP App
 * host never bind it, and the op refuses by name. `undefined` means no such live editor session.
 * It is a separate lookup from `capabilityOf` so an editor session can never be addressed as a run.
 */
export interface LiveViewPort {
  signer: LiveUrlSigner
  origin(): string | undefined
  now(): number
  capabilityOf(runId: string, handle: number): LiveStreamDeclaration | undefined
  editorCapabilityOf?(sessionId: string): LiveStreamDeclaration | undefined
  onMinted?(token: string): void
}

export interface FunctionDeps {
  runs: RunsReaderPort
  knowledge: KnowledgeReaderPort
  config: ConfigReaderPort
  entities: EntityDirectoryPort
  runInvocation?: RunInvocationPort
  /**
   * 403 D-03: the live-view mint seam. See {@link LiveViewPort} — absent means this host has no
   * served origin, and `runs.liveurl` refuses by name rather than minting a link to nowhere.
   */
  liveView?: LiveViewPort
  knowledgeReview?: KnowledgeReviewPort
  /**
   * 388 D-14: the durable post-run chain read. The third optional member, and it joins for the
   * reason the other two did rather than by analogy — a host with no queue storage genuinely
   * cannot answer "what became of that run's analysis", and the alternative to reporting that
   * by name is answering `pending` about a chain it has never been able to see, which is a
   * wrong answer wearing a correct one's clothes.
   */
  postProcessing?: PostProcessingReaderPort
  /**
   * 405 D-03: the durable run-detail projection read. See {@link RunDetailReaderPort} — absent
   * means this host owns no dashboard projection database, and `runs.detail` refuses BY NAME
   * rather than answering an empty run about a projection it cannot observe. The CLI host binds it
   * over the configured or default runs database path whenever its config parses (a read before
   * that file exists answers not recorded in the runs database); the dashboard passes its own handle.
   */
  runDetail?: RunDetailReaderPort
  /**
   * 405 D-12/D-13: the run-scoped evidence-blob read. See {@link EvidenceBlobReaderPort} — absent
   * means this host owns no runtime root, and `runs.artifact` refuses BY NAME rather than
   * answering `blob_absent` about every artifact in the product, which would read to an operator
   * as storage loss. Bound on every LOCAL host, which is exactly the set that has run directories.
   */
  evidenceBlobs?: EvidenceBlobReaderPort
  /**
   * 389 D-10/D-11: the analysis-artifact read. `analysis.get` binds through it and refuses
   * by name where it is absent; `runs.get` reads it opportunistically and treats an unbound
   * port as artifact-absent (the floor), because the cheapest read must stay cheap and a
   * listing off the deterministic floor is honest, not degraded. Bound in plan 06's
   * composition root over the run-directory `analysis.json` + version guard.
   */
  analysis?: AnalysisArtifactReaderPort
  /**
   * 389 D-08: the live recurrence seam the one renderer joins through. OPTIONAL because a
   * host without the knowledge index genuinely has no history to answer with — and the
   * renderer's contract turns that absence into the explicit no-history clause rather than
   * a refusal, so `analysis.get` stays bound wherever `analysis` is. Bound in plan 06 to
   * v51's run-outcome projection; 390 rebinds the SAME seam to its fingerprint window.
   */
  recurrence?: RecurrenceProvider
  /**
   * 390 D-12/D-13: the committed quarantine ledger's three verbs — list, release, add.
   *
   * OPTIONAL for the reason `knowledgeReview` is, and not by analogy: a host with no knowledge
   * root genuinely cannot enumerate quarantine state, and the alternative to saying so by name
   * is answering an empty list about a ledger it has never been able to read — a wrong answer
   * wearing a correct one's clothes. On the write side the stakes are higher still: an unbound
   * `add` that no-opped would report a test as quarantined while it kept failing every build.
   *
   * ONE port for all three verbs rather than a reader/writer split, because the read/write
   * asymmetry is already stated on each op's risk descriptor — `quarantine.list` declares a
   * read-only descriptor, `release` and `add` declare `readOnly: false` — so a second port would
   * restate at the composition root a distinction the descriptors already carry. 2026-10-02
   * (432-39, D-12): no op declares a scope and no gate enforces the split at a call; it lives only
   * on the descriptors. The port TYPE is minted in schema, so knowledge-local can implement it
   * without depending on the function layer.
   */
  quarantine?: QuarantineOperationsPort
  /** The mark port; absent, `runs.mark` is unbound by name and `runs.detail` lists no marks. */
  feedback?: FeedbackPort
  /**
   * 423 D-19: read-only feedback observations. Separate from `feedback` so a host can serve
   * history without mark authority; absent means `runs.marks.history` is unbound by name.
   * 423 D-16: the same binding carries `preview`, runs.mark's plan for an exact input with no
   * write; a binding without that verb leaves `runs.mark.preview` unbound by name.
   */
  feedbackReads?: FeedbackReadsPort
  /**
   * 392 D-24: the assembled chat turn engine, behind which `agent.ask` runs.
   *
   * OPTIONAL for the reason its neighbours are, and the honest absence matters more here than
   * anywhere else in this record: a host with no engine — a remote read surface, a daemon before
   * a chat host exists — genuinely cannot run a turn, and the alternative to reporting that by
   * name is answering an EMPTY turn. A person told "I understood you and did nothing" stops
   * asking, which is the same failure the unbound proposals inbox was reasoned about avoiding.
   *
   * The port is a single verb by design. Anything wider — a session lister, a history reader —
   * would be reach the turn entry does not need and would give a surface holding this dep a way
   * into session state without a registered op declaring it.
   */
  chatTurn?: ChatTurnPort
  /**
   * 393 D-01 / D-15: the two host halves one draft evaluation needs — resolve a caller's path to a
   * parsed draft, and assemble the ports the four gates run against.
   *
   * ONE BUNDLED CAPABILITY rather than five separate deps, on the `runInvocation` precedent. The
   * receipts store, the suite fingerprint index, the text corpus and the run pair are not
   * independently bindable: an index scoped to a different product than the runs were taken under
   * would compare a draft against another project's suite, and a host that could supply three of
   * the five would list this op `bound` and then fail somewhere far from the composition that
   * forgot one. Bundling makes "can this host verify a draft" a single fact.
   *
   * OPTIONAL for the reason `runInvocation` is, and here it says two things at once: a host that
   * cannot PARSE a test file and a host that cannot START a run are both hosts that cannot verify
   * a draft, and `composeLocalAgent()` binds this only when it has both.
   *
   * WHY RESOLUTION IS A SEPARATE VERB FROM EVALUATION. `packages/agent` is `storageNeutral`: it
   * cannot stat a path, read a file, or know where the workspace ends. So the three refusals that
   * need a filesystem are ANSWERED by the host and NAMED by the op — `resolveDraft` returns a
   * typed outcome and never throws a host error through the layer, and
   * `functions/ops/authoring-verify-draft.ts` maps each arm onto its own caller-facing class. The
   * alternative — a single `evaluate(draftPath)` — would have put the refusal vocabulary in
   * whichever package happened to own the syscall, one layer below where a caller catches it.
   */
  draftEvaluation?: DraftEvaluationPort
  /**
   * 394 D-01 / WTST-01: the authoring loop's read half — the brief, and the authored suite as
   * text (stages 1-2).
   *
   * OPTIONAL for the reason `draftEvaluation` is, and the honest absence is load-bearing here in
   * a way it is nowhere else in this record. A host with no knowledge index cannot serve an
   * authoring brief, and the alternative to saying so by name is compiling a test from an EMPTY
   * brief — which produces a plausible draft, authored against nothing this project knows, and
   * says so nowhere. That is a wrong answer wearing a correct one's clothes, and it is wearing
   * them into a file the user is asked to commit.
   */
  authoringRead?: AuthoringReadPortLike
  /**
   * 394-26 / WTST-01: which scope this project authors for, when the caller named none.
   *
   * OPTIONAL and consulted ONLY on absence. `authoring.draft.write`'s `scope` is optional at the
   * registry (the `runs.start` law), so an input carrying just an intent has to be resolved
   * before the loop runs — and the resolution reads the config and the workspace, which
   * `packages/agent` cannot do. A composition that binds the loop's other halves and forgets this
   * one refuses BY NAME on a scope-less call rather than authoring against a default: a guessed
   * product is a draft written for the wrong application, which is the one failure mode a silent
   * fallback here would produce.
   */
  authoringScope?: AuthoringScopePortLike
  /**
   * 394 D-01 / WTST-01: the authoring loop's compile half — the model, and the draft shelf
   * (stage 3).
   *
   * Bound with `authoringRead` or not at all: `composeLocalAgent()` supplies the pair, because a
   * host that can read but not write is not a degraded author, it is a host that must say
   * `unbound` by name. `authoring.draft.write` names THIS key in `boundThrough` — it is the half
   * that makes the op mutating — and refuses on either half's absence at the invoke, so an
   * in-layer caller holding the spec directly gets the same named error.
   */
  draftShelf?: DraftShelfPortLike
  /**
   * 394-07 D-12 / WTST-05: the honesty funnel's reads — the receipts store and (optionally within
   * the bundle) the outcome projection and quarantine ledger D-14 consults. 2026-10-01 (432-17): the
   * proposals inbox the `accepted` stage read is deleted; 2026-10-02 (quick 261002-ctr) that stage
   * is `writeEligible`, read off the receipts (see `projectAuthoringFunnel`).
   *
   * OPTIONAL, and the stakes sit on the READ side. A host with no agent-qa runtime root cannot list draft receipts, and the alternative to
   * saying so by name is answering an all-zero funnel — which does not merely under-report, it
   * reports a loop that filtered everything, the one reading of a zero funnel that FLATTERS the
   * loop this measurement exists to keep honest.
   */
  authoringFunnel?: AuthoringFunnelPortLike
  /**
   * 395 D-03/D-17 · CFGM-01/04: the pinned config file SET as RAW BYTES, plus the comment-preserving
   * field edit over them.
   *
   * DELIBERATELY NOT A WIDENING OF {@link ConfigReaderPort}, which is masked-only by contract and
   * must stay so — a capability that could ask it for unmasked values would make masking optional,
   * and optional masking is not masking. This port answers a different question: what bytes are
   * COMMITTED in the person's repository. Those carry no resolved secrets, because D-11 makes
   * committed config refs-only by law.
   *
   * The EDIT rides the same port as the read because both are host facts. `yaml`'s Document API is
   * an external dependency `packages/agent`'s ownership contract does not admit, and admitting one
   * to bring the edit in-layer would widen a boundary rather than respect it.
   */
  configFiles?: ConfigFilesPortLike
  /**
   * 395 CFGM-01: whole-config validation, which runs BEFORE a change is written.
   *
   * A PORT because `AgentQaConfigSchema` and `validateProject` live in `@vostride/agent-qa-core`
   * and this package does not depend on it — `validate:arch` reds that edge with no legal repair.
   * The capability is declared here and bound in `cli`.
   */
  configValidate?: ConfigValidatePortLike
  /**
   * 395-08 D-04 · CFGM-05: the shared scaffold CONTENT, rendered by the host that owns it.
   *
   * THE ONE DEP `config.project.scaffold` HAS AND THE OTHER FIVE CHANGE OPS DO NOT. D-04's claim
   * is that `agent-qa init` and the scaffold change write one substance; that substance lives
   * beside `init`'s filesystem machinery in `packages/cli`, which this package may not import. Its
   * absence makes exactly one op unavailable, and it says so by name.
   */
  scaffoldContent?: ConfigScaffoldContentPortLike
  /**
   * 2026-09-30, 432-07 D-05/D-07: the direct config writer. Field changes merge in the config
   * path's shared write turn and whole files publish over the digest they were built from. No
   * proposal is filed and no git process runs.
   */
  configWrite?: ConfigWritePortLike
  /**
   * 2026-08-17 (398 D-09/D-11 · XPLN-02): the four host halves one `explain` needs — the committed
   * catalog as data, the model's citation over it, and the two coverage hooks.
   *
   * ONE PORT AND NOT FOUR DEPS, on the `draftEvaluation` bundle's stated reasoning: a host that
   * could load the catalog but not cite over it would list `agent.explain` as `bound` and then
   * answer every question with a ghost citation, which abstains — safe, and useless, and reported
   * nowhere. "Can this host explain itself" is one fact.
   *
   * OPTIONAL for the reason `analysis` is, and the honest absence is unusually load-bearing here.
   * `packages/agent` is storageNeutral: it cannot read the committed artifact, so a composition
   * that omitted the port and got a degraded answer would be answering FROM MODEL MEMORY, which is
   * the single behaviour XPLN-02 exists to make impossible. The op refuses BY NAME instead.
   */
  capabilityCatalog?: CapabilityCatalogPort
  /** 441 D-06: the host's declared-secret mask for projected run text; absent or throwing, run reads fail closed. */
  readonly secretMask?: MaskFn
}

/**
 * What a host can tell the layer about a caller-supplied draft path (393, T-393-01).
 *
 * A discriminated union rather than `ParsedDraftLike | undefined`: "there is no file there", "that
 * is a directory", "that is outside this workspace" and "that file is not a test" are four
 * different things to tell a person, and collapsing them into an absence would make the op answer
 * all four with one message. Every arm but `parsed` becomes a NAMED error at the invoke.
 */
export type DraftResolution =
  | { readonly kind: 'parsed'; readonly draft: ParsedDraftLike }
  | { readonly kind: 'not-found' }
  | { readonly kind: 'not-a-file' }
  | { readonly kind: 'outside-workspace' }
  | { readonly kind: 'unparsable'; readonly reason: string }

/**
 * The capability `authoring.draft.verify` binds through (393 D-01).
 *
 * `openEvaluation` takes the resolved draft because two of the four ports depend on WHICH draft is
 * being evaluated: the suite comparison must exclude the draft's own identity from both of gate
 * 3's lanes, or a draft that already lives in the authored suite would be measured against itself
 * and could never be shown to add value. It is a separate call from `resolveDraft` so a refused
 * path costs no database handle and no suite walk.
 */
export interface DraftEvaluationPort {
  resolveDraft(draftPath: string): Promise<DraftResolution>
  openEvaluation(draft: ParsedDraftLike): Promise<EvaluateDraftPorts>
}

/**
 * The one verb `agent.ask` binds through (392 D-24).
 *
 * Typed against the SCHEMA contracts rather than against the engine's own types, which is what
 * lets the composition root hand this layer an engine without the function layer depending on how
 * a turn is assembled — and what lets 396's MCP projection describe the same shape.
 */
export interface ChatTurnPort {
  runTurn(input: AgentAskInput): Promise<AgentAskResult>
}
