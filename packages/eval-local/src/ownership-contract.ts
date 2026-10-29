import type { OwnershipContract } from '@vostride/agent-qa-arch'

export const AGENT_QA_EVAL_LOCAL_PACKAGE_NAME = '@vostride/agent-qa-eval-local'
export const AGENT_QA_EVAL_LOCAL_PACKAGE_DIR = 'packages/eval-local'
export const AGENT_QA_EVAL_LOCAL_PACKAGE_CLASSES = ['storageImplementation'] as const
export const AGENT_QA_EVAL_LOCAL_ALLOWED_RESPONSIBILITIES = [
  'all eval filesystem IO behind the neutral artifact read port',
  'artifact reads composed over runner-local stores',
  'cassette bundle writes under the runtime workdir staging root',
  // Eval-local imports both model and runner for this helper, as cli does.
  'the single sanctioned replay-composition helper wiring createModel + LLMPlanner',
  // Score files sit beside replay files and are overwritten per file, so both survive re-runs.
  'per-cassette score and diff persistence beside replay records',
  // The aggregated EvalBatchReport as its own artifact under eval/reports/, keyed by the
  // deterministic replay-batch key: uncommitted runtime staging beside eval/replays.
  'aggregated eval batch-report persistence under the runtime staging root',
  // Every judge call goes through `createModel`; this exception authorizes no other factory.
  'the tier-4 judge-port binding through createModel, including bindJudgePanel as N existing bindings during replay',
  // Read legs return typed refusals, never throw, and enumerate sweeps in sorted order.
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
