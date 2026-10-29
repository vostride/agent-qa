// The scaffold's CONTENT, shared by both write paths.
//
// ONE SOURCE OF TRUTH FOR SUBSTANCE, TWO WRITE PATHS SPLIT BY ACTOR. `agent-qa init` writes these
// bytes directly for a human who asked for them at a terminal; `config.project.scaffold` renders
// the SAME bytes as a `ConfigProposal` diff a person approves. D-04's claim is that the two
// scaffolds cannot drift, and the only way to make that a property of the code rather than a
// promise is for there to be one producer. The functions below were MOVED here out of `init.ts`
// and `init-filesystem.ts` rather than copied: there is no second copy left to drift from.
//
// PURE OVER ITS INPUTS. Nothing here reads `fs`, `process` or a clock. That is what lets the
// proposal path render the same content into file bytes without performing any of `init`'s
// filesystem machinery — preflight, atomic publish, marker-last ordering — which stays where it is
// because it is about WRITING, and writing is the half the two actors do differently.
//
// IT NAMES NO INTERNAL PACKAGE, AND THAT IS THE FUNC-02 FIREWALL RATHER THAN A PREFERENCE. The
// surface firewall's ledger "only ever SHRINKS: new surface code can never join it", so a file
// written today may not import `@vostride/agent-qa-core` or `@vostride/agent-qa-model` at all. The
// two host facts the config's defaults need — the cache directory and the auth-state directory —
// arrive as ARGUMENTS from the two callers that are ledgered for them, and the provider registry
// stays entirely on `init`'s side of the boundary: what this module receives is `llmEntries`, the
// already-resolved list, because "which providers exist" is a question about this machine and
// "what does a scaffolded config look like" is not.
//
// WHAT DELIBERATELY DID NOT MOVE: `TARGET_GITIGNORE_ENTRIES` (init-filesystem.ts) and
// `buildGitignoreEntries` (init.ts). Those two are a deliberate pair of literal copies pinned
// against each other by the runtime-versus-defaults agreement test, because `init-filesystem.js` is
// mocked wholesale by the init suite. Collapsing them onto one constant here would make that test
// compare a value against itself. This module owns the block's header line and takes the
// entries as an argument; markers, in-place splice and append are the shared managed-block
// writer's (`managed-block.ts`, 431 D-19).

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

/**
 * The `registry.targets` block.
 *
 * `targets` IS AN OVERRIDE RATHER THAN A DEFAULT SINCE 395-08. `init` scaffolds the two Komazon
 * example targets on the playground so a fresh project has something to run;
 * `config.project.scaffold` derives exactly ONE target from the utterance's domain and must not
 * carry init's example targets into a person's repository they never asked for. The parameter is
 * the difference between those two callers and nothing else about the config changes.
 */
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

/**
 * The host facts the config's defaults need, INJECTED.
 *
 * `llmEntries` IS ALREADY RESOLVED, and that is the whole of the boundary. Turning an
 * `InitLLMConfig` into a registry entry means asking the provider registry whether the provider
 * needs a base URL, and whether it is a subscription provider; both are questions about what this
 * machine has installed. `init` answers them and hands the answers over. The scaffold path answers
 * them by having no LLMs at all.
 */
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
      // THE MODEL HALF IS WRITTEN ONLY WHEN THERE IS A MODEL (432 D-20, #130). `init` always has
      // one; a scaffold given none writes neither key, rather than writing and then deleting them.
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

// the proposal writes no hook script, so its hooks file names none.
export function buildHooksFile(_platform: InitPlatformInput): string {
  return 'hooks: []\n'
}

// ---------------------------------------------------------------------------------------------
// The managed .gitignore block: the hash-comment variant of the shared writer.
// ---------------------------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------------------------
// The from-zero scaffold file set.
// ---------------------------------------------------------------------------------------------

export const SCAFFOLD_CONFIG_FILE = 'agent-qa.config.yaml'
export const SCAFFOLD_HOOKS_FILE = 'hooks.yaml'
export const SCAFFOLD_GITIGNORE_FILE = '.gitignore'

