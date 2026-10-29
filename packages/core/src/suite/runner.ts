import type {
  PlatformAdapter,
  PlatformConfig,
  RuntimeAuthStateConfig,
  Planner,
  Verifier,
  ActionPlanCache,
  HookDefinition,
  SandboxRunnerOptions,
  WorkingMemoryPort,
  StorageStatePort,
  ScreenshotCompressor,
  AccessibilityViolation,
  SecretRedactor,
  SecretStore,
} from '@vostride/agent-qa-runner'
import type { LanguageModel } from 'ai'
import type { LogManager } from '../logging/log-manager.js'

// Types only: the CLI composes per-member execution and passes this shape through.
export interface RunSuiteConfig {
  runId?: string
  adapter: PlatformAdapter
  platformConfig: PlatformConfig
  planner: Planner
  verifier: Verifier
  cache?: ActionPlanCache
  // One store spans every member of the run; the CLI flushes it once at suite end.
  workingMemory?: WorkingMemoryPort
  // One run-scoped store spans every member; the CLI builds it at the composition root.
  storageState?: StorageStatePort
  // One runner-local compressor built at the composition root; absent runs without compression.
  compressor?: ScreenshotCompressor
  plannerModel: LanguageModel
  verifierModel: LanguageModel
  captureScreenshots?: boolean
  timeouts?: { step?: number; test?: number; navigation?: number }
  logger?: LogManager
  configContent?: string
  suiteFileContent?: string
  envFileVars?: Record<string, string>
  inlineVars?: Record<string, string>
  cliVars?: Record<string, string>
  resolvedHooks?: Map<string, HookDefinition>
  sandboxOptions?: SandboxRunnerOptions
  logCapture?: { console?: boolean; network?: boolean }
  accessibility?: {
    enabled: boolean
    standard?: 'wcag2a' | 'wcag2aa' | 'wcag2aaa'
    runAfter?: 'every-step' | 'test-end'
    failOnViolation?: boolean
    disableRules?: string[]
    exclude?: string[]
  }
  accessibilityCheck?: (
    page: unknown,
    options: {
      standard?: 'wcag2a' | 'wcag2aa' | 'wcag2aaa'
      disableRules?: string[]
      exclude?: string[]
    },
  ) => Promise<AccessibilityViolation[]>
  vision?: { screenshotSize?: number; effectiveResolution?: number }
  /** Vision gate resolved once per run at the composition root; passed through to each test. */
  visionGate?: { attachImage: boolean; captureMode: 'full' | 'textOnly'; promptNote: string }
  product?: string
  createAdapter?: () => Promise<PlatformAdapter>
  resolveUrl?: (targetName: string) => string | undefined
  artifactContext?: Record<string, unknown>
  authStateCapture?: {
    capture: () => Promise<RuntimeAuthStateConfig>
    failureSummary: string
  }
  secretStore?: SecretStore
  secretRedactor?: SecretRedactor
}
