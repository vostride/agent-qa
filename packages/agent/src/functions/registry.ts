// The function registry.
//
// The registry OWNS the specs and hands out declaration views only. Its internals —
// the spec map and the injected deps — live in a module-private
// WeakMap that only `invokeFunction` reads. A surface holding a `FunctionRegistry`
// therefore has exactly one way to run a capability: `invokeFunction`'s validated dispatch.
// Since 432-13 that path asks nobody (no gate, confirm port, grant reader or deny overlay).

import type { FunctionCaller } from '@vostride/agent-qa-schema'

import { toOutputProjection, toSchemaProjection } from './declaration-projection.js'
import type { FunctionBindingStatus } from './spec.js'
import { agentAskSpec } from './ops/agent-ask.js'
import { analysisGetSpec } from './ops/analysis-get.js'
import { authoringDraftEditSpec } from './ops/authoring-draft-edit.js'
import { authoringDraftWriteSpec } from './ops/authoring-draft-write.js'
import { authoringFunnelGetSpec } from './ops/authoring-funnel-get.js'
import { authoringVerifyDraftSpec } from './ops/authoring-verify-draft.js'
import { configAuthSetSpec } from './ops/config-auth-set.js'
import { configFieldSetSpec } from './ops/config-field-set.js'
import { configHookAddSpec } from './ops/config-hook-add.js'
import { configGetSpec } from './ops/config-get.js'
import { configTargetCreateSpec } from './ops/config-target-create.js'
import { configProjectScaffoldSpec } from './ops/config-project-scaffold.js'
import { configTargetEditSpec } from './ops/config-target-edit.js'
import { entitiesGetSpec } from './ops/entities-get.js'
import { explainSpec } from './ops/explain.js'
import { entitiesResolveSpec } from './ops/entities-resolve.js'
import { knowledgeAcceptSpec } from './ops/knowledge-accept-propose.js'
import { knowledgeBriefWhySpec } from './ops/knowledge-brief-why.js'
import { knowledgeBundlesListSpec } from './ops/knowledge-bundles-list.js'
import { knowledgeGatesListSpec } from './ops/knowledge-gates-list.js'
import { knowledgeForgetSpec } from './ops/knowledge-forget-propose.js'
import { knowledgeRecordShowSpec } from './ops/knowledge-record-show.js'
import { knowledgeRecordsDiffSpec } from './ops/knowledge-records-diff.js'
import { knowledgeRecordsInspectSpec } from './ops/knowledge-records-inspect.js'
import { knowledgeRejectSpec } from './ops/knowledge-reject-propose.js'
import { quarantineAddSpec } from './ops/quarantine-add.js'
import { quarantineListSpec } from './ops/quarantine-list.js'
import { quarantineReleaseSpec } from './ops/quarantine-release.js'
import { runsEventsSpec } from './ops/runs-events.js'
import { runsLiveUrlSpec } from './ops/runs-live-url.js'
import { editorLiveUrlSpec } from './ops/editor-live-url.js'
import { runsDigestSpec } from './ops/runs-digest.js'
import { runsArtifactSpec } from './ops/runs-artifact.js'
import { runsDetailSpec } from './ops/runs-detail.js'
import { RUNS_EVIDENCE_FUNCTION_ID, runsEvidenceSpec } from './ops/runs-evidence.js'
import { runsGetSpec } from './ops/runs-get.js'
import { runsKnowledgeSpec } from './ops/runs-knowledge.js'
import { runsListSpec } from './ops/runs-list.js'
import { runsMarkSpec } from './ops/runs-mark.js'
import { runsMarkPreviewSpec } from './ops/runs-mark-preview.js'
import { runsMarksHistorySpec } from './ops/runs-marks-history.js'
import { runsOverviewSpec } from './ops/runs-overview.js'
import { runsPostProcessingSpec } from './ops/runs-post-processing.js'
import { runsStartSpec } from './ops/runs-start.js'
import type { FunctionDeclaration, FunctionDeps, FunctionSpec } from './spec.js'

