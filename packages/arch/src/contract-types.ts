export type PackageClass =
  | 'browserSafe'
  | 'providerNeutral'
  | 'storageNeutral'
  | 'storageImplementation'
  | 'modelOwner'
  | 'adapter'
  | 'surface'
  | 'util'
  | 'transitional'

export interface LedgerEntry {
  rule: PackageClass
  target: string
  clearedBy: string
  reason: string
}

export interface OwnershipContract {
  packageName: string
  packageDir: string
  packageClasses: readonly PackageClass[]
  allowedResponsibilities: readonly string[]
  forbiddenResponsibilities: readonly string[]
  externalDependencies: readonly string[]
  internalDependencies: readonly string[]
  // Its published build carries its external libraries, so they belong in devDependencies.
  publishesSelfContainedBundle?: boolean
  ledger?: readonly LedgerEntry[]
}

export const NATIVE_STORE_DENYLIST = [
  'playwright',
  'appium',
  'xcuitest',
  'webdriverio',
  'better-sqlite3',
  'sqlite',
  'sharp',
  'embedder',
  'transformers',
  'onnxruntime',
] as const satisfies readonly string[]

export const PROVIDER_SDK_FORBIDDEN_PREFIX = '@ai-sdk/'
export const PROVIDER_ORCHESTRATION_ALLOWED = 'ai'

export const PACKAGE_CLASS_RULES = {
  browserSafe: {
    allowed: ['importable from dashboard UI'],
    forbidden: ['node:*', ...NATIVE_STORE_DENYLIST],
  },
  providerNeutral: {
    allowed: [PROVIDER_ORCHESTRATION_ALLOWED],
    forbidden: [`${PROVIDER_SDK_FORBIDDEN_PREFIX}*`],
  },
  storageNeutral: {
    allowed: ['storage access through ports only'],
    forbidden: ['better-sqlite3', 'sharp', 'node:fs', 'fs', 'node:*'],
  },
  storageImplementation: {
    allowed: ['concrete store implementations', 'filesystem access', 'sqlite access'],
    forbidden: [],
  },
  modelOwner: {
    allowed: ['provider SDK adapters', PROVIDER_ORCHESTRATION_ALLOWED],
    forbidden: [],
  },
  adapter: {
    allowed: ['host-API platform driver implementing a port'],
    forbidden: [],
  },
  surface: {
    allowed: ['composition root with broad first-party imports and host/storage access'],
    forbidden: [],
  },
  util: {
    allowed: ['pure helper code with minimal dependencies'],
    forbidden: ['non-trivial dependencies', 'host access', 'storage access', 'provider access'],
  },
  transitional: {
    allowed: ['declared migration debt carried only by ledger entries'],
    forbidden: ['any class-rule violation not listed on the package ledger'],
  },
} as const satisfies Record<PackageClass, { allowed: readonly string[]; forbidden: readonly string[] }>
