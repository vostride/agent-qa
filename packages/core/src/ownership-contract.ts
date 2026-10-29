import type { OwnershipContract } from '@vostride/agent-qa-arch'

export const AGENT_QA_CORE_PACKAGE_NAME = '@vostride/agent-qa-core'
export const AGENT_QA_CORE_PACKAGE_DIR = 'packages/core'
export const AGENT_QA_CORE_PACKAGE_CLASSES = ['transitional'] as const
export const AGENT_QA_CORE_ALLOWED_RESPONSIBILITIES = [
  'suite/test parsing + discovery: yaml/suite/test/config parsing, hooks-file parser + schema, and workspace file discovery — feeding the resolved RunConfig at the CLI composition root (parser, suite, schema, types, hooks, workspace, validation)',
  'analytics subsystem: PostHog identity + core-owned bus-subscriber run feed per D-16 (analytics)',
  'LLM provider auth + captured browser auth-state reuse: OAuth/PKCE plugin auth and auth-state redaction/resolution (auth, auth-state)',
  'mobile support: appium launch/element/gesture resolution (mobile)',
  'provider + plugin loading (providers, plugin-loader-util)',
  'agent token-budget/context helpers (agent)',
  'cross-cutting host-neutral helpers consumed by the CLI: run-id minting, run-attribute assembly, runtime path resolution, LogManager, version + update-check reporting, path-validation (ids, run-attributes, runtime-paths, logging, version, version-check, utils)',
] as const
export const AGENT_QA_CORE_FORBIDDEN_RESPONSIBILITIES = [
  'new responsibilities or new boundary violations beyond what the ledger already enumerates',
] as const
export const AGENT_QA_CORE_EXTERNAL_DEPENDENCIES = [
  'ai',
  'bytes',
  'fast-xml-parser',
  'glob',
  'ms',
  'picocolors',
  'semver',
  'yaml',
  'zod',
] as const
export const AGENT_QA_CORE_INTERNAL_DEPENDENCIES = [
  '@vostride/agent-qa-ids',
  '@vostride/agent-qa-runner',
  '@vostride/agent-qa-schema',
] as const

// npm-level provider-SDK and native-store debt only; source-level debt is in core-host-baseline.ts.
export const AGENT_QA_CORE_MIGRATION_LEDGER = [
] as const

export const AGENT_QA_CORE_OWNERSHIP_CONTRACT = {
  packageName: AGENT_QA_CORE_PACKAGE_NAME,
  packageDir: AGENT_QA_CORE_PACKAGE_DIR,
  packageClasses: AGENT_QA_CORE_PACKAGE_CLASSES,
  allowedResponsibilities: AGENT_QA_CORE_ALLOWED_RESPONSIBILITIES,
  forbiddenResponsibilities: AGENT_QA_CORE_FORBIDDEN_RESPONSIBILITIES,
  externalDependencies: AGENT_QA_CORE_EXTERNAL_DEPENDENCIES,
  internalDependencies: AGENT_QA_CORE_INTERNAL_DEPENDENCIES,
  ledger: AGENT_QA_CORE_MIGRATION_LEDGER,
} as const satisfies OwnershipContract