/** Thrown at construction when two declarations claim the same id — never last-wins. */
export class DuplicateFunctionIdError extends Error {
  constructor(readonly functionId: string) {
    super(`Duplicate function id: ${functionId}`)
    this.name = 'DuplicateFunctionIdError'
  }
}

/**
 * Thrown at construction when a spec's output companion is tied to a schema other than the one
 * `invokeFunction` enforces with: the declaration would describe one contract while
 * the gate validated another.
 */
export class OutputRepresentationMismatchError extends Error {
  constructor(readonly functionId: string) {
    super(
      `${functionId} declares an outputRepresentation whose runtimeSchema is not its output schema; `
        + 'the companion must describe the exact object invokeFunction validates with',
    )
    this.name = 'OutputRepresentationMismatchError'
  }
}

/** The capabilities every composition of this layer registers. */
const BUILT_IN_FUNCTION_SPECS: readonly FunctionSpec[] = [
  runsListSpec as FunctionSpec,
  runsGetSpec as FunctionSpec,
  runsEventsSpec as FunctionSpec,
  // the ONE producer of live-view capability tokens. Bound through the OPTIONAL
  // `liveView` dep, so a host with no served origin lists it `unbound` BY NAME rather than
  // handing back a URL that resolves to nothing.
  runsLiveUrlSpec as FunctionSpec,
  // the editor subject's minter, through the same `liveView` dep; a host
  // that serves no live editor refuses it by name. Unprojected from MCP by ruling.
  editorLiveUrlSpec as FunctionSpec,
  // Bound exactly in the compositions that supply a `runInvocation` port; listed
  // either way, so a host that cannot start a run reports a visible `unbound` rather than a
  // hole in the catalog, and `invokeFunction` refuses it by name. `composeLocalAgent()` in
  // `@vostride/agent-qa-agent-local` is the binding site.
  runsStartSpec as FunctionSpec,
  // THE chip-truth read. Registered here rather than beside a surface because it is
  // the single producer three surfaces share — the CLI's exit summary line, 392's chat and M5's
  // dashboard are all thin clients of this one op, and the 397 parity suite inherits it by
  // being in the catalogue. Bound through the OPTIONAL `postProcessing` dep, so a host with no
  // durable queue lists it `unbound` BY NAME instead of answering all-pending about a chain it
  // cannot see.
  runsPostProcessingSpec as FunctionSpec,
  // THE durable run-detail read — members, steps, sub-actions and the D-06
  // token sum in ONE result. Registered here rather than beside the dashboard because it is the
  // fourth-door law applied to the page that used to read SQLite from inside a route handler: the
  // browser, the CLI, MCP and chat now ask one registry the same question. Bound through the
  // OPTIONAL `runDetail` dep, so a host that owns no dashboard projection database lists it
  // `unbound` BY NAME instead of answering an empty run about a projection it cannot see.
  runsDetailSpec as FunctionSpec,
  // parsed evidence uses the existing detail and blob readers together.
  runsEvidenceSpec as FunctionSpec,
  // the sovereign mark write binds only where the host supplies feedback.
  runsMarkSpec as FunctionSpec,
  // the mark history read binds through feedbackReads, never through the writer above.
  runsMarksHistorySpec as FunctionSpec,
  // the consequence preview reads runs.mark's shared plan through feedbackReads, never the writer.
  runsMarkPreviewSpec as FunctionSpec,
  // THE ref-resolving read — one run's content-addressed evidence
  // blob, by sha, with the content type sniffed from the bytes themselves. Registered beside
  // `runs.detail` because the two are the halves of one claim: the projection carries an
  // `artifactRef`, and this is how that ref becomes an image on a page. It is here rather than in
  // a route for `runs.detail`'s reason — a route constructing the evidence store would be a
  // private store read no roster row covers, and 408's embed and MCP would each need their own.
  // Bound through the OPTIONAL `evidenceBlobs` dep, so a host with no runtime root lists it
  // `unbound` BY NAME instead of reporting every artifact in the product as absent.
  runsArtifactSpec as FunctionSpec,
  // THE analysis read — resolved verdicts, rendered sentences, clusters, one
  // producer for the CLI print, the run page and chat. Bound through the OPTIONAL `analysis`
  // dep (the artifact reader), so a host that cannot see run directories lists it `unbound`
  // BY NAME; the optional `recurrence` dep only enriches the sentence's recurrence clause
  // and never gates the binding.
  analysisGetSpec as FunctionSpec,
  knowledgeBundlesListSpec as FunctionSpec,
  // gate-and-promotion history, through the required knowledge port's
  // optional member; missing bindings answer with a named refusal.
  knowledgeGatesListSpec as FunctionSpec,
  // the read half of the review-verb family. All three bind through the REQUIRED
  // `knowledge` port, so — unlike the mutating half 387-08 registers through the optional
  // `knowledgeReview` dep — there is no composition that lists these and cannot run them.
  knowledgeRecordsInspectSpec as FunctionSpec,
  knowledgeRecordsDiffSpec as FunctionSpec,
  knowledgeRecordShowSpec as FunctionSpec,
  // the honest verb. Read-tier like its four siblings, and bound everywhere for the
  // same reason — its substrate is the RUNS port, which is required.
  knowledgeBriefWhySpec as FunctionSpec,
  // the Knowledge panel's ONE read — what a run USED (served brief
  // channels, serve-time trace arms, procedure replay/hint, the recorded retrieval rung) and what
  // it LEARNED (curation counts, the record changes attributable to it, canary outcomes). Placed
  // directly after `knowledge.brief.why` because it is that verb widened from one step to a whole
  // run, and BOUND EVERYWHERE for the identical reason: its substrate is the RUNS port, which is
  // required. The three optional deps it consults only enrich the Learned half, so binding
  // through any of them would leave a host with no queue database unable to see what its own runs
  // used. A pruned handoff answers `evidence-incomplete` — a result the page renders, never a
  // refusal it has to catch.
  runsKnowledgeSpec as FunctionSpec,
  // one completed run's address map, composed from the handoff, the run-detail rows and
  // the runs.knowledge projection. Bound through `runDetail`, so a host with no projection lists
  // it `unbound` BY NAME instead of mapping a run it cannot see.
  runsOverviewSpec as FunctionSpec,
  // the MUTATING half. Registered here and bound only where a composition
  // supplies `knowledgeReview`, so a read-only host lists all three as `unbound` BY NAME rather
  // than omitting them: a capability that is absent from a catalogue is indistinguishable from one
  // that never existed, and D-09 requires the two to look different.
  // the three changes apply in the call; the `.propose` ids are gone
  // with no alias. 2026-10-01, 432-17: `knowledge.proposal.apply` is deleted with the
  // inbox; old proposal files are never read again.
  knowledgeAcceptSpec as FunctionSpec,
  knowledgeRejectSpec as FunctionSpec,
  knowledgeForgetSpec as FunctionSpec,
  configGetSpec as FunctionSpec,
  // the config editor's first action. Registered as a SIBLING of
  // `config.get` rather than in a family of its own, because it is the write half of a story whose
  // read half already ships here — and registering it is what makes it chat-reachable,
  // projectable over MCP (396) and walkable by the parity suite (397) with no harness change.
  //
  // the config ops write in the call through the direct writer.
  // `config.proposal.apply` and `config.undo.propose` are deleted
  // with the inbox; a written change is reverted with git.
  //
  // They bind through OPTIONAL deps, so a host with no config files lists them `unbound` BY NAME
  // rather than answering about a project it cannot read.
  configFieldSetSpec as FunctionSpec,
  // the rest of the closed action class, registered as SIBLINGS on exactly the footing
  // above. One op per action is what makes the class legible in the registry itself — the planner
  // picks an action by tool name, 396 projects each one as its own MCP tool, and 397's parity walk
  // enumerates them — where a single union op carrying a mode string would have projected as one
  // tool whose real vocabulary lives inside a field nothing validates.
  configAuthSetSpec as FunctionSpec,
  configHookAddSpec as FunctionSpec,
  configTargetCreateSpec as FunctionSpec,
  configTargetEditSpec as FunctionSpec,
  // the sixth config op, and the only one that configures a project
  // that has no configuration. Registered rather than folded into `config.target.create` because
  // the two refuse each other's case by name — a create is never an upsert, and a scaffold is
  // never an overwrite — and because the planner picks actions by tool name.
  configProjectScaffoldSpec as FunctionSpec,
  // a new `quarantine.` domain — a taxonomy extension exactly as `entities.`
  // was, because quarantine state is neither a run, a memory nor an analysis. All three bind
  // through the OPTIONAL `quarantine` dep, so a host with no knowledge root lists them
  // `unbound` BY NAME rather than answering an empty list about a ledger it cannot read.
  // `list` is read-tier; `release` and `add` are DIRECT gated writes (no propose+apply pair —
  // that idiom is for learned-knowledge mutations, and this is operational state).
  quarantineListSpec as FunctionSpec,
  quarantineReleaseSpec as FunctionSpec,
  quarantineAddSpec as FunctionSpec,
  // 391 PROP-03 / D-15 added a `proposals.` domain (list, show, reject, accept). 2026-10-01, 432-17
  // the domain is deleted with the inbox, with no alias and no hidden follow-up; old
  // proposal files are never read again.
  // 391 PROP-01 / D-03 added a `grants.` domain (list, revoke) over the committed standing-grant
  // ledger. 2026-10-01, 432-18: the domain is deleted with the ledger; an old
  // `grants.jsonl` is never read again.
  // the per-run digest. Filed under `runs.` beside `runs.postprocessing`
  // because what it answers is a fact about a RUN. Read-tier, and it registers NO new dep: the
  // projection composes from capabilities this catalogue already had (since 432-09 its substrate
  // is the required runs port, and since 432-17 there is no proposals inbox to read).
  runsDigestSpec as FunctionSpec,
  // a new `entities.` domain, a taxonomy extension exactly as `knowledge.` was.
  // Both read-tier, both bound in every composition — the directory is a REQUIRED dep, so
  // there is no host that lists these and cannot run them.
  entitiesResolveSpec as FunctionSpec,
  entitiesGetSpec as FunctionSpec,
  // a new `agent.` domain, and the taxonomy extension that matters most — the chat turn
  // entry is itself a catalogued, gated capability rather than a power the REPL holds privately
  // (§3's L10 law). It binds through the OPTIONAL `chatTurn` dep, so a host with no engine lists
  // it `unbound` BY NAME rather than answering an empty turn about a request it understood.
  //
  // `agent.chat`, the session-stateful sibling the milestone also names, is deliberately absent
  // until a consumer exists: a registered entry nothing drives would still oblige 397's parity
  // suite to stub it on every surface.
  agentAskSpec as FunctionSpec,
  // the SECOND member of the `agent.` domain, and the first op
  // this project has added since the 397 conformance suite closed. Registering it is the decision
  // rather than a filing choice: "what can you do" is a question every surface wants to answer, and
  // a surface that answered it privately would be a capability the catalogue does not list — the
  // private-power pattern §3's L10 law abolishes and the census exists to make impossible. As a
  // registered op it is chat-reachable through the 1:1 planner binding and `/fn` with no harness
  // change, adjudicated in `mapping.ts` like every op, and walked by the parity suite for free.
  //
  // Bound through the OPTIONAL `capabilityCatalog` port, whose binding site is `composeLocalAgent()`
  // (385 D-15 — therefore both the CLI and the daemon). A host with no catalog lists it `unbound` BY
  // NAME rather than answering from model memory, which is the exact failure XPLN-02 exists to
  // forbid: an explain that quietly lost its grounding data still SOUNDS like an explain.
  explainSpec as FunctionSpec,
  // a new `authoring.` domain, and the keep-filter's entry point. The four
  // gates that decide whether a generated test is worth keeping are a CATALOGUED capability rather
  // than a private power of whatever writes tests — so 393's corpus proof drives the real gated
  // entry point (the produced-not-literal law), 396's MCP projection and 397's parity suite inherit
  // it from this census with no harness change, and the standalone question ("is this existing test
  // worth keeping?") is answerable from every surface.
  //
  // Bound through the OPTIONAL `draftEvaluation` bundle, whose binding site is `composeLocalAgent()`
  // in `@vostride/agent-qa-agent-local` (385 D-15 — one composition root, therefore both the CLI and
  // the daemon). The bundle is supplied only where the host can BOTH parse a test file and start a
  // run, so a host missing either half lists this capability `unbound` BY NAME rather than leaving a
  // hole in the catalogue — and rather than returning a receipt whose four booleans were computed
  // from no runs at all, which is the one answer that could get a draft kept on the strength of
  // nothing.
  //
  // Registering it does NOT flip 392's `write_test` fail-closed scenario: that tool name stays
  // absent from the catalogue until 394, and nothing here mints it.
  authoringVerifyDraftSpec as FunctionSpec,
  // the authoring LOOP's one public entry, beside the evaluator
  // it composes. All six stages — brief, dedup, compile, verify, route, compound — run INSIDE this
  // op, because the stage order is an invariant and registering a stage each would make it a hope
  // about the plan the chat planner happened to make rather than a property of the code. Everything
  // under the surface still crosses the function layer: stage 4 dispatches `authoring.draft.verify`
  // through `invokeFunction` on a caller minted with exactly that op's declared scopes.
  //
  // Bound through the OPTIONAL `draftShelf` bundle — the model and the shelf — whose binding site
  // is `composeLocalAgent()` in `@vostride/agent-qa-agent-local` (385 D-15, therefore both the CLI
  // and the daemon). The read half (`authoringRead`) is supplied with it or not at all and the
  // invoke refuses on either by the same name, so a host that cannot serve an authoring brief says
  // `unbound` BY NAME rather than compiling a test against an empty one — a plausible draft
  // authored against nothing this project knows, which is the failure that looks most like success.
  //
  // Inverting the entry above: registering THIS one DOES flip 392's `write_test` fail-closed chat
  // scenarios, because the tool name they were waiting on now exists in the catalogue the planner
  // binds 1:1. Plan 11 performs the flip and pins planned == executed.
  authoringDraftWriteSpec as FunctionSpec,
  // the honesty funnel's ONE read, beside the loop it
  // measures. It is registered rather than left a private computation for the same reason the two
  // entries above it are: the number that says whether the keep-filter is filtering must be the
  // SAME number in chat, in the CLI and in the per-run digest, and a projection reachable only
  // from whichever surface owned it would become three answers the moment the second surface
  // wanted one. Read-tier and `readOnly` — it starts nothing and writes nothing, which is D-14
  // expressed as a risk descriptor rather than as a promise.
  //
  // Bound through the OPTIONAL `authoringFunnel` bundle, whose binding site is
  // `composeLocalAgent()` in `@vostride/agent-qa-agent-local` (385 D-15 — therefore both the CLI
  // and the daemon). A host with no runtime root lists it `unbound` BY NAME rather than answering
  // an all-zero funnel: zero built with zero write-eligible does not read as "nothing happened", it
  // reads as a loop that filtered everything, which is the one wrong answer that would make the
  // acceptance-failure flag unable to fire on the very hosts that most need it.
  authoringFunnelGetSpec as FunctionSpec,
  // the user-facing edit, and the patch contract's SECOND real
  // consumer. Until this op existed, `applyPatchSetToTestDoc` and the RFC-6902 vocabulary had one
  // caller — the repair loop — and a contract with one consumer is a contract shaped like its one
  // caller. That is not a style objection: this project has twice paid for a one-sided contract
  // that looked correct because only one side ever exercised it (the two-sided contract law).
  //
  // It is NOT a stage of `authoring.draft.write`, which is the argument `loop-ordering.test.ts`
  // requires beside a new `authoring.` id. That pin forbids promoting a loop stage to its own
  // registered op, because a planner holding one could reorder or skip the rest. This verb takes an
  // existing COMMITTED test and a change to make to it; it has no position in the six-stage order,
  // and invoking it before, during or after a loop invocation answers the same question.
  //
  // Unlike the write op, it takes one model call, starts zero runs, and writes only to the
  // gitignored draft shelf. The consent that matters for an edit is
  // the inbox accept that turns the proposal into a commit, which 391 already owns.
  //
  // Bound through the OPTIONAL `draftShelf` bundle; `draftEvaluation` is checked by the same name
  // inside the invoke, because resolving the target's bytes and applying the patch set are two
  // halves of one capability and a host that had only one of them would list this op `bound` and
  // then fail far from whichever half was missing.
  authoringDraftEditSpec as FunctionSpec,
]

