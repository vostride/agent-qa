// One pure producer of scaffold content for `init` and `config.project.scaffold`.

import { DEFAULT_PLANNER_LIMITS } from '@vostride/agent-qa-schema'
import { parseDocument, stringify } from 'yaml'

import {
  AGENT_QA_INIT_GITIGNORE_BLOCK,
  composeManagedBlock,
  type ManagedBlockContent,
} from './managed-block.js'

export const SUPPORTED_INIT_PLATFORMS = [
  'web',
  'android',
  'ios',
  'web+android',
  'web+ios',
] as const
export type Platform = (typeof SUPPORTED_INIT_PLATFORMS)[number]
export type PlatformCapability = 'web' | 'mobile'
export type MobileRuntime = 'android' | 'ios'
export type InitPlatformSelection = {
  capabilities: PlatformCapability[]
  mobileRuntimes: MobileRuntime[]
}
export type InitPlatformInput = Platform | InitPlatformSelection
export type InitLLMConfig = {
  name: string
  provider: string
  model: string
  baseURL?: string
}

export const SUBSCRIPTION_AUTH_PACKAGE = '@vostride/agent-qa-subscription-auth'
const DEFAULT_SCREENSHOT_SIZE = '256k'
const DEFAULT_EFFECTIVE_RESOLUTION = 768

export function parseInitPlatform(value: string): Platform {
  if ((SUPPORTED_INIT_PLATFORMS as readonly string[]).includes(value)) {
    return value as Platform
  }
  throw new Error(`Unsupported init platform "${value}"`)
}

export function normalizePlatformSelection(platform: InitPlatformInput): InitPlatformSelection {
  if (typeof platform !== 'string') {
    return {
      capabilities: [...new Set(platform.capabilities)],
      mobileRuntimes: [...new Set(platform.mobileRuntimes)],
    }
  }

  const selectedPlatform = parseInitPlatform(platform)
  switch (selectedPlatform) {
    case 'web':
      return { capabilities: ['web'], mobileRuntimes: [] }
    case 'android':
      return { capabilities: ['mobile'], mobileRuntimes: ['android'] }
    case 'ios':
      return { capabilities: ['mobile'], mobileRuntimes: ['ios'] }
    case 'web+android':
      return { capabilities: ['web', 'mobile'], mobileRuntimes: ['android'] }
    case 'web+ios':
      return { capabilities: ['web', 'mobile'], mobileRuntimes: ['ios'] }
    default: {
      const exhaustivePlatform: never = selectedPlatform
      throw new Error(`Unsupported init platform "${String(exhaustivePlatform)}"`)
    }
  }
}

export function hasWeb(platform: InitPlatformInput): boolean {
  return normalizePlatformSelection(platform).capabilities.includes('web')
}

export function hasMobile(platform: InitPlatformInput): boolean {
  return normalizePlatformSelection(platform).capabilities.includes('mobile')
}

// `targets` is an override: init passes example targets, the scaffold one derived target.
export function buildTargets(
  platform: InitPlatformInput,
  override?: Record<string, unknown>,
): Record<string, unknown> {
  if (override !== undefined) return override
  const selection = normalizePlatformSelection(platform)
  const targets: Record<string, unknown> = {}

  if (selection.capabilities.includes('web')) {
    targets.komazon = { platform: 'web', url: 'https://playground.vostride.dev/shop/' }
    targets['komazon-cart-total-bug'] = {
      platform: 'web',
      url: 'https://playground.vostride.dev/shop/?bug=cart-total',
    }
  }
  if (selection.mobileRuntimes.includes('android')) {
    targets['example-android'] = { platform: 'android' }
  }
  if (selection.mobileRuntimes.includes('ios')) {
    targets['example-ios'] = { platform: 'ios' }
  }

  return targets
}

// `llmEntries` arrives resolved, because provider needs are facts about this machine.
export interface ScaffoldConfigFacts {
  readonly llmEntries: readonly Record<string, unknown>[]
  /** `use.llm`. Defaults to the first entry's name; schema validation refuses one naming no entry. */
  readonly selectedLlm?: string
  readonly usesSubscriptionAuth: boolean
  /** `services.cache.dir`. A host default, so a host supplies it. */
  readonly cacheDir: string
  /** `services.authState.dir`. Same. */
  readonly authStatesDir: string
  /**
   * `registry.targets`, when the caller has its own.
   *
   * `init` scaffolds the two Komazon example targets so a fresh project has something to run;
   * `config.project.scaffold` derives exactly ONE from the utterance's domain and must not carry
   * init's example targets into a repository nobody asked to have them in.
   */
  readonly targets?: Record<string, unknown>
}

