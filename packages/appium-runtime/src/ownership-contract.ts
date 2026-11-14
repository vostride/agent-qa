import type { OwnershipContract } from '@vostride/agent-qa-arch'

export const AGENT_QA_APPIUM_RUNTIME_PACKAGE_NAME = '@vostride/agent-qa-appium-runtime'
export const AGENT_QA_APPIUM_RUNTIME_PACKAGE_DIR = 'packages/appium-runtime'
export const AGENT_QA_APPIUM_RUNTIME_PACKAGE_CLASSES = ['adapter'] as const
export const AGENT_QA_APPIUM_RUNTIME_ALLOWED_RESPONSIBILITIES = [
  'the pinned Appium server with its UiAutomator2 and XCUITest drivers, and starting that server on this machine',
] as const
export const AGENT_QA_APPIUM_RUNTIME_FORBIDDEN_RESPONSIBILITIES = [
  'session handling and device actions, which belong to the Android and iOS adapters',
  "reading a project's or the machine's own Appium",
] as const
export const AGENT_QA_APPIUM_RUNTIME_EXTERNAL_DEPENDENCIES = [
  'appium',
  'appium-uiautomator2-driver',
  'appium-xcuitest-driver',
  'tree-kill',
] as const
export const AGENT_QA_APPIUM_RUNTIME_INTERNAL_DEPENDENCIES = [] as const
export const AGENT_QA_APPIUM_RUNTIME_RESOLUTION_PINS = [
  '@appium/base-driver',
  '@appium/base-plugin',
  '@appium/docutils',
  '@appium/http-server',
  '@appium/logger',
  '@appium/schema',
  '@appium/support',
  '@appium/types',
] as const

export const AGENT_QA_APPIUM_RUNTIME_OWNERSHIP_CONTRACT = {
  packageName: AGENT_QA_APPIUM_RUNTIME_PACKAGE_NAME,
  packageDir: AGENT_QA_APPIUM_RUNTIME_PACKAGE_DIR,
  packageClasses: AGENT_QA_APPIUM_RUNTIME_PACKAGE_CLASSES,
  allowedResponsibilities: AGENT_QA_APPIUM_RUNTIME_ALLOWED_RESPONSIBILITIES,
  forbiddenResponsibilities: AGENT_QA_APPIUM_RUNTIME_FORBIDDEN_RESPONSIBILITIES,
  externalDependencies: AGENT_QA_APPIUM_RUNTIME_EXTERNAL_DEPENDENCIES,
  internalDependencies: AGENT_QA_APPIUM_RUNTIME_INTERNAL_DEPENDENCIES,
  resolutionPins: AGENT_QA_APPIUM_RUNTIME_RESOLUTION_PINS,
} as const satisfies OwnershipContract