export interface CreateFunctionRegistryOptions {
  /** Host-backed implementations the ops read through; built at the composition root. */
  deps: FunctionDeps
  // no `resolveExecutionContext` member. No op gate has decided in an
  // execution context since 432-13, nothing here read the option, and the fixtures that passed it
  // stopped by 432-39. A host's live context still reaches a run's record and the knowledge review
  // through their own inputs, never through the registry.
}

export interface FunctionRegistry {
  /**
   * Declaration views of every registered op, sorted lexicographically by id.
   *
   * the same list for every caller. The safe-mode filter that hid ops
   * whose scopes exceeded `read` is deleted with the scopes themselves, so the caller argument is
   * not read. 2026-10-02: the caller contract is narrowed to `surface`/`origin`.
   *
   * KEPT, DATED 2026-10-02 (432-42 census decision): the argument stays and stays unread. Removing
   * it changes no behaviour and touches every listing call site in the workspace (well over a
   * hundred, most of them other plans' fixtures), so the churn buys nothing a reader can observe.
   * It is not a permission seam: C432-TOKENLESS-CATALOG and C432-ALL-OPS-AVAILABLE pin that every
   * caller lists the same set, so a filter returning here reds by name.
   */
  list(caller: FunctionCaller): readonly FunctionDeclaration[]
}

