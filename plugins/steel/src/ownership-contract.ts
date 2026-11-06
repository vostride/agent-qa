import type { OwnershipContract } from '@vostride/agent-qa-arch'

export const AGENT_QA_PLUGIN_STEEL_PACKAGE_NAME = '@vostride/agent-qa-plugin-steel'
export const AGENT_QA_PLUGIN_STEEL_PACKAGE_DIR = 'plugins/steel'
export const AGENT_QA_PLUGIN_STEEL_PACKAGE_CLASSES = ['plugin'] as const
export const AGENT_QA_PLUGIN_STEEL_ALLOWED_RESPONSIBILITIES = [
  "Steel's session API: creating a browser session before a test connects and releasing it after",
] as const
export const AGENT_QA_PLUGIN_STEEL_FORBIDDEN_RESPONSIBILITIES = [
  'any @vostride/agent-qa-* runtime dependency except the plugin kit',
  'logging or returning the Steel API key',
] as const
export const AGENT_QA_PLUGIN_STEEL_EXTERNAL_DEPENDENCIES = [] as const
export const AGENT_QA_PLUGIN_STEEL_INTERNAL_DEPENDENCIES = [
  '@vostride/agent-qa-plugin-kit',
] as const

export const AGENT_QA_PLUGIN_STEEL_OWNERSHIP_CONTRACT = {
  packageName: AGENT_QA_PLUGIN_STEEL_PACKAGE_NAME,
  packageDir: AGENT_QA_PLUGIN_STEEL_PACKAGE_DIR,
  packageClasses: AGENT_QA_PLUGIN_STEEL_PACKAGE_CLASSES,
  allowedResponsibilities: AGENT_QA_PLUGIN_STEEL_ALLOWED_RESPONSIBILITIES,
  forbiddenResponsibilities: AGENT_QA_PLUGIN_STEEL_FORBIDDEN_RESPONSIBILITIES,
  externalDependencies: AGENT_QA_PLUGIN_STEEL_EXTERNAL_DEPENDENCIES,
  internalDependencies: AGENT_QA_PLUGIN_STEEL_INTERNAL_DEPENDENCIES,
} as const satisfies OwnershipContract
