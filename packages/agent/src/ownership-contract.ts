import type { OwnershipContract } from '@vostride/agent-qa-arch'

export const AGENT_QA_AGENT_PACKAGE_NAME = '@vostride/agent-qa-agent'
export const AGENT_QA_AGENT_PACKAGE_DIR = 'packages/agent'
export const AGENT_QA_AGENT_PACKAGE_CLASSES = ['providerNeutral', 'storageNeutral'] as const
export const AGENT_QA_AGENT_ALLOWED_RESPONSIBILITIES = [
  'provider-neutral and storage-neutral knowledge write/curation port contract',
  'provider-neutral and storage-neutral tools execution port contract',
  'provider-neutral and storage-neutral agent persistence-store port contract',
  'provider-neutral and storage-neutral approvals gating port contract',
  'provider-neutral and storage-neutral clock port contract',
  'typed function layer: FunctionSpec/FunctionRegistry/invokeFunction, the single surface-capability gate call-site',
] as const
export const AGENT_QA_AGENT_FORBIDDEN_RESPONSIBILITIES = [
  'filesystem, database, or process access',
  'provider invocation ownership',
  'local runtime persistence',
  'concrete platform-adapter, knowledge-store, tool-store, or agent-store implementations',
] as const
// `ai` may describe tools and call a model it is handed; `@ai-sdk/*` provider adapters stay out.
export const AGENT_QA_AGENT_EXTERNAL_DEPENDENCIES = ['ai', 'zod'] as const
// `runner` supplies the event-log replay contract, so resume-token semantics cannot fork.
export const AGENT_QA_AGENT_INTERNAL_DEPENDENCIES = [
  '@vostride/agent-qa-runner',
  '@vostride/agent-qa-schema',
] as const

export const AGENT_QA_AGENT_OWNERSHIP_CONTRACT = {
  packageName: AGENT_QA_AGENT_PACKAGE_NAME,
  packageDir: AGENT_QA_AGENT_PACKAGE_DIR,
  packageClasses: AGENT_QA_AGENT_PACKAGE_CLASSES,
  allowedResponsibilities: AGENT_QA_AGENT_ALLOWED_RESPONSIBILITIES,
  forbiddenResponsibilities: AGENT_QA_AGENT_FORBIDDEN_RESPONSIBILITIES,
  externalDependencies: AGENT_QA_AGENT_EXTERNAL_DEPENDENCIES,
  internalDependencies: AGENT_QA_AGENT_INTERNAL_DEPENDENCIES,
} as const satisfies OwnershipContract