interface RegistryInternals {
  specs: ReadonlyMap<string, FunctionSpec>
  deps: FunctionDeps
}

const REGISTRY_INTERNALS = new WeakMap<FunctionRegistry, RegistryInternals>()

/**
 * INTERNAL seam for `invokeFunction`. Returns `undefined` for any object that did not
 * come out of `createFunctionRegistry` — such an object registers no specs at all, so
 * every id looks unknown to it.
 */
export function registryInternals(registry: FunctionRegistry): RegistryInternals | undefined {
  return REGISTRY_INTERNALS.get(registry)
}

/**
 * Freeze the parts of a spec enforcement reads.
 *
 * The specs are module-level singletons, so a write reached through ONE listing used to
 * change what every registry in the process enforced. Freezing is idempotent and happens
 * at registration, which closes the escalation by whatever route a caller reaches the spec.
 *
 * The live `input`/`output` zod objects are deliberately NOT frozen: freezing a schema's
 * internals would break zod's own lazy caching. That is safe now for a structural reason
 * rather than a hopeful one — a declaration carries an inert projection, so no surface is
 * ever handed the schema object in the first place. The earlier rationale here,
 * that freezing the spec made those properties unwritable, was a category error: it sealed
 * the property SLOT while the object it pointed at stayed wide open.
 *
 * registration FREEZES the spec objects it is given, permanently and in place. Pass
 * a fresh object if the caller needs a mutable one afterwards.
 */
