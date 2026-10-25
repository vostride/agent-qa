import type { OwnershipContract } from '@vostride/agent-qa-arch'

export const AGENT_QA_EVAL_LOCAL_PACKAGE_NAME = '@vostride/agent-qa-eval-local'
export const AGENT_QA_EVAL_LOCAL_PACKAGE_DIR = 'packages/eval-local'
export const AGENT_QA_EVAL_LOCAL_PACKAGE_CLASSES = ['storageImplementation'] as const
export const AGENT_QA_EVAL_LOCAL_ALLOWED_RESPONSIBILITIES = [
  'operator-only label calibration publication, complete target authorization and guarded label evidence reads',
  'all eval filesystem IO behind the neutral handoff and artifact read ports',
  'handoff and artifact reads composed over runner-local stores',
  'cassette bundle writes under the runtime workdir staging root',
  // Phase 368 D-04/D-05/D-06: the ONE sanctioned replay-composition helper (runCassetteReplay)
  // binding createModel egress + a temp-0 LLMPlanner (368-01 nonActionTools seam) with the
  // caller's declared mask on every request + optional replay-record persistence. This
  // deliberately makes eval-local the SECOND package (after cli) importing both model and runner;
  // Phase 372's CLI wraps exactly this helper. 441-32 (D-15): no safety scope or audit sink.
  'the single sanctioned replay-composition helper wiring createModel + LLMPlanner',
  // Phase 369 D-13: per-cassette score persistence — score.json written BESIDE its replay.json in
  // the same slugged cassette dir, FILE-scoped overwrite (never a dir recreate: Pitfall 5) so the
  // composition's record-then-score ordering keeps both files alive across re-runs (OQ-2).
  // Serialization only: every score and diff arrives computed from eval core (F9) — the
  // forbidden-scoring clause below stays true.
  'per-cassette score and diff persistence beside replay records',
  // Phase 369 D-13/D-14: batch-report persistence — the aggregated EvalBatchReport as its own
  // artifact under eval/reports/, keyed by the deterministic replay-batch key. Uncommitted runtime
  // staging beside eval/replays; committed placement is Phase 371/372's concern.
  'aggregated eval batch-report persistence under the runtime staging root',
  // Phase 370 D-05/D-06: the tier-4 judge leg — bindJudgePort routes every judge call through
  // createModel (the pinned-last mask/guardrail middleware stack, JUDGE-03) at temperature 0,
  // maxRetries 0, one structured Output.object verdict per order-tagged request, parsed against
  // a closed zod schema with typed call-error degradation (the port never throws, D-11). Prompt
  // content arrives fully built from eval core (D-15) — the binding transports, never assembles.
  // bindJudgePanel composes N existing bindJudgePort handles at this same factory site.
  // Only replay, Gate 1 and operator calibration invoke them; this exception does not authorize
  // another factory or general provider invocation.
  'the tier-4 judge-port binding through createModel, including bindJudgePanel as N existing bindings during replay, Gate 1 and operator calibration',
  // Phase 371 ROOT-01/D-15/D-17: the write-once committed eval-root store under agent-qa-eval/ —
  // scaffolded gitignore covering every blobs/ dir, schemaVersion root marker, per-segment slugged
  // paths, byte-compare idempotence, typed write-conflict refusal.
  'the write-once committed eval-root store scaffolding and refusing under agent-qa-eval/',
  // Phase 371 D-14/D-16 (ROOT-02): the ONE sanctioned corpus-seeding composition helper
  // (seedCommittedCorpus) executing eval-core SeedingPlans — every committed text written as
  // authored (441 D-15), per-case atomic refusal on write-conflict, batch never aborts; blob
  // bytes land only under ignore-covered blobs/ paths (D-15). Selection and labeling stay in
  // eval core — this helper executes, never decides. 372's CLI wraps exactly this function.
  'the single sanctioned corpus-seeding composition helper writing the committed eval root',
  // Phase 372 G2/D-02/D-08: the read legs inverting the replay-record, score, and cassette-bundle
  // write legs — loadReplayRecord/loadScoreRecord mirror the loader's typed-refusal posture (every
  // read/parse failure is a returned ReplayRefusal, absence of score.json is typed, never a
  // throw), plus deterministic sorted sweep enumeration (ENOENT ⇒ empty) so every CLI verb sweeps
  // staged trees and the report verb rebuilds its inputs integrity-checked from disk.
  'replay-record, score, and staged-bundle read legs with typed refusals and sweep enumeration',
  // Phase 372 D-13 (BASE-02): commitEvalReport — the baseline report commits beside the corpus
  // and contracts that produced it, one dir per batchKey; JSON + markdown as ONE atomic unit,
  // write-once (identical regen ⇒ 'unchanged', divergent bytes ⇒ typed 'write-conflict', never
  // an overwrite). 441 D-15: the bytes are written as given, with no content check.
  // Phase 413 D-15/D-19/D-20 (ROOT-05/ROOT-11): the committed census and per-profile baseline
  // pointer join the reports/ family with the same write-once refusal (identical regen ⇒
  // 'unchanged', a key already pointing elsewhere ⇒ 'write-conflict', so moving a baseline stays
  // a reviewed git edit). The pointer writer additionally consults eval core's ONE comparator
  // predicate BEFORE any write, so a same-family-judged report is refused rather than
  // designated. Paired with the read leg that loads the committed root back for derivation;
  // every derivation stays in eval core.
  'the write-once committed census and baseline-pointer writers under agent-qa-eval/reports/, and the committed-root read leg',
  // Phase 415 D-04/D-16: per-profile floors and the report's optional decisions part. The
  // per-repeat reports stay local because every whole-corpus replay shares the designated
  // baseline's batchKey; committing another body would be a write-conflict.
  // Retargeted sweep/assembly and the gate/floor compositions bind the existing ports;
  // measurement, scoring and verdict derivations remain in eval core.
  'the write-once noise-floor artefact writer under agent-qa-eval/reports/noise-floor/ and the decisions.json third part of the report commit; the per-repeat retargeted replay sweep and batch assembly; the gate-side release-gate and floor compositions over the committed-root read leg',
  // The partition manifest and the run exclusion are two more committed documents, so they join
  // the SEEDING family and are written as authored. Both are write-once (a manifest whose salt or
  // fractions disagree with the committed one ⇒ 'write-conflict', because changing them
  // re-partitions a corpus that has already been gated against; an exclusion compares
  // runExclusionCore so a later backfill block never reads as a new decision). Neither writer
  // mints a salt — it arrives as data from the seed verb.
  'the write-once partition-manifest and run-exclusion writers under agent-qa-eval/contracts/ and agent-qa-eval/exclusions/',
  // Phase 414 D-18/D-19/D-20 (ROOT-10 SC5): the proposer-side /reader subpath — a SECOND package
  // entry, published beside the main one for the reason knowledge-local's reader entry exists:
  // an entry is the only boundary a rule can key on. The main entry is the GATE side (the root as
  // an fs path, the seeding and exclusion writers, the baseline pointer); this one
  // opens nothing, writes nothing and holds no lease — it reads the committed root once and hands
  // back the visibility-filtered slice. Its return types CANNOT carry a private held-out entry,
  // its cassette or its label, and a private cassetteId answers byte-identically to an id that
  // does not exist, so the port leaks neither the content nor the EXISTENCE of the unseen set.
  // Filtering only: the visibility predicate is eval core's, and no derivation happens here.
  'the proposer-side /reader subpath — visibility-filtered reads over the committed root whose return types cannot carry a private held-out entry, its cassette or its label',
  // Phase 422 D-01/D-02/D-03 (ADV-01/ADV-03/ADV-04): adversarial STORAGE, in two halves that
  // must not be confused. (1) Staging is LOCAL AUDIT DATA under
  // `.agent-qa/eval/adversarial/<product>/<batchDigest>` — the 418 D-21 feedback layout, same
  // write-once temporary-then-rename publication, same guarded path checks — holding the
  // derived cassette, its cloned standalone label and its corpus entry as the exact reviewable
  // bytes, pinned by content address in a batch manifest. Blob bytes are VALIDATED against the
  // seed's committed blobs and never copied into staging. (2) Admission is the operator's act
  // alone: `refreshAdversarialSplit` verifies the reviewed bytes and delegates every committed
  // write, as authored (441 D-15), to the existing single sanctioned seeding helper — it opens
  // no second writer. Generation, eligibility, target selection and the label clone are eval core's;
  // this composition executes and stores, never decides. The provider-invocation clause above
  // is UNAMENDED: nothing in the adversarial path constructs a model.
  // Phase 422 D-04/D-08 (422-03): a THIRD half beside the two above — the durable per-product
  // refresh record under `.agent-qa/eval/adversarial-state/<product>/<recordDigest>.json`. It is
  // storage, not judgment: one write-once, content-addressed row per refresh carrying the
  // resolved cap and its source, the novel-eligible and deferred seed counts, the immutable
  // selected-seed membership, and one settled outcome per completed (seed, mutator) tuple keyed
  // by table generation and guardrail-policy digest. It lives BESIDE the staging tree because a
  // staged batch is reviewable data an operator may delete, and the record of what was already
  // decided must outlive it. Nothing here derives or admits.
  // Phase 422 D-04/D-10/D-11 (422-06): a FOURTH half — the probe-reservation store under
  // `.agent-qa/eval/adversarial-probes/<product>/<tupleDigest>.{reservation,completion}.json`. It
  // exists because the refresh record above CANNOT carry it: that record is named by its own
  // content digest, and a row claiming work that has not happened yet has no content to be named
  // by. A reservation is claimed exclusively BEFORE the composition calls a `ProbeAuthorPort`,
  // and its completion is written once afterwards; a reservation with no completion IS the
  // interrupted state, derived rather than written, because a dying process cannot record that
  // it died. The provider-invocation clause below remains UNAMENDED and is not weakened: this
  // package still constructs no model, resolves no credential and names no provider — it calls a
  // port the CLI bound (D-10), and it stores what that call cost.
  'the adversarial batch staging store under .agent-qa/eval/adversarial/, the durable per-product refresh-state store under .agent-qa/eval/adversarial-state/, the probe-reservation store under .agent-qa/eval/adversarial-probes/, and the operator-only admission of reviewed bytes, delegating committed writes to the single sanctioned seeding helper',
] as const
export const AGENT_QA_EVAL_LOCAL_FORBIDDEN_RESPONSIBILITIES = [
  // Phase 422 D-07/D-10 (422-21), recorded here rather than in a plan summary because this is the
  // file a later plan would have to edit to make it false:
  //
  //   NO MODEL IS CONSTRUCTED ON THE ADVERSARIAL PATH.
  //
  // Staging derives and stores; the probe call goes out through a
  // `ProbeAuthorPort` this package receives and never builds. The author's model comes into
  // existence in `packages/cli/src/adversarial-probe-author.ts`, inside `runSafetyScope`, and what
  // crosses back here is one method taking a pure DTO and returning text plus usage. So the four
  // adversarial storage responsibilities above are STORAGE in full, and the clause below is
  // unamended rather than merely un-edited: this package's sanctioned model-construction sites are
  // still exactly the replay-composition helper's and the judge binding's, both of which predate
  // this phase. `packages/arch/src/__tests__/422-no-eval-writer.test.ts` counts them.
  //
  // The composition carve-out is narrow: provider invocation is permitted ONLY through the single
  // sanctioned replay-composition helper's one createModel call site; any other provider invocation
  // ownership remains forbidden.
  'provider invocation ownership beyond the single sanctioned replay-composition helper',
  // Likewise, replay invokes the real unmodified LLMPlanner inside that one helper — bespoke
  // planner, prompt assembly, or grounding logic remains forbidden.
  'agent decision or planning logic beyond invoking the unmodified planner in that one helper',
  'platform-adapter execution',
  'cassette extraction, scoring, or projection logic owned by eval core',
] as const
export const AGENT_QA_EVAL_LOCAL_EXTERNAL_DEPENDENCIES = ['ai', 'zod'] as const
export const AGENT_QA_EVAL_LOCAL_INTERNAL_DEPENDENCIES = [
  '@vostride/agent-qa-eval',
  '@vostride/agent-qa-model',
  '@vostride/agent-qa-runner',
  '@vostride/agent-qa-runner-local',
  '@vostride/agent-qa-safety',
  // 2026-10-15 (441-32, D-15): @vostride/agent-qa-safety-local left with the replay and judge
  // calibration audit scopes, its last imports.
  '@vostride/agent-qa-schema',
] as const

export const AGENT_QA_EVAL_LOCAL_OWNERSHIP_CONTRACT = {
  packageName: AGENT_QA_EVAL_LOCAL_PACKAGE_NAME,
  packageDir: AGENT_QA_EVAL_LOCAL_PACKAGE_DIR,
  packageClasses: AGENT_QA_EVAL_LOCAL_PACKAGE_CLASSES,
  allowedResponsibilities: AGENT_QA_EVAL_LOCAL_ALLOWED_RESPONSIBILITIES,
  forbiddenResponsibilities: AGENT_QA_EVAL_LOCAL_FORBIDDEN_RESPONSIBILITIES,
  externalDependencies: AGENT_QA_EVAL_LOCAL_EXTERNAL_DEPENDENCIES,
  internalDependencies: AGENT_QA_EVAL_LOCAL_INTERNAL_DEPENDENCIES,
} as const satisfies OwnershipContract
