import type { OwnershipContract } from '@vostride/agent-qa-arch'

export const AGENT_QA_EVAL_LOCAL_PACKAGE_NAME = '@vostride/agent-qa-eval-local'
export const AGENT_QA_EVAL_LOCAL_PACKAGE_DIR = 'packages/eval-local'
export const AGENT_QA_EVAL_LOCAL_PACKAGE_CLASSES = ['storageImplementation'] as const
export const AGENT_QA_EVAL_LOCAL_ALLOWED_RESPONSIBILITIES = [
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
  // The aggregated EvalBatchReport as its own artifact under eval/reports/, keyed by the
  // deterministic replay-batch key: uncommitted runtime staging beside eval/replays.
  'aggregated eval batch-report persistence under the runtime staging root',
  // Phase 370 D-05/D-06: the tier-4 judge leg — bindJudgePort routes every judge call through
  // createModel (the pinned-last mask/guardrail middleware stack, JUDGE-03) at temperature 0,
  // maxRetries 0, one structured Output.object verdict per order-tagged request, parsed against
  // a closed zod schema with typed call-error degradation (the port never throws, D-11). Prompt
  // content arrives fully built from eval core (D-15) — the binding transports, never assembles.
  // bindJudgePanel composes N existing bindJudgePort handles at this same factory site.
  // Only replay invokes them; this exception does not authorize another factory or general
  // provider invocation.
  'the tier-4 judge-port binding through createModel, including bindJudgePanel as N existing bindings during replay',
  // Phase 372 G2/D-02/D-08: the read legs inverting the replay-record, score, and cassette-bundle
  // write legs — loadReplayRecord/loadScoreRecord mirror the loader's typed-refusal posture (every
  // read/parse failure is a returned ReplayRefusal, absence of score.json is typed, never a
  // throw), plus deterministic sorted sweep enumeration (ENOENT ⇒ empty) so every CLI verb sweeps
  // staged trees and the report verb rebuilds its inputs integrity-checked from disk.
  'replay-record, score, and staged-bundle read legs with typed refusals and sweep enumeration',
] as const
export const AGENT_QA_EVAL_LOCAL_FORBIDDEN_RESPONSIBILITIES = [
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