function freezeSpec(spec: FunctionSpec): FunctionSpec {
  Object.freeze(spec.risk)
  return Object.freeze(spec)
}

/**
 * Whether THIS composition can run the op — the one place the answer is decided.
 *
 * A spec with no `boundThrough` needs only the required deps, which the type system already
 * guarantees, so it is bound wherever it is registered. A spec that names an optional dep is
 * bound iff this composition supplied one. Nothing is read off a static field, because there
 * is none to read: the alternative — a literal on the spec — is a claim a module-level
 * singleton makes about every composition in the process, and it would report `bound` from
 * the first host that omitted the implementation.
 *
 * Exported for `invokeFunction`, which refuses on the SAME answer a listing renders. Two
 * computations of "is it bound" would be two chances to disagree, and the disagreement a
 * caller would see is a capability that lists bound and refuses.
 */
export function resolveBindingStatus(
  spec: FunctionSpec,
  deps: FunctionDeps,
): FunctionBindingStatus {
  // Both readers are required even for addresses whose recorded evidence is absent.
  // Keep listing and invocation on this same answer without hiding runs.detail itself.
  if (spec.id === RUNS_EVIDENCE_FUNCTION_ID) {
    return deps.runDetail === undefined || deps.evidenceBlobs === undefined ? 'unbound' : 'bound'
  }
  if (spec.boundThrough === undefined) return 'bound'
  return deps[spec.boundThrough] === undefined ? 'unbound' : 'bound'
}

