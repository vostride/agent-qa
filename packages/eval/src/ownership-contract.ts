import type { OwnershipContract } from '@vostride/agent-qa-arch'

export const AGENT_QA_EVAL_PACKAGE_NAME = '@vostride/agent-qa-eval'
export const AGENT_QA_EVAL_PACKAGE_DIR = 'packages/eval'
export const AGENT_QA_EVAL_PACKAGE_CLASSES = [
  'browserSafe',
  'providerNeutral',
  'storageNeutral',
] as const
export const AGENT_QA_EVAL_ALLOWED_RESPONSIBILITIES = [
  'versioned four-leg cassette DTOs, schemaVersion discipline, and load guards',
  'pure deterministic cassette extraction from in-memory completed-run handoff evidence',
  // Phase 371 D-09/D-16 (LABEL-01..03, ROOT-03): the pure label factory (self-heal pair
  // matching, deterministic silver sampling, standalone label-record and corpus-entry
  // projections) and the corpus-seeding planner — deterministic projections over handoff
  // evidence and extracted cassette ids; every byte is written by eval-local, selection
  // never leaves core.
  'pure label-factory projections and deterministic corpus-seeding plans over extracted cassettes',
] as const
export const AGENT_QA_EVAL_FORBIDDEN_RESPONSIBILITIES = [
  'filesystem or host IO, which belongs exclusively to @vostride/agent-qa-eval-local',
  'provider invocation ownership',
  'agent planning, platform-adapter execution, or runner execution side effects',
  'interpretation or execution of recorded tool exchanges, which remain opaque evidence data',
] as const
export const AGENT_QA_EVAL_EXTERNAL_DEPENDENCIES = ['ai', 'zod'] as const
export const AGENT_QA_EVAL_INTERNAL_DEPENDENCIES = [
  '@vostride/agent-qa-runner',
  // Phase 369 D-05: reuse the live policy gate's one risk vocabulary.
  '@vostride/agent-qa-safety',
  '@vostride/agent-qa-schema',
] as const

export const AGENT_QA_EVAL_OWNERSHIP_CONTRACT = {
  packageName: AGENT_QA_EVAL_PACKAGE_NAME,
  packageDir: AGENT_QA_EVAL_PACKAGE_DIR,
  packageClasses: AGENT_QA_EVAL_PACKAGE_CLASSES,
  allowedResponsibilities: AGENT_QA_EVAL_ALLOWED_RESPONSIBILITIES,
  forbiddenResponsibilities: AGENT_QA_EVAL_FORBIDDEN_RESPONSIBILITIES,
  externalDependencies: AGENT_QA_EVAL_EXTERNAL_DEPENDENCIES,
  internalDependencies: AGENT_QA_EVAL_INTERNAL_DEPENDENCIES,
} as const satisfies OwnershipContract
