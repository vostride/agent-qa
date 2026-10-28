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

/**
 * Suite run configuration — a types-only contract consumed by the CLI composition root.
 * The former `runSuite`/`executeSuiteMember` orchestration moved onto runner soil
 * (`runMemberTest`) in Phase 363; the CLI now composes per-member execution directly and
 * this interface only describes the shape it passes through. Field types that used to be
 * borrowed from the (deleted) `RunTestConfig` are inlined here so the module carries no
 * value dependency on the retired core run path.
 */
export interface RunSuiteConfig {
  runId?: string
  adapter: PlatformAdapter
  platformConfig: PlatformConfig
  planner: Planner
  verifier: Verifier
  cache?: ActionPlanCache
  /**
   * WM-01 run-scoped working-memory store (Phase 358). ONE store spans all suite member tests
   * (run-scoped, not test-scoped) and is threaded into each test's runner loop; the CLI flushes
   * it once at suite end.
   */
  workingMemory?: WorkingMemoryPort
  /**
   * D-14 storage-state store (Phase 360). ONE run-scoped store spans all suite member tests and is
   * threaded into each test's runner loop; the CLI constructs it at the composition root.
   */
  storageState?: StorageStatePort
  /**
   * D-08/Q10 screenshot compressor (Phase 363). ONE runner-local `SharpScreenshotCompressor`
   * constructed at the CLI composition root, threaded into each member's runner loop (sharp left
   * core). Absent ⇒ compressor-less loop.
   */
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
  /** Vision gate resolved once per run at the composition root (D-11); passed through to each test. */
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
