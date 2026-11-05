import type { OwnershipContract } from '@vostride/agent-qa-arch'

export const AGENT_QA_PLUGIN_KERNEL_PACKAGE_NAME = '@vostride/agent-qa-plugin-kernel'
export const AGENT_QA_PLUGIN_KERNEL_PACKAGE_DIR = 'plugins/kernel'
export const AGENT_QA_PLUGIN_KERNEL_PACKAGE_CLASSES = ['plugin'] as const
export const AGENT_QA_PLUGIN_KERNEL_ALLOWED_RESPONSIBILITIES = [
  "Kernel's browser API: creating a browser before a test connects and deleting it after",
] as const
export const AGENT_QA_PLUGIN_KERNEL_FORBIDDEN_RESPONSIBILITIES = [
  'any @vostride/agent-qa-* runtime dependency except the plugin kit',
  'logging or returning the Kernel API key',
] as const
export const AGENT_QA_PLUGIN_KERNEL_EXTERNAL_DEPENDENCIES = [] as const
export const AGENT_QA_PLUGIN_KERNEL_INTERNAL_DEPENDENCIES = [
  '@vostride/agent-qa-plugin-kit',
] as const

export const AGENT_QA_PLUGIN_KERNEL_OWNERSHIP_CONTRACT = {
  packageName: AGENT_QA_PLUGIN_KERNEL_PACKAGE_NAME,
  packageDir: AGENT_QA_PLUGIN_KERNEL_PACKAGE_DIR,
  packageClasses: AGENT_QA_PLUGIN_KERNEL_PACKAGE_CLASSES,
  allowedResponsibilities: AGENT_QA_PLUGIN_KERNEL_ALLOWED_RESPONSIBILITIES,
  forbiddenResponsibilities: AGENT_QA_PLUGIN_KERNEL_FORBIDDEN_RESPONSIBILITIES,
  externalDependencies: AGENT_QA_PLUGIN_KERNEL_EXTERNAL_DEPENDENCIES,
  internalDependencies: AGENT_QA_PLUGIN_KERNEL_INTERNAL_DEPENDENCIES,
} as const satisfies OwnershipContract
