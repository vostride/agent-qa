import type { OwnershipContract } from '@vostride/agent-qa-arch'

export const AGENT_QA_ANDROID_PACKAGE_NAME = '@vostride/agent-qa-android'
export const AGENT_QA_ANDROID_PACKAGE_DIR = 'packages/android'
export const AGENT_QA_ANDROID_PACKAGE_CLASSES = ['adapter'] as const
export const AGENT_QA_ANDROID_ALLOWED_RESPONSIBILITIES = [
  'Appium UiAutomator2 android PlatformAdapter implementing the runner platform-adapter port',
] as const
export const AGENT_QA_ANDROID_FORBIDDEN_RESPONSIBILITIES = [
  'any knowledge-write path (add/confirm/supersede/deprecate/commit/promotion - the L2 forbidden surface)',
  'provider model SDK ownership',
] as const
export const AGENT_QA_ANDROID_EXTERNAL_DEPENDENCIES = ['webdriverio'] as const
export const AGENT_QA_ANDROID_INTERNAL_DEPENDENCIES = [
  '@vostride/agent-qa-appium-runtime',
  '@vostride/agent-qa-core',
  '@vostride/agent-qa-runner',
  '@vostride/agent-qa-runner-local',
  '@vostride/agent-qa-schema',
] as const

export const AGENT_QA_ANDROID_OWNERSHIP_CONTRACT = {
  packageName: AGENT_QA_ANDROID_PACKAGE_NAME,
  packageDir: AGENT_QA_ANDROID_PACKAGE_DIR,
  packageClasses: AGENT_QA_ANDROID_PACKAGE_CLASSES,
  allowedResponsibilities: AGENT_QA_ANDROID_ALLOWED_RESPONSIBILITIES,
  forbiddenResponsibilities: AGENT_QA_ANDROID_FORBIDDEN_RESPONSIBILITIES,
  externalDependencies: AGENT_QA_ANDROID_EXTERNAL_DEPENDENCIES,
  internalDependencies: AGENT_QA_ANDROID_INTERNAL_DEPENDENCIES,
} as const satisfies OwnershipContract
