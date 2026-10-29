import type { OwnershipContract } from '@vostride/agent-qa-arch'

export const AGENT_QA_DASHBOARD_PACKAGE_NAME = '@vostride/agent-qa-dashboard'
export const AGENT_QA_DASHBOARD_PACKAGE_DIR = 'packages/dashboard-server'
export const AGENT_QA_DASHBOARD_PACKAGE_CLASSES = ['surface'] as const
export const AGENT_QA_DASHBOARD_ALLOWED_RESPONSIBILITIES = [
  'local dashboard server: live view, run-detail, composition root with full host/storage access',
] as const
export const AGENT_QA_DASHBOARD_FORBIDDEN_RESPONSIBILITIES = [
  'none - surface is unconstrained on host/storage per spec section 4',
] as const
export const AGENT_QA_DASHBOARD_EXTERNAL_DEPENDENCIES = [
  'ai',
  'picocolors',
  'tree-kill',
  'ws',
  'yaml',
  'zod',
] as const
export const AGENT_QA_DASHBOARD_INTERNAL_DEPENDENCIES = [
  '@vostride/agent-qa-android',
  '@vostride/agent-qa-core',
  '@vostride/agent-qa-ids',
  '@vostride/agent-qa-ios',
  // `@vostride/agent-qa-mcp` is GONE from this list and from
  // this package's dependencies. The dashboard used to start its own MCP endpoint beside itself; the
  // v2 server is composed per-caller by `agent-qa mcp` over the function registry, and a second
  // composition root for one surface is the private power the milestone abolishes.
  '@vostride/agent-qa-model',
  '@vostride/agent-qa-runner',
  '@vostride/agent-qa-runner-local',
  '@vostride/agent-qa-schema',
  '@vostride/agent-qa-web',
] as const

export const AGENT_QA_DASHBOARD_OWNERSHIP_CONTRACT = {
  packageName: AGENT_QA_DASHBOARD_PACKAGE_NAME,
  packageDir: AGENT_QA_DASHBOARD_PACKAGE_DIR,
  packageClasses: AGENT_QA_DASHBOARD_PACKAGE_CLASSES,
  allowedResponsibilities: AGENT_QA_DASHBOARD_ALLOWED_RESPONSIBILITIES,
  forbiddenResponsibilities: AGENT_QA_DASHBOARD_FORBIDDEN_RESPONSIBILITIES,
  externalDependencies: AGENT_QA_DASHBOARD_EXTERNAL_DEPENDENCIES,
  internalDependencies: AGENT_QA_DASHBOARD_INTERNAL_DEPENDENCIES,
} as const satisfies OwnershipContract