/**
 * Project one spec into the capability-free view a surface receives.
 *
 * Constructed field by field rather than spread-minus-invoke, so a future spec field can
 * never leak the implementation into a listing by accident.
 *
 * COPY or PROJECT, then freeze — the view aliases nothing on the spec. The scalars are
 * copied, the two contracts become inert JSON-Schema projections, and the whole graph is
 * frozen. What a caller holds after this is data: there is no live validator on it to
 * replace, so a permitted listing is no longer a write handle onto the contract vocabulary
 * every firewalled surface shares.
 */
function declarationView(spec: FunctionSpec, deps: FunctionDeps): FunctionDeclaration {
  return Object.freeze({
    id: spec.id,
    summary: spec.summary,
    // no `requiredScopes` and no `requiresHumanOrigin`. Both were
    // projected here so a listing and the dispatch checks read one field; the checks are deleted,
    // and 432-39 deleted both members from the metadata type. The view is built field by field, so
    // an old key smuggled onto a spec object still cannot ride through by accident.
    // no `discloses` column; the per-op disclosure is deleted.
    // the two 399.1 folds, projected as conditional spreads so absent stays
    // absent — the callables stay on the spec, and what crosses to a listing is the
    // boolean fact that this op folds its own result. The golden ledger reads both columns off
    // here, so "which ops classify their own refusals" is a census over produced facts rather than
    // over somebody's reading of forty-three op files.
    ...(spec.classify === undefined ? {} : { classifies: true as const }),
    ...(spec.renderResult === undefined ? {} : { rendersResult: true as const }),
    resultKind: spec.resultKind,
    bindingStatus: resolveBindingStatus(spec, deps),
    input: toSchemaProjection(spec.input),
    output: toOutputProjection(spec.output, spec.outputRepresentation),
    risk: Object.freeze({ ...spec.risk }),
  })
}

