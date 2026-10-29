import type { OwnershipContract } from '@vostride/agent-qa-arch'

export const AGENT_QA_SAFETY_LOCAL_PACKAGE_NAME = '@vostride/agent-qa-safety-local'
export const AGENT_QA_SAFETY_LOCAL_PACKAGE_DIR = 'packages/safety-local'
export const AGENT_QA_SAFETY_LOCAL_PACKAGE_CLASSES = ['storageImplementation'] as const
// the responsibilities are the ones that remain after 441-33 and
// 441-44.
export const AGENT_QA_SAFETY_LOCAL_ALLOWED_RESPONSIBILITIES = [
  'local AsyncLocalStorage run-safety scope binding behind the safety execution-context resolver seam',
  'host execution-context detection behind the safety resolver seam',
  'one-way fingerprint helper',
] as const
export const AGENT_QA_SAFETY_LOCAL_FORBIDDEN_RESPONSIBILITIES = [
  'provider invocation ownership',
  'execution-safety policy decision logic',
  'masking or secret detection semantics',
  'agent decision or planning logic',
] as const
export const AGENT_QA_SAFETY_LOCAL_EXTERNAL_DEPENDENCIES = [] as const
export const AGENT_QA_SAFETY_LOCAL_INTERNAL_DEPENDENCIES = [
  '@vostride/agent-qa-safety',
  '@vostride/agent-qa-schema',
] as const

export const AGENT_QA_SAFETY_LOCAL_OWNERSHIP_CONTRACT = {
  packageName: AGENT_QA_SAFETY_LOCAL_PACKAGE_NAME,
  packageDir: AGENT_QA_SAFETY_LOCAL_PACKAGE_DIR,
  packageClasses: AGENT_QA_SAFETY_LOCAL_PACKAGE_CLASSES,
  allowedResponsibilities: AGENT_QA_SAFETY_LOCAL_ALLOWED_RESPONSIBILITIES,
  forbiddenResponsibilities: AGENT_QA_SAFETY_LOCAL_FORBIDDEN_RESPONSIBILITIES,
  externalDependencies: AGENT_QA_SAFETY_LOCAL_EXTERNAL_DEPENDENCIES,
  internalDependencies: AGENT_QA_SAFETY_LOCAL_INTERNAL_DEPENDENCIES,
} as const satisfies OwnershipContract