export function buildScaffoldConfig(
  platform: InitPlatformInput,
  facts: ScaffoldConfigFacts,
): Record<string, unknown> {
  const config: Record<string, unknown> = {
    workspace: {
      testMatch: ['tests/**/*.yaml'],
      suiteMatch: ['suites/**/*.suite.yaml'],
      hooksFile: 'hooks.yaml',
      envFile: '.env',
      secretsFile: '.env.secrets.local',
    },
    services: {
      dashboard: { port: 3100, artifactsDir: '.agent-qa/artifacts' },
      cache: { dir: facts.cacheDir },
      authState: { dir: facts.authStatesDir },
      vision: { screenshotSize: DEFAULT_SCREENSHOT_SIZE, effectiveResolution: DEFAULT_EFFECTIVE_RESOLUTION },
      ...(hasWeb(platform)
        ? {
            accessibility: {
              enabled: true,
              standard: 'wcag2aa',
              runAfter: 'test-end',
              failOnViolation: false,
            },
          }
        : {}),
      recording: { enabled: true },
      logging: { level: 'warn' },
    },
    registry: {
      // The model half is written only when there is a model; with none, neither key is written.
      ...(facts.llmEntries.length === 0 ? {} : { llms: [...facts.llmEntries] }),
      targets: buildTargets(platform, facts.targets),
    },
    ...(facts.usesSubscriptionAuth
      ? {
          plugins: {
            auth: [{ package: SUBSCRIPTION_AUTH_PACKAGE }],
          },
        }
      : {}),
    use: {
      ...(hasWeb(platform) ? { browser: { name: 'chromium', headless: true, viewport: { width: 1280, height: 720 } } } : {}),
      ...(hasMobile(platform) ? { mobile: { appState: 'preserve' } } : {}),
      timeout: { step: '20m', test: '90m', navigation: '2m' },
      planner: {
        maxActions: DEFAULT_PLANNER_LIMITS.maxActions,
        maxPlanningTurns: DEFAULT_PLANNER_LIMITS.maxPlanningTurns,
        previousStepCount: 5,
      },
      logCapture: { console: true, network: true },
      parallel: false,
      ...(facts.llmEntries.length === 0
        ? {}
        : { llm: facts.selectedLlm ?? (facts.llmEntries[0]?.name as string | undefined) ?? 'default' }),
    },
  }

  return config
}

export function addYamlComments(yamlStr: string): string {
  let result = '# agent-qa Configuration\n\n'

  const lines = yamlStr.split('\n')
  for (const line of lines) {
    if (line.startsWith('workspace:')) {
      result += '# File discovery and project settings\n'
    } else if (line.startsWith('services:')) {
      result += '\n# Infrastructure services (dashboard, cache, auth state, logging)\n'
    } else if (line.startsWith('registry:')) {
      result += '\n# Committed knowledge root (optional block; these defaults apply when absent)\n'
      result += '# knowledge:\n'
      result += '#   dir: agent-qa-knowledge\n'
      result += '\n# Named resource definitions (LLM configs, app targets)\n'
    } else if (line.startsWith('plugins:')) {
      result += '\n# Optional subscription auth plugin declarations\n'
    } else if (line.startsWith('use:')) {
      result += '\n# Execution settings (cascades: global -> suite -> test -> CLI flags)\n'
    } else if (line === '  accessibility:') {
      result +=
        "  # Accessibility checks run once at the end of each test; results show in the dashboard's run detail.\n"
    } else if (line === '  planner:') {
      result += '  # Per-step limits: maxActions (actions) and maxPlanningTurns (planner calls); a step that needs more stops with the limit reason\n'
    } else if (line === '  authState:' && !yamlStr.includes('\n  accessibility:\n')) {
      result += '  # Optional accessibility service example:\n'
      result += '  # accessibility:\n'
      result += '  #   enabled: false\n'
      result += '  #   standard: wcag2aa\n'
    }
    result += line + '\n'

    if (line === '  secretsFile: .env.secrets.local') {
      result += '  # Its values are shown as [secret:<name>] and never restored; nothing else is masked.\n'
      result += '# Optional: ignore archived or generated tests.\n'
      result += '  # testPathIgnore:\n'
      result += '  #   - tests/archive/**/*.yaml\n'
    } else if (line === '    artifactsDir: .agent-qa/artifacts') {
      result += '    # Optional: persist dashboard state to a custom SQLite path.\n'
      result += '    # dbPath: .agent-qa/dashboard.sqlite\n'
    } else if (line === 'registry:') {
      result += '  # Optional: local device profiles.\n'
      result += '  # devices:\n'
      result += '  #   android-emu:\n'
      result += '  #     platform: android\n'
    } else if (line === '  targets:') {
      result += '    # Optional: add more web or mobile targets here.\n'
      result += '    # my-mobile:\n'
      result += '    #   platform: android\n'
      result += '    #   appPackage: com.example.app\n'
      result += '    #   appActivity: .MainActivity\n'
      result += '    #   app:\n'
      result += '    #     path: apps/example.apk\n'
    } else if (line === '  llm: codex' || line === '  llm: claude-code' || line === '  llm: default') {
      result += '  # Optional: bind mobile runs to a configured device profile.\n'
      result += '  # device: android-emu\n'
    }
  }

  return result
}

/** The config yaml as a file's bytes-to-be: serialize, then re-attach the house comments. */
export function renderScaffoldConfigYaml(config: Record<string, unknown>): string {
  return addYamlComments(stringify(config))
}

// The proposal writes no hook script, so its hooks file names none.
export function buildHooksFile(_platform: InitPlatformInput): string {
  return 'hooks: []\n'
}

