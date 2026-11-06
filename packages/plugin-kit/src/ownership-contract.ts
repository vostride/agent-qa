import type { OwnershipContract } from '@vostride/agent-qa-arch'

export const AGENT_QA_PLUGIN_KIT_PACKAGE_NAME = '@vostride/agent-qa-plugin-kit'
export const AGENT_QA_PLUGIN_KIT_PACKAGE_DIR = 'packages/plugin-kit'
export const AGENT_QA_PLUGIN_KIT_PACKAGE_CLASSES = ['pluginKit'] as const
export const AGENT_QA_PLUGIN_KIT_ALLOWED_RESPONSIBILITIES = [
  'the public plugin protocol: message schemas, error codes, failure kinds, framing and the manifest',
  'definePlugin and the stdio loop a plugin runs',
  'credential marks and the build-time schema and manifest emitter',
  'the conformance runner and scripted plugins for testing hosts and plugins',
  'vendor-neutral HTTP helpers for plugin authors: endpoint options and status-to-failure-kind mapping',
] as const
export const AGENT_QA_PLUGIN_KIT_FORBIDDEN_RESPONSIBILITIES = [
  'vendor code',
  'any @vostride/agent-qa-* runtime dependency',
  'agent-qa host behaviour such as starting plugins or resolving config',
] as const
export const AGENT_QA_PLUGIN_KIT_EXTERNAL_DEPENDENCIES = ['zod'] as const
export const AGENT_QA_PLUGIN_KIT_INTERNAL_DEPENDENCIES = [] as const

export const AGENT_QA_PLUGIN_KIT_OWNERSHIP_CONTRACT = {
  packageName: AGENT_QA_PLUGIN_KIT_PACKAGE_NAME,
  packageDir: AGENT_QA_PLUGIN_KIT_PACKAGE_DIR,
  packageClasses: AGENT_QA_PLUGIN_KIT_PACKAGE_CLASSES,
  allowedResponsibilities: AGENT_QA_PLUGIN_KIT_ALLOWED_RESPONSIBILITIES,
  forbiddenResponsibilities: AGENT_QA_PLUGIN_KIT_FORBIDDEN_RESPONSIBILITIES,
  externalDependencies: AGENT_QA_PLUGIN_KIT_EXTERNAL_DEPENDENCIES,
  internalDependencies: AGENT_QA_PLUGIN_KIT_INTERNAL_DEPENDENCIES,
} as const satisfies OwnershipContract