/**
 * INTERNAL: registry construction over an explicit spec set. Exported for tests and
 * future in-layer compositions, and deliberately absent from the package barrel — a
 * surface that could supply its own specs could mint capabilities the catalog never
 * declared.
 *
 * every spec handed here is FROZEN in place, permanently. Pass a fresh object if
 * the caller needs a mutable one afterwards.
 */
export function createRegistryFromSpecs(
  specs: readonly FunctionSpec[],
  options: CreateFunctionRegistryOptions,
): FunctionRegistry {
  const byId = new Map<string, FunctionSpec>()
  for (const spec of specs) {
    if (byId.has(spec.id)) {
      throw new DuplicateFunctionIdError(spec.id)
    }
    if (
      spec.outputRepresentation !== undefined
      && spec.outputRepresentation.runtimeSchema !== spec.output
    ) {
      throw new OutputRepresentationMismatchError(spec.id)
    }
    byId.set(spec.id, freezeSpec(spec))
  }

  const sorted = [...byId.values()].sort((left, right) => (
    left.id < right.id ? -1 : left.id > right.id ? 1 : 0
  ))

  const registry: FunctionRegistry = {
    list() {
      return sorted.map((spec) => declarationView(spec, options.deps))
    },
  }

  REGISTRY_INTERNALS.set(registry, {
    specs: byId,
    deps: options.deps,
  })

  return registry
}

/** Build the registry of built-in capabilities over composition-supplied dependencies. */
export function createFunctionRegistry(
  options: CreateFunctionRegistryOptions,
): FunctionRegistry {
  return createRegistryFromSpecs(BUILT_IN_FUNCTION_SPECS, options)
}
