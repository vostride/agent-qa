import type { OwnershipContract } from '@vostride/agent-qa-arch'

export const AGENT_QA_SAFETY_PACKAGE_NAME = '@vostride/agent-qa-safety'
export const AGENT_QA_SAFETY_PACKAGE_DIR = 'packages/safety'
export const AGENT_QA_SAFETY_PACKAGE_CLASSES = ['providerNeutral', 'storageNeutral'] as const
// the responsibilities are the ones that remain after 441-33.
export const AGENT_QA_SAFETY_ALLOWED_RESPONSIBILITIES = [
  'provider-request prompt walker and declared-secret masking middleware factory',
  'neutral execution-context resolver seam',
  'app-observed data delimiters',
] as const
export const AGENT_QA_SAFETY_FORBIDDEN_RESPONSIBILITIES = [
  'filesystem, database, or process access',
  'provider invocation ownership',
  'concrete host adapters',
  'local runtime persistence',
] as const
export const AGENT_QA_SAFETY_EXTERNAL_DEPENDENCIES = ['ai'] as const
export const AGENT_QA_SAFETY_INTERNAL_DEPENDENCIES = ['@vostride/agent-qa-schema'] as const

export const AGENT_QA_SAFETY_OWNERSHIP_CONTRACT = {
  packageName: AGENT_QA_SAFETY_PACKAGE_NAME,
  packageDir: AGENT_QA_SAFETY_PACKAGE_DIR,
  packageClasses: AGENT_QA_SAFETY_PACKAGE_CLASSES,
  allowedResponsibilities: AGENT_QA_SAFETY_ALLOWED_RESPONSIBILITIES,
  forbiddenResponsibilities: AGENT_QA_SAFETY_FORBIDDEN_RESPONSIBILITIES,
  externalDependencies: AGENT_QA_SAFETY_EXTERNAL_DEPENDENCIES,
  internalDependencies: AGENT_QA_SAFETY_INTERNAL_DEPENDENCIES,
} as const satisfies OwnershipContract