// The managed `.gitignore` block: the hash-comment variant of the shared writer.

export function managedGitignoreContent(entries: readonly string[]): ManagedBlockContent {
  return {
    descriptor: AGENT_QA_INIT_GITIGNORE_BLOCK,
    body: [
      '# Runtime, credential, dependency, and local-only paths managed by agent-qa init.',
      ...entries,
    ],
    target: 'target .gitignore',
  }
}

/**
 * The upsert, as CONTENT: what a `.gitignore` holding `existing` should hold afterwards.
 *
 * THE WHOLE UPSERT AND NOT MERELY THE BLOCK, which is what makes the scaffold proposal's diff
 * compose with a `.gitignore` a project already has. `upsertManagedGitignoreBlock` performs this
 * same composition and then writes it; the scaffold path performs it and then proposes it.
 */
export function composeManagedGitignore(
  existing: string,
  entries: readonly string[],
): string {
  return composeManagedBlock(existing, managedGitignoreContent(entries))
}

// The from-zero scaffold file set.

export const SCAFFOLD_CONFIG_FILE = 'agent-qa.config.yaml'
export const SCAFFOLD_HOOKS_FILE = 'hooks.yaml'
export const SCAFFOLD_GITIGNORE_FILE = '.gitignore'

export interface ScaffoldContentInput {
  // `services.cache.dir`, a host default the caller supplies.
  readonly cacheDir: string
  /** `services.authState.dir` — same. */
  readonly authStatesDir: string
  /** The derived target name, e.g. `booking-com`. Deterministic host code produces it. */
  readonly targetName: string
  /** The derived base URL, e.g. `https://booking.com`. Same producer, same rule. */
  readonly baseUrl: string
  /** The managed block's rules, supplied by the caller — see this file's header. */
  readonly gitignoreEntries: readonly string[]
  // Already-resolved model entries; absent or empty, the from-zero config has no model half.
  readonly llmEntries?: readonly Record<string, unknown>[]
  /** `use.llm` for the from-zero config; defaults to the first entry's name. */
  readonly selectedLlm?: string
  /** What the project's `.gitignore` holds right now, or absent when it has none. */
  readonly existingGitignore?: string
  // Merge mode: absent is the from-zero road; present, exactly one target entry is inserted.
  readonly existingConfig?: ScaffoldMergeTarget
}

/** Where the merge writes, and where its siblings belong beside a configuration that exists. */
export interface ScaffoldMergeTarget {
  /** The config member's own path — never assumed to be `agent-qa.config.yaml`. */
  readonly path: string
  readonly text: string
  /** Where a hooks file belongs — the name `workspace.hooksFile` declares. */
  readonly hooksPath: string
  /** True when that file already exists, in which case NO hooks content is rendered at all. */
  readonly hooksPresent: boolean
}

// One `setIn` on the parsed document, because a parse and stringify round trip destroys comments.
export function mergeScaffoldTargetEntry(input: {
  readonly existingText: string
  readonly targetName: string
  readonly baseUrl: string
}): string {
  const document = parseDocument(input.existingText)
  document.setIn(
    ['registry', 'targets', input.targetName],
    { platform: 'web', url: input.baseUrl },
  )
  return document.toString()
}

export interface ScaffoldContentFile {
  /** Workspace-relative. */
  readonly path: string
  readonly text: string
}

// Exactly the files `enumerateConfigFileSet` names; any other path is refused by the apply.
export function buildScaffoldFileSet(input: ScaffoldContentInput): readonly ScaffoldContentFile[] {
  const gitignore: ScaffoldContentFile = {
    path: SCAFFOLD_GITIGNORE_FILE,
    text: composeManagedGitignore(input.existingGitignore ?? '', input.gitignoreEntries),
  }

  if (input.existingConfig !== undefined) {
    const merge = input.existingConfig
    return [
      {
        path: merge.path,
        text: mergeScaffoldTargetEntry({
          existingText: merge.text,
          targetName: input.targetName,
          baseUrl: input.baseUrl,
        }),
      },
      // A HOOKS FILE A PERSON WROTE IS NOT A MEMBER OF THIS ANSWER. The template is content for a
      // project that has none; composing it over theirs would be the wholesale overwrite the
      // target-registry narrowing just stopped this op making, one file over.
      ...(merge.hooksPresent ? [] : [{ path: merge.hooksPath, text: buildHooksFile('web') }]),
      gitignore,
    ]
  }

  const config = buildScaffoldConfig('web', {
    llmEntries: input.llmEntries ?? [],
    ...(input.selectedLlm === undefined ? {} : { selectedLlm: input.selectedLlm }),
    usesSubscriptionAuth: false,
    cacheDir: input.cacheDir,
    authStatesDir: input.authStatesDir,
    targets: { [input.targetName]: { platform: 'web', url: input.baseUrl } },
  })

  return [
    { path: SCAFFOLD_CONFIG_FILE, text: renderScaffoldConfigYaml(config) },
    { path: SCAFFOLD_HOOKS_FILE, text: buildHooksFile('web') },
    gitignore,
  ]
}
