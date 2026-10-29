import type { OwnershipContract } from '@vostride/agent-qa-arch'

export const AGENT_QA_AGENT_LOCAL_PACKAGE_NAME = '@vostride/agent-qa-agent-local'
export const AGENT_QA_AGENT_LOCAL_PACKAGE_DIR = 'packages/agent-local'
export const AGENT_QA_AGENT_LOCAL_PACKAGE_CLASSES = ['storageImplementation'] as const
// The local host's store and composition root: the run lines permit assembling, never deciding.
export const AGENT_QA_AGENT_LOCAL_ALLOWED_RESPONSIBILITIES = [
  'local agent persistence-store implementation for jobs, checkpoints, approvals, and patches',
  'filesystem access for local agent persistence stores',
  'sqlite access for local agent persistence stores',
  'host-neutral run composition: assembling injected adapters, models and ports into a runnable run config',
  'run-scoped knowledge serving composition: budget derivation and read-only reader binding',
  'marks ledger persistence beside each recorded run',
] as const
// Composition delegates to an adapter it is handed; owning an adapter stays forbidden.
export const AGENT_QA_AGENT_LOCAL_FORBIDDEN_RESPONSIBILITIES = [
  'provider invocation ownership',
  'platform-adapter implementation',
  'agent decision or planning logic',
  'knowledge curation semantics',
] as const
// zod validates the marks ledger's intent and lock-owner files.
export const AGENT_QA_AGENT_LOCAL_EXTERNAL_DEPENDENCIES = ['zod'] as const
// Workspace links only; the composition-carveout rule confines these edges to `composition/`.
export const AGENT_QA_AGENT_LOCAL_INTERNAL_DEPENDENCIES = [
  '@vostride/agent-qa-agent',
  '@vostride/agent-qa-knowledge-local',
  '@vostride/agent-qa-model',
  '@vostride/agent-qa-runner',
  '@vostride/agent-qa-runner-local',
  '@vostride/agent-qa-safety',
  '@vostride/agent-qa-safety-local',
  '@vostride/agent-qa-schema',
  '@vostride/agent-qa-web',
] as const

export const AGENT_QA_AGENT_LOCAL_OWNERSHIP_CONTRACT = {
  packageName: AGENT_QA_AGENT_LOCAL_PACKAGE_NAME,
  packageDir: AGENT_QA_AGENT_LOCAL_PACKAGE_DIR,
  packageClasses: AGENT_QA_AGENT_LOCAL_PACKAGE_CLASSES,
  allowedResponsibilities: AGENT_QA_AGENT_LOCAL_ALLOWED_RESPONSIBILITIES,
  forbiddenResponsibilities: AGENT_QA_AGENT_LOCAL_FORBIDDEN_RESPONSIBILITIES,
  externalDependencies: AGENT_QA_AGENT_LOCAL_EXTERNAL_DEPENDENCIES,
  internalDependencies: AGENT_QA_AGENT_LOCAL_INTERNAL_DEPENDENCIES,
} as const satisfies OwnershipContract