export interface ScaffoldContentInput {
  /** `services.cache.dir` — a host default the caller supplies (FUNC-02, see the file header). */
  readonly cacheDir: string
  /** `services.authState.dir` — same. */
  readonly authStatesDir: string
  /** The derived target name, e.g. `booking-com`. Deterministic host code produces it. */
  readonly targetName: string
  /** The derived base URL, e.g. `https://booking.com`. Same producer, same rule. */
  readonly baseUrl: string
  /** The managed block's rules, supplied by the caller — see this file's header. */
  readonly gitignoreEntries: readonly string[]
  /**
   * The model registry entries the from-zero config carries, already resolved (432 D-20, #130).
   * Absent or empty, the config has no model half at all. Merge mode ignores it: the person's own
   * `registry.llms` and `use.llm` are kept byte-for-byte by the one-entry insert.
   *
   * 2026-10-03 (quick 261003-cpv, 432 review IN-09): NO PRODUCTION CALLER PASSES IT. The scaffold
   * port's request carries a domain only, and from zero there is no configuration to read a model
   * from; inventing one is what D-13 forbids. `init` builds its config through `buildScaffoldConfig`
   * and does not reach this producer. So #130 is fixed for the merge half only, and a from-zero
   * scaffold stays bare. The seam is kept for a caller that has resolved entries to hand over.
   */
  readonly llmEntries?: readonly Record<string, unknown>[]
  /** `use.llm` for the from-zero config; defaults to the first entry's name. */
  readonly selectedLlm?: string
  /** What the project's `.gitignore` holds right now, or absent when it has none. */
  readonly existingGitignore?: string
  /**
   * MERGE MODE: the project's existing configuration, which declares no targets.
   *
   * ABSENT IS THE FROM-ZERO ROAD and it is byte-for-byte what it always was — the committed goldens
   * pin that, and they did not move when this field was added. Present, the producer inserts
   * exactly one `registry.targets` entry into these bytes and emits no other change to that file.
   */
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

/**
 * The person's own configuration with exactly ONE target entry inserted.
 *
 * `parseDocument` → `setIn` → `toString` IS THE SHIPPED IDIOM, and it is the same one
 * `agent-qa config set` and `createConfigFilesPort.setField` ride — chosen for the same
 * load-bearing reason rather than for style: a parse → object → stringify round trip destroys every
 * comment in a comment-dense config and widens the rendered diff past the point a person can review
 * it, which is the whole of what CFGM-01 asks a proposal to be.
 *
 * ONE `setIn` AND NOTHING ELSE. Not a merge of two documents, not a re-serialization, not a
 * normalization pass: one write at one path. Every other key, comment, blank line and ordering
 * decision in the file is the person's, and the proposal's diff is the insertion by construction
 * rather than by a filter applied afterwards.
 */
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

/**
 * The whole from-zero scaffold, as content (D-04's propose half · CFGM-05's one reviewable diff).
 *
 * THREE FILES AND EXACTLY THREE, and they are the three `enumerateConfigFileSet` answers: the
 * config yaml, the hooks file it names, and the `.gitignore` whose managed block this product
 * maintains. That is not a coincidence to be preserved by care — the apply's pathspec and the
 * classifier's `out-of-set-path` rule read that same enumeration, so a fourth file here would be
 * flagged cross-boundary on its own path and refused by an apply that could not scope to it.
 *
 * NO INVENTED LLM ENTRY, AND NONE DROPPED (D-13 · 432 D-20, #130). The utterance carried a domain;
 * it did not carry a provider, a model or an API base, so a scaffold given no model writes no
 * model half — `registry.llms` is optional and `use.llm` is only checked when present, so the
 * config validates. Entries a caller does hand over are written with a coherent `use.llm`, never
 * removed, and an inconsistent selection is left for schema validation to refuse. `init` is the
 * path that ASKS, and it passes its answers to `buildScaffoldConfig` directly; the scaffold port
 * hands this producer none.
 *
 * PLATFORM IS `web`, STATED. A hostname is a web origin; there is no mobile fact in a domain token.
 *
 * TWO MODES, ONE PRODUCER. With `existingConfig` present the config member is the
 * person's own bytes plus one inserted target entry, and the hooks file is rendered only when the
 * project has none — see `ScaffoldMergeTarget`. The `.gitignore` upsert is the same in both modes,
 * because it always was an upsert.
 */
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
