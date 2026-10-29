import type { OwnershipContract } from './contract-types.js'

export const AGENT_QA_ARCH_OWNERSHIP_CONTRACT = {
  packageName: '@vostride/agent-qa-arch',
  packageDir: 'packages/arch',
  packageClasses: ['util'],
  allowedResponsibilities: [
    'internal architecture-as-code vocabulary + manifest aggregation; tooling-only, unpublished',
  ],
  forbiddenResponsibilities: [
    'shipping any symbol to the published npm surface',
    'runtime/host/storage/provider access',
  ],
  externalDependencies: [],
  internalDependencies: [],
} as const satisfies OwnershipContract
