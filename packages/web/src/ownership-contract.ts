import type { OwnershipContract } from '@vostride/agent-qa-arch'

export const AGENT_QA_WEB_PACKAGE_NAME = '@vostride/agent-qa-web'
export const AGENT_QA_WEB_PACKAGE_DIR = 'packages/web'
export const AGENT_QA_WEB_PACKAGE_CLASSES = ['adapter'] as const
export const AGENT_QA_WEB_ALLOWED_RESPONSIBILITIES = [
  'Playwright web PlatformAdapter implementing the runner platform-adapter port',
] as const
export const AGENT_QA_WEB_FORBIDDEN_RESPONSIBILITIES = [
  'any knowledge-write path (add/confirm/supersede/deprecate/commit/promotion - the L2 forbidden surface)',
  'provider model SDK ownership',
] as const
export const AGENT_QA_WEB_EXTERNAL_DEPENDENCIES = [
  '@axe-core/playwright',
  'playwright-core',
] as const
export const AGENT_QA_WEB_INTERNAL_DEPENDENCIES = [
  '@vostride/agent-qa-runner',
  '@vostride/agent-qa-schema',
] as const

export const AGENT_QA_WEB_OWNERSHIP_CONTRACT = {
  packageName: AGENT_QA_WEB_PACKAGE_NAME,
  packageDir: AGENT_QA_WEB_PACKAGE_DIR,
  packageClasses: AGENT_QA_WEB_PACKAGE_CLASSES,
  allowedResponsibilities: AGENT_QA_WEB_ALLOWED_RESPONSIBILITIES,
  forbiddenResponsibilities: AGENT_QA_WEB_FORBIDDEN_RESPONSIBILITIES,
  externalDependencies: AGENT_QA_WEB_EXTERNAL_DEPENDENCIES,
  internalDependencies: AGENT_QA_WEB_INTERNAL_DEPENDENCIES,
} as const satisfies OwnershipContract
