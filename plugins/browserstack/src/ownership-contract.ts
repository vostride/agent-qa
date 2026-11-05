import type { OwnershipContract } from '@vostride/agent-qa-arch'

export const AGENT_QA_PLUGIN_BROWSERSTACK_PACKAGE_NAME = '@vostride/agent-qa-plugin-browserstack'
export const AGENT_QA_PLUGIN_BROWSERSTACK_PACKAGE_DIR = 'plugins/browserstack'
export const AGENT_QA_PLUGIN_BROWSERSTACK_PACKAGE_CLASSES = ['plugin'] as const
export const AGENT_QA_PLUGIN_BROWSERSTACK_ALLOWED_RESPONSIBILITIES = [
  "BrowserStack's session requests: capabilities, the Playwright URL and the Playwright versions BrowserStack lists",
  "BrowserStack's device session requests: the Appium hub and bstack:options",
  "BrowserStack's REST API: Automate and App Automate session links, outcome marks, plans and app uploads by content",
] as const
export const AGENT_QA_PLUGIN_BROWSERSTACK_FORBIDDEN_RESPONSIBILITIES = [
  'any @vostride/agent-qa-* runtime dependency except the plugin kit',
  'logging or returning the BrowserStack username or access key outside a masked answer',
] as const
export const AGENT_QA_PLUGIN_BROWSERSTACK_EXTERNAL_DEPENDENCIES = [] as const
export const AGENT_QA_PLUGIN_BROWSERSTACK_INTERNAL_DEPENDENCIES = [
  '@vostride/agent-qa-plugin-kit',
] as const

export const AGENT_QA_PLUGIN_BROWSERSTACK_OWNERSHIP_CONTRACT = {
  packageName: AGENT_QA_PLUGIN_BROWSERSTACK_PACKAGE_NAME,
  packageDir: AGENT_QA_PLUGIN_BROWSERSTACK_PACKAGE_DIR,
  packageClasses: AGENT_QA_PLUGIN_BROWSERSTACK_PACKAGE_CLASSES,
  allowedResponsibilities: AGENT_QA_PLUGIN_BROWSERSTACK_ALLOWED_RESPONSIBILITIES,
  forbiddenResponsibilities: AGENT_QA_PLUGIN_BROWSERSTACK_FORBIDDEN_RESPONSIBILITIES,
  externalDependencies: AGENT_QA_PLUGIN_BROWSERSTACK_EXTERNAL_DEPENDENCIES,
  internalDependencies: AGENT_QA_PLUGIN_BROWSERSTACK_INTERNAL_DEPENDENCIES,
} as const satisfies OwnershipContract
