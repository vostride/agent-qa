import { Command, Option } from 'commander'
import { readFileSync } from 'node:fs'
import { basename, dirname, join, relative, sep } from 'node:path'
import { stripVTControlCharacters } from 'node:util'
import pc from 'picocolors'
import type { Readable, Writable } from 'node:stream'
import { parse as parseYaml } from 'yaml'
import {
  DEFAULT_AGENT_QA_AUTH_STATES_DIR,
  DEFAULT_AGENT_QA_CACHE_DIR,
  getAuthPath,
  listSavedCredentials,
} from '@vostride/agent-qa-core'
import { guardJsonText, reserveStdoutForData } from '@vostride/agent-qa-core/run-text-output'
import { getProvider } from '@vostride/agent-qa-model'
// The scaffold's content comes from the shared producer, so the two scaffolds cannot drift.
import {
  SUBSCRIPTION_AUTH_PACKAGE,
  buildHooksFile,
  buildGitignoreEntries,
  buildScaffoldConfig,
  hasWeb,
  normalizePlatformSelection,
  parseInitPlatformList,
  renderScaffoldConfigYaml,
  type InitLLMConfig,
  type InitPlatformInput,
  type MobileRuntime,
  type PlatformCapability,
} from './scaffold-content.js'
// Type-only here and the value loaded lazily: the analytics graph breaks `init.test.ts`'s fs mock.
import type { composeAnalyticsHost as ComposeAnalyticsHost } from '../composition/analytics-host.js'
import {
  KNOWLEDGE_GITIGNORE_PROBES,
  TARGET_GITIGNORE_PROBES,
  classifyInitPath,
  preflightInitPlan,
  upsertManagedGitignoreBlock,
  verifyEffectiveGitignore,
  writeConfigMarkerLast,
  writeScaffoldFileAtomic,
  type InitFileResult,
  type InitPathPlan,
} from './init-filesystem.js'
import { buildKnowledgeAgentGuide } from './knowledge-guide.js'
import { resolveIsCI } from '../ci-env.js'
import { CliRefusal, PromptCancelled, isPromptCancel } from '../composition/cli-refusal.js'
import { createClackUi, type ClackUi } from '../init-ui/clack-ui.js'
import { initUiMode, type InitSection, type InitUi } from '../init-ui/init-ui.js'
import { brandPalette, colorLevelFor } from '../init-ui/palette.js'
import { createPlainUi } from '../init-ui/plain-ui.js'
import {
  classifyBackground,
  probeTerminalBackground,
  processTerminalPort,
  type TerminalPort,
} from '../init-ui/terminal-background.js'
import { isInitRefusal } from './init-refusal.js'
import {
  defaultInitFolderIo,
  initFolderOptionRefusal,
  initFolderRefusal,
} from './init-project-folder.js'
import {
  installedAgentQaVersion,
  parsePackageJson,
  planPackageJson,
  projectDependencies,
  readProjectPackageJson,
  sanitizedPackageName,
  type PackageJsonPlan,
} from './package-json-plan.js'
import {
  AGENT_SKILL_ROOTS,
  installAgentSetup,
  type AgentSetupFileResult,
} from './agent-setup.js'
import type { CodingAgent } from './agent-setup-manifest.js'
import { INIT_AGENT_OPTIONS, detectCodingAgents, parseInitAgentsFlag } from './init-agents.js'
import {
  INIT_MODEL_CHOICES,
  initModelSections,
  modelEntryFor,
  modelStatus,
  preselectedModel,
  resolveLlmFlag,
  type InitModelPick,
} from './init-model-choice.js'
import { DASHBOARD_COMMAND, initNextSteps, nextStepLines } from './init-next-steps.js'
import {
  DASHBOARD_HOST,
  dashboardPage,
  dashboardPortOf,
  findFreePort,
  portInUse,
  probeDashboardPort,
  runDashboardStep,
  type DashboardPort,
} from './init-dashboard.js'
import {
  INTERRUPTED,
  NOT_RUN,
  createInitStepRunner,
  freshInitPlan,
  type InitStepName,
  type InitStepRecord,
  type InitStepResult,
  type InitStepRunner,
} from './init-steps.js'
import { runInitRerun } from './init-rerun.js'
import { askLatestVersionByDefault, type LatestVersionAsk } from './latest-version-ask.js'
import { findChromiumByDefault, type ChromiumResolver } from './browser-resolver.js'
import {
  createInitDocumentRecorder,
  refusedInitDocument,
  writeInitDocument,
  type InitDocument,
} from './init-document.js'
import {
  installOutputMask,
  runInstallStep,
  shownOutput,
  type InstallStepResult,
} from './package-install.js'
import { detectPackageManager, wasCancelled } from './package-manager.js'
import {
  agentQaAfterInstall,
  declaredAgentQaVersion,
  findProjectAgentQa,
  handOffToProjectAgentQa,
  runAgentQaStep,
  runRunningAgentQa,
} from './project-agent-qa.js'
import { projectHost, type ProjectHost, type RunResult } from './project-host.js'
import { nearestInstalledPackage, projectRange } from './project-range.js'

// Re-exported because this module is their public door.
export { SUPPORTED_INIT_PLATFORMS, parseInitPlatform } from './scaffold-content.js'

// `scaffold-content.ts` may not name `@vostride/agent-qa-core`, so the defaults are resolved here.
const INIT_CACHE_DIR = DEFAULT_AGENT_QA_CACHE_DIR || '.agent-qa/cache'
const INIT_AUTH_STATES_DIR = DEFAULT_AGENT_QA_AUTH_STATES_DIR || '.agent-qa/auth-states'

const DEFAULT_CONFIG_FILE_NAME = 'agent-qa.config.yaml'

function isSubscriptionProvider(provider: string): boolean {
  return getProvider(provider)?.subscription === true
}

// `needsBaseURL` and `subscription` are facts about this machine, so they stay on this side.
function toLLMEntry(config: InitLLMConfig): Record<string, unknown> {
  const llmEntry: Record<string, unknown> = {
    name: config.name,
    provider: config.provider,
    model: config.model,
  }

  if (getProvider(config.provider)?.needsBaseURL) {
    llmEntry.baseURL = config.baseURL
  }

  return llmEntry
}

function buildSingleLLMConfig(provider: string, model: string, baseURL?: string): InitLLMConfig {
  return { name: 'default', provider, model, baseURL }
}

// The interactive scaffold's config, the same shape `config.project.scaffold` renders.
export function buildDefaultConfig(
  platform: InitPlatformInput,
  providerOrLLMs: string | InitLLMConfig[],
  model?: string,
  baseURL?: string,
): Record<string, unknown> {
  const llmConfigs = Array.isArray(providerOrLLMs)
    ? providerOrLLMs
    : [buildSingleLLMConfig(providerOrLLMs, model ?? 'model-name', baseURL)]

  return buildScaffoldConfig(platform, {
    llmEntries: llmConfigs.map(toLLMEntry),
    usesSubscriptionAuth: llmConfigs.some(config => isSubscriptionProvider(config.provider)),
    cacheDir: INIT_CACHE_DIR,
    authStatesDir: INIT_AUTH_STATES_DIR,
  })
}
const KOMAZON_CHECKOUT_TEST_ID = 't_packer-staff-asha-lak-spill-usher-pele-allen-bid-done'
const KOMAZON_CART_TOTAL_BUG_TEST_ID = 't_reduce-eva-elding-reset-lai-iban-rum-hin-parent-chang'
const EXAMPLES_SUITE_ID = 's_dice-ego-veer-warp-ionic-trying-tur-cal-stride-battle'
const KOMAZON_CHECKOUT_PATH = 'tests/examples/komazon-checkout.yaml'
const KOMAZON_CART_TOTAL_BUG_PATH = 'tests/examples/komazon-cart-total-bug.yaml'
const EXAMPLES_SUITE_PATH = 'suites/examples.suite.yaml'
const GETTING_STARTED_URL = 'https://vostride.com/docs/agent-qa/quickstart'
const KOMAZON_SHIPPING_HOOK_TEST_ID = 't_ayin-dual-chunk-lou-tablet-ticket-brace-lak-kite-abu'
const SHIPPING_ADDRESS_HOOK_ID = 'h_phi-arts-vis-band-aira-streng-twig-roi-mino-fold'
const KOMAZON_SHIPPING_HOOK_PATH = 'tests/examples/komazon-shipping-hook.yaml'
const SHIPPING_ADDRESS_SCRIPT_PATH = 'scripts/examples/make-shipping-address.mjs'

// Every run starts a fresh session, so the journey asks for no reset.
function buildKomazonCheckoutTest(): string {
  return `test-id: ${KOMAZON_CHECKOUT_TEST_ID}
name: Komazon checkout journey
target: komazon
steps:
  - Add Everyday Ceramic Mug to the bag, then open the shopping bag and verify it holds one Everyday Ceramic Mug.
  - Continue to checkout. Sign in with email alex@example.com and password {{secret:KOMAZON_PASSWORD}}, then verify the shipping step is shown.
  - Enter street address 24 Cedar Lane, city Portland and postal code 97205. Continue to delivery.
  - Select Express delivery and continue with Review order. Verify the review shows one Everyday Ceramic Mug, the entered address, Express delivery and a total of $36.00.
  - Place the order using Place order · $36.00. Verify Order confirmed and that the bag is empty.
  - Open View orders. Verify Order FW-1001 contains one Everyday Ceramic Mug and the $36.00 total.
`
}

// A suite replaces a member's target, so the bug URL is a step.
function buildKomazonCartTotalBugTest(): string {
  return `test-id: ${KOMAZON_CART_TOTAL_BUG_TEST_ID}
name: Komazon cart total (fails on the deliberate cart-total bug)
target: komazon-cart-total-bug
steps:
  - Navigate to https://playground.vostride.dev/shop/?bug=cart-total
  - Add Everyday Ceramic Mug to the bag, open the shopping bag, and increase that product's quantity to two.
  - Verify the bag contains exactly two Everyday Ceramic Mugs and the order total is $53.00.
`
}

function buildExamplesSuite(): string {
  return `suite-id: ${EXAMPLES_SUITE_ID}
name: Komazon examples
target: komazon
tests:
  - test: ${KOMAZON_CHECKOUT_PATH}
    id: ${KOMAZON_CHECKOUT_TEST_ID}
  - test: ${KOMAZON_CART_TOTAL_BUG_PATH}
    id: ${KOMAZON_CART_TOTAL_BUG_TEST_ID}
`
}

// Web init's own hooks file; the proposal keeps `hooks: []`.
function buildExampleHooksFile(): string {
  return `hooks:
  - id: ${SHIPPING_ADDRESS_HOOK_ID}
    name: Make a shipping address
    runtime: node
    file: ${SHIPPING_ADDRESS_SCRIPT_PATH}
    timeout: 30s
    network: false
`
}

function buildShippingAddressScript(): string {
  return `// Runs before the test with no network and writes SHIPPING_ADDRESS for {{env:SHIPPING_ADDRESS}}.
import { writeFile } from 'node:fs/promises'
import { randomInt } from 'node:crypto'

const address = \`\${randomInt(100, 1000)} Cedar Lane\`
await writeFile('/tmp/agent-qa.env', \`SHIPPING_ADDRESS="\${address}"\\n\`, 'utf-8')
`
}

// Every run starts a fresh session, so the sample asks for no reset.
function buildKomazonShippingHookTest(): string {
  return `test-id: ${KOMAZON_SHIPPING_HOOK_TEST_ID}
name: Komazon checkout with a shipping address from a hook
target: komazon
setup:
  - ${SHIPPING_ADDRESS_HOOK_ID}
use:
  cache: false
steps:
  - Add Everyday Ceramic Mug to the bag, then open the shopping bag and verify it holds one Everyday Ceramic Mug.
  - Continue to checkout. Sign in with email alex@example.com and password {{secret:KOMAZON_PASSWORD}}, then verify the shipping step is shown.
  - Type {{env:SHIPPING_ADDRESS}} into the Street address field, enter city Portland and postal code 97205, then continue to delivery.
  - Select Express delivery and continue with Review order. Verify the review shows {{env:SHIPPING_ADDRESS}} as the street address.
`
}

const DEFAULT_HOOKS_FILE = 'hooks.yaml'
const DEFAULT_ENV_FILE = '.env'
const DEFAULT_SECRETS_FILE = '.env.secrets.local'
const SECRETS_FILE_MODE = 0o600
export const EXAMPLE_SECRET_LINE = 'KOMAZON_PASSWORD=komazon123'

// Applied only when init creates the file (`preserveOnForce`).
function buildSecretsFile(platform: InitPlatformInput): string {
  if (!hasWeb(platform)) return ''
  return "# The Komazon playground's public demo password (printed on its sign-in page); "
    + 'the examples type it as {{secret:KOMAZON_PASSWORD}}.\n'
    + `${EXAMPLE_SECRET_LINE}\n`
}

const KNOWLEDGE_ROOT_DIR = 'agent-qa-knowledge'
// The committed/derived split every knowledge writer relies on (knowledge-store.md §4),
// plus one init-tool operational rule that is NOT part of that split — see below.
const KNOWLEDGE_GITIGNORE_FUNCTIONAL_LINES = [
  'memory/index/',
  'memory/queue/',
  'memory/*/bundles/.staging/',
  '.lease',
  '.epoch',
  '.writer-authority.sqlite*',
  '**/artifacts/',
  'skills/.staging/',
  '.*.agent-qa-init-*.tmp',
] as const

// Verbatim from spec/v2/knowledge-store.md §4, except the labelled rule for publish temporaries.
function buildKnowledgeGitignore(): string {
  return `# agent-qa-knowledge/.gitignore
memory/index/
memory/queue/
memory/*/bundles/.staging/
.lease
.epoch
.writer-authority.sqlite*
# binary blobs; artifact inventories are committed and live OUTSIDE artifacts/
**/artifacts/
skills/.staging/
# INIT-TOOL OPERATIONAL — outside the committed/derived split above. agent-qa init publishes
# every file through a temporary sibling that carries the destination's own content; this
# keeps that temporary out of a commit even when this tree is its own repository.
.*.agent-qa-init-*.tmp
`
}

// Comment-only: an active rule would be prompt bytes on every run; HTML comments are stripped.
function buildGlobalPolicyTemplate(): string {
  return `<!--
agent-qa policies — global scope

Write one rule per line, in plain imperative English. Every active (non-comment)
line in this file becomes a QA rule the agent follows.

Example (inactive — it lives inside this comment):
Always dismiss the cookie banner before asserting page content

Scoping: this file is the global scope. Add sibling files named <product>.md
next to it for product-scoped rules.

Sovereignty: policies are human-asserted and win every conflict. agent-qa serves
every active line here to the planner verbatim on every run, never summarized,
so keep rules few and deliberate. A long file draws a warning; it is never cut.

agent-qa strips HTML comments before serving, so a comment-only file like this
one is an empty policy. Comments cannot nest: close one before opening another.
Add rules below this comment block to activate them.
-->
`
}

// The human entry point for the knowledge root; it states the guide's rule for changing knowledge.
export function buildKnowledgeReadme(): string {
  return `# agent-qa-knowledge

The committed knowledge root for this project's QA agent. Everything the agent
learns and everything you author for it lives under this one directory.

## Two shelves

- **Learned shelf** (\`memory/\`, created by the first record write): durable
  records the agent distills from runs — facts, cautions, selectors, flows.
  Each record is a self-sufficient bundle directory: the fact, its evidence,
  and its provenance travel together.
- **Authored shelf** (\`policies/\` now; \`skills/\` arrives with its feature):
  content people write — QA rules, agent skills.

Only \`policies/\` exists after init; the other directories are created on
first use.

## How to read a knowledge change

- \`record.md\` is the fact: what the agent now believes, in plain prose.
- \`evidence/outcomes.jsonl\` is the evidence: the append-only outcome log the
  belief rests on.
- Trust is derived by code from the outcome log.

## Changing knowledge

Never edit the learned shelf by hand — not the fact, the evidence, trust
counters or status fields. Learned knowledge changes only through agent-qa: a
run mark, or \`agent_qa_change_knowledge\` to accept, reject or forget a
record. Each change applies at once and shows up here. Wrong knowledge is
corrected by new feedback (a run mark) or by forgetting the record. The one
shelf people write by hand is \`policies/\` (below).

## Committed vs. gitignored

\`git diff\` shows exactly what the agent learned. The \`.gitignore\` in this
directory enforces the split:

- \`memory/index/\` — derived search index; rebuildable from records, never committed.
- \`memory/queue/\`, \`.lease\`, \`.epoch\` — machine-local curation runtime state.
- \`.writer-authority.sqlite*\` — the local writer-authority database and its -wal/-shm/-journal files.
- \`memory/*/bundles/.staging/\` — a bundle being published; present only if a publish was interrupted.
- \`**/artifacts/\` — binary blobs (screenshots, DOM snapshots, HAR). Excluded
  from git by default; artifact *inventories* are text, live outside
  \`artifacts/\`, and are committed.
- \`skills/.staging/\` — machine-local scratch space for skill writes, never committed.

Everything else — every \`*.md\` and \`*.json\`/\`*.jsonl\` of distilled or
authored text — is committed, so \`git diff\` and \`git log\` show it.

## How to write policies

QA rules live in \`policies/\` as plain markdown — one rule per line, in
imperative English. Start with \`policies/global.md\` (its header comment
teaches the format); add \`policies/<product>.md\` siblings for product-scoped
rules. Policies are sovereign: served to the agent verbatim on every run.

## Reading knowledge

\`AGENTS.md\` in this directory lists the agent-qa commands and MCP tools that
answer questions about runs and records. Answer from them rather than from a raw
\`record.md\`: trust, validity and supersession are worked out when you ask.
`
}

function trimGitignoreTrailingWhitespace(line: string): string {
  let end = line.length
  while (end > 0 && (line[end - 1] === ' ' || line[end - 1] === '\t')) {
    let precedingBackslashes = 0
    for (let index = end - 2; index >= 0 && line[index] === '\\'; index -= 1) {
      precedingBackslashes += 1
    }
    if (precedingBackslashes % 2 === 1) break
    end -= 1
  }
  return line.slice(0, end)
}

function knowledgeGitignoreFunctionalLines(content: string): Set<string> {
  return new Set(
    content
      .split(/\r?\n/)
      .map(trimGitignoreTrailingWhitespace)
      .filter(line => line.length > 0 && !line.startsWith('#')),
  )
}

function warnForMissingKnowledgeGitignoreRules(path: string): void {
  const existingLines = knowledgeGitignoreFunctionalLines(readFileSync(path, 'utf-8'))
  for (const requiredLine of KNOWLEDGE_GITIGNORE_FUNCTIONAL_LINES) {
    if (existingLines.has(requiredLine)) continue
    console.warn(pc.yellow(
      `⚠ ${path} is missing the required line "${requiredLine}" — `
      + 'add it manually to keep the committed/derived split intact.',
    ))
  }
}

function configuredLlms(config: Record<string, unknown>): InitLLMConfig[] {
  const registry = config.registry as Record<string, unknown> | undefined
  return (registry?.llms ?? []) as InitLLMConfig[]
}

function usesSubscriptionModel(config: Record<string, unknown>): boolean {
  return configuredLlms(config).some(llm => isSubscriptionProvider(String(llm.provider)))
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

// The packages an upgrade bumps, read from the config as written; one that does not parse names
// agent-qa alone.
function configuredPackages(text: string | undefined): {
  usesSubscription: boolean
  plugins: readonly { package?: unknown }[]
} {
  let config: Record<string, unknown> | undefined
  try {
    config = asObject(parseYaml(text ?? '', { logLevel: 'error' }))
  } catch {
    config = undefined
  }
  const llms = asObject(config?.registry)?.llms
  const plugins = config?.plugins
  return {
    usesSubscription:
      Array.isArray(llms) &&
      llms.some(llm => isSubscriptionProvider(String(asObject(llm)?.provider))),
    plugins: Array.isArray(plugins)
      ? plugins.flatMap((plugin: unknown): Record<string, unknown>[] => {
        const entry = asObject(plugin)
        return entry === undefined ? [] : [entry]
      })
      : [],
  }
}

// A refusal exits 2 with its message alone; a bug or a prompt cancel passes through unchanged.
function asInitRefusal(error: unknown): unknown {
  if (error instanceof CliRefusal) return error
  if (isInitRefusal(error)) {
    return new CliRefusal([pc.red(error.message)], 2, { cause: error })
  }
  return error
}

export interface InitCommandHooks {
  afterWrite?: (result: InitFileResult, boundary: number) => void
  onComplete?: (outcomes: readonly InitFileResult[]) => void
  // A seam so a suite observes the one event without touching a home directory.
  composeAnalytics?: typeof ComposeAnalyticsHost
  // Sets both stdinIsTTY and stdoutIsTTY.
  isTTY?: boolean
  stdinIsTTY?: boolean
  stdoutIsTTY?: boolean
  terminal?: TerminalPort
  rail?: InitRail
  cwd?: string
  host?: Partial<ProjectHost>
  ui?: InitUi
  // Probes the dashboard's port; the default binds it on loopback and lets it go.
  dashboardPort?: DashboardPort
  chromium?: ChromiumResolver
  // The re-run's latest agent-qa; the default asks the npm registry under a short deadline.
  latestVersion?: LatestVersionAsk
}

// The streams the Clack rail reads and draws on: stdin and stderr in production.
export interface InitRail {
  input: Readable
  output: Writable & { isTTY?: boolean; columns?: number }
}

const PLATFORM_CHOICES = [
  { value: 'web', label: 'Web', hint: 'Playwright' },
  { value: 'mobile', label: 'Mobile', hint: 'Appium: Android and iOS' },
] as const satisfies readonly { value: PlatformCapability; label: string; hint: string }[]

// A drawn question finds its initial option by identity, so the pre-selected pick is matched to it.
function optionFor(
  sections: readonly InitSection<InitModelPick>[],
  pick: InitModelPick,
): InitModelPick {
  const options = sections.flatMap((section) => section.options)
  const same = options.find(({ value }) =>
    value.kind === 'new'
      ? pick.kind === 'new' && value.choice === pick.choice
      : pick.kind === 'saved' && value.name === pick.name,
  )
  return (same ?? options[0]!).value
}

const CHROMIUM_COMMAND = 'npx agent-qa install-browsers --chromium'
const CHROMIUM_ATTEMPTS = 2
const SKILLS_COMMAND = 'npx agent-qa init'
const VALIDATE_COMMAND = 'npx agent-qa validate'

// validate prints the file's path first, so its first error line, without the position, says why.
function validateReason(lines: readonly string[]): string | undefined {
  const error = lines.find((line) => /\berror\b/iu.test(line))
  const line = (error ?? lines[0])?.trim()
  return line?.replace(/^\d+:\d+\s+error\s+/u, '').replace(/\s+/gu, ' ')
}

function agentNames(agents: readonly CodingAgent[]): string {
  return agents
    .map((agent) => INIT_AGENT_OPTIONS.find((option) => option.value === agent)?.label ?? agent)
    .join(' and ')
}

// The skill folders the chosen agents hold now, counted once across agents.
function skillCount(
  files: readonly AgentSetupFileResult[],
  agents: readonly CodingAgent[],
): number {
  const folders = new Set<string>()
  for (const file of files) {
    if (file.outcome === 'removed' || file.outcome === 'kept') continue
    for (const agent of agents) {
      const root = `${AGENT_SKILL_ROOTS[agent]}/`
      if (!file.path.startsWith(root)) continue
      const folder = file.path.slice(root.length).split('/')[0]
      if (folder !== undefined && folder !== '') folders.add(folder)
    }
  }
  return folders.size
}

function scaffoldFilePlan(
  root: string,
  path: string,
  content: string,
  force: boolean,
  preserveOnForce = false,
  mode?: number,
): InitPathPlan {
  return {
    root,
    path: join(root, path),
    content,
    force,
    preserveOnForce,
    ...(mode === undefined ? {} : { mode }),
  }
}

function buildScaffoldFilePlans(
  dir: string,
  platform: InitPlatformInput,
  force: boolean,
): InitPathPlan[] {
  const plans = [
    // User-owned credential bytes are never replaced, including under --force.
    scaffoldFilePlan(dir, DEFAULT_ENV_FILE, '', force, true),
    scaffoldFilePlan(
      dir,
      DEFAULT_SECRETS_FILE,
      buildSecretsFile(platform),
      force,
      true,
      SECRETS_FILE_MODE,
    ),
    scaffoldFilePlan(
      dir,
      DEFAULT_HOOKS_FILE,
      hasWeb(platform) ? buildExampleHooksFile() : buildHooksFile(platform),
      force,
    ),
    // The knowledge root's own covering rule goes down BEFORE any other write inside the
    // knowledge tree, for the same reason the target managed block leads the whole run:
    // every scaffold write publishes through a sibling temporary, and a knowledge tree that
    // is its own repository does NOT inherit the parent's .gitignore (measured). Ordered
    // after README.md and policies/global.md, those two temporaries existed under no rule at
    // all in that case.
    scaffoldFilePlan(
      dir,
      join(KNOWLEDGE_ROOT_DIR, '.gitignore'),
      buildKnowledgeGitignore(),
      force,
      true,
    ),
    // agent-qa's generated file, so `--force` regenerates it (not `preserveOnForce`).
    scaffoldFilePlan(
      dir,
      join(KNOWLEDGE_ROOT_DIR, 'AGENTS.md'),
      buildKnowledgeAgentGuide(),
      force,
    ),
    scaffoldFilePlan(
      dir,
      join(KNOWLEDGE_ROOT_DIR, 'README.md'),
      buildKnowledgeReadme(),
      force,
      true,
    ),
    scaffoldFilePlan(
      dir,
      join(KNOWLEDGE_ROOT_DIR, 'policies', 'global.md'),
      buildGlobalPolicyTemplate(),
      force,
      true,
    ),
  ]

  if (!hasWeb(platform)) return plans

  plans.push(
    scaffoldFilePlan(dir, KOMAZON_CHECKOUT_PATH, buildKomazonCheckoutTest(), force),
    scaffoldFilePlan(dir, KOMAZON_CART_TOTAL_BUG_PATH, buildKomazonCartTotalBugTest(), force),
    scaffoldFilePlan(dir, EXAMPLES_SUITE_PATH, buildExamplesSuite(), force),
    scaffoldFilePlan(dir, SHIPPING_ADDRESS_SCRIPT_PATH, buildShippingAddressScript(), force),
    scaffoldFilePlan(dir, KOMAZON_SHIPPING_HOOK_PATH, buildKomazonShippingHookTest(), force),
  )

  return plans
}

// Drawn without the rail's gutter, so the line pastes as it is.
function showExampleSecretLine(ui: InitUi): void {
  ui.line(`Add this line to ${DEFAULT_SECRETS_FILE} so the examples can sign in:`)
  ui.copyable(EXAMPLE_SECRET_LINE)
}

function holdsExamplePassword(text: string | undefined): boolean {
  return text !== undefined && /^\s*KOMAZON_PASSWORD\s*=/mu.test(text)
}

// A package.json above the folder is named by its path from the folder, which is real once it
// leaves the folder.
function packageJsonText(result: InitFileResult, dir: string, realDir: string): string {
  const fromDir = relative(dir, result.path)
  const outside = fromDir === '..' || fromDir.startsWith(`..${sep}`)
  const shown = outside && realDir !== dir ? relative(realDir, result.path) : fromDir
  const name = shown || 'package.json'
  const folderName = basename(realDir)
  if (result.outcome === 'created') return `${name} created (${sanitizedPackageName(folderName)})`
  return result.outcome === 'updated' ? `${name} updated` : `${name} kept`
}

function scaffoldText(platform: InitPlatformInput, files: number): string {
  const what = hasWeb(platform) ? 'config, 3 example tests and a suite' : 'config'
  return `Scaffold: ${what} (${files} files)`
}

// runInstallStep's own lines, closed as one step: the failure keeps the shown output under it.
function installStepResult(step: InstallStepResult, printed: readonly string[]): InitStepResult {
  const lines = printed.flatMap((text) => text.split('\n'))
  if (step.outcome === 'failed') {
    const start = lines.findIndex((line) => line.startsWith('✗ '))
    const end = lines.lastIndexOf(`  Run: ${step.command}`)
    const shown = start === -1 ? [] : lines.slice(start, end === -1 ? undefined : end)
    const reason = shown.join('\n').replace(/^✗ /u, '')
    return { outcome: 'failed', reason: reason || 'Install failed', command: step.command }
  }
  const text = (lines.at(-1) ?? '').replace(/^✓ /u, '')
  if (step.outcome === 'declared') {
    return { outcome: 'skipped', text, reason: '--pm none', command: step.command }
  }
  if (step.outcome === 'skipped') return { outcome: 'skipped', text, reason: 'already installed' }
  return { outcome: 'done', text }
}

// Commander stops at a bad option value before it reads the options after it, so --json is looked
// for in the arguments as given, up to a `--`.
function asksForJson(cmd: Command): boolean {
  let root = cmd
  while (root.parent !== null) root = root.parent
  const raw = (root as unknown as { rawArgs?: unknown }).rawArgs
  const given = Array.isArray(raw) ? raw.map(String) : []
  const args = given.slice(given.indexOf(cmd.name()) + 1)
  const end = args.indexOf('--')
  return (end === -1 ? args : args.slice(0, end)).includes('--json')
}

// A dashboard the person stopped, or that ended cleanly, is done; any other end is a failed start.
function dashboardStepResult(result: RunResult, execPath: string): InitStepResult {
  const failed = (reason: string): InitStepResult => ({
    outcome: 'failed',
    reason,
    command: DASHBOARD_COMMAND,
  })
  if (result.missing === true) return failed(`${execPath} was not found to run the dashboard`)
  if (result.code === 0 || wasCancelled(result)) {
    return { outcome: 'done', text: 'Dashboard stopped' }
  }
  return failed(
    result.code === null
      ? `The dashboard ended by ${result.signal ?? 'a signal'}`
      : `The dashboard exited ${result.code}`,
  )
}

const SETUP_ON_FRESH_LINE =
  '--setup picks what a re-run of init sets up, and this folder is not set up yet. '
  + 'Run npx agent-qa init without --setup.'
const SETUP_WITH_FORCE_LINE =
  '--setup picks what a re-run of init sets up, and --force rebuilds everything. '
  + 'Use one of them.'

export function createInitCommand(hooks: InitCommandHooks = {}): Command {
  let documentWritten = false
  const writeDocument = (doc: InitDocument): void => {
    if (documentWritten) return
    documentWritten = true
    writeInitDocument(doc)
  }
  const cmd = new Command('init')
    .description('Initialize a new agent-qa project')
    .addOption(new Option('--dir <path>').hideHelp())
    .addOption(new Option('--config <path>').hideHelp())
    .addOption(
      new Option('--platform <list>', 'platforms to test: web, android and ios, separated by commas'),
    )
    .option(
      '--llm <choice>',
      `model: ${INIT_MODEL_CHOICES.join(', ')} or the name of a saved credential `
        + '(default: a saved sign-in, else claude-code)',
    )
    .option('--model <id>', "model id (default: the provider's default model)")
    .option(
      '--base-url <url>',
      'endpoint for anthropic, openai, openai-compatible or anthropic-compatible',
    )
    .option(
      '--agents <list>',
      'coding agents to set up: claude-code, codex, all or none (default: the ones detected)',
    )
    .option('--no-browsers', 'do not download Chromium for web targets')
    .option('--no-dashboard', 'do not start the dashboard at the end')
    .option('--force', 'overwrite existing files')
    .option(
      '--setup <list>',
      'on an initialized project, the setup rows to run: names separated by commas, all or none',
    )
    .addOption(
      new Option(
        '--pm <name>',
        'package manager to install with (default: detected from the project)',
      ).choices(['npm', 'pnpm', 'yarn', 'bun', 'none']),
    )
    .option('--yes', 'ask nothing and take every default')
    .option('--json', 'print one JSON document on stdout and the steps on stderr; asks nothing')
    .option(
      '--capabilities',
      'print the JSON capability manifest (catalog and local posture) and exit; writes nothing',
    )
    // Declared so commander does not answer it with a suggestion of --agents.
    .addOption(new Option('--agent').hideHelp())
    .action(async (opts, command: Command) => {
      const json = opts.json === true && opts.capabilities !== true
      // Taken first and released only after a run that ended well: a failure's block must go to
      // stderr.
      const releaseStdout = opts.capabilities === true || json ? reserveStdoutForData() : undefined
      const projectDir = hooks.cwd ?? process.cwd()
      const configPath = join(projectDir, DEFAULT_CONFIG_FILE_NAME)
      const host = projectHost({ cwd: projectDir, ...hooks.host })
      let ui: InitUi = hooks.ui ?? createPlainUi()
      let clackUi: ClackUi | undefined
      const recorder = createInitDocumentRecorder({ dir: projectDir })
      let steps: () => readonly InitStepRecord[] = () => []
      let stepRunner: InitStepRunner | undefined
      let delegated = false
      let threw = false
      try {
        if (opts.agent === true) {
          throw new CliRefusal(
            [pc.red('--agent is now --capabilities: run npx agent-qa init --capabilities.')],
            2,
          )
        }
        const optionRefusal = initFolderOptionRefusal(command, opts)
        if (optionRefusal !== undefined) throw new CliRefusal([pc.red(optionRefusal)], 2)
        // `--capabilities` is a read that returns before any prompt or file, so no branch below
        // can write.
        if (opts.capabilities === true) {
          // IMPORTED HERE AND NOT AT THE TOP, deliberately. The manifest reads the local
          // composition's posture, so its module graph reaches the agent host, and `init`'s
          // ordinary job is to write a scaffold into a directory where no host could compose yet.
          // A top-level import would make every `init` run (and every test of one) evaluate a
          // composition root that only this branch has any use for. It also breaks
          // `init.test.ts`, whose partial `node:fs` mock the durable-store module underneath that
          // graph needs more of.
          const { buildAgentManifest } = await import('../capability-catalog/manifest.js')
          // The posture is read from agent-qa.config.yaml in the folder init runs in.
          const manifest = await buildAgentManifest({ configPath })
          // STDOUT AND NOTHING ELSE ON IT. The whole of this command's output under
          // `--capabilities` is one JSON document, so it pipes into a parser without a filter in
          // between.
          console.log(guardJsonText(JSON.stringify(manifest, null, 2)))
          // `--capabilities` writes nothing, so it emits no init event.
          return
        }

        const dir = projectDir
        const folderRefusal = await initFolderRefusal(dir, {
          ...defaultInitFolderIo,
          homedir: () => host.homedir,
        })
        if (folderRefusal !== undefined) throw new CliRefusal([pc.red(folderRefusal)], 2)
        const range = await projectRange(dir, host)
        recorder.realDir(range.start)
        const packageJson = readProjectPackageJson(range, host.io)
        if (packageJson.text !== undefined) parsePackageJson(packageJson.path, packageJson.text)
        const runningVersion = installedAgentQaVersion()
        const manager = () =>
          detectPackageManager({
            range,
            env: host.env,
            io: host.io,
            ...(opts.pm === undefined || opts.pm === 'none' ? {} : { flag: opts.pm }),
          })
        const maskInstallOutput = installOutputMask(configPath, host.io)
        const installPlan = async (plan: PackageJsonPlan): Promise<InitStepResult> => {
          const printed: string[] = []
          // A guarded block of the manager's output goes to stderr, never to stdout.
          const releaseInstallStdout = reserveStdoutForData()
          try {
            const detected = manager()
            recorder.packageManager(opts.pm === 'none' ? 'none' : detected.name)
            const step = await runInstallStep({
              host,
              range,
              packageJson: plan,
              manager: detected,
              mode: opts.pm === 'none' ? 'none' : 'run',
              mask: maskInstallOutput,
              print: (text) => printed.push(text),
            })
            return installStepResult(step, printed)
          } finally {
            releaseInstallStdout()
          }
        }
        const handedOff = await handOffToProjectAgentQa({
          host,
          range,
          packageJson,
          runningVersion,
          pm: opts.pm,
          install: async () => {
            const version = declaredAgentQaVersion(packageJson.text)
            if (version === undefined) return false
            const step = await runInstallStep({
              host,
              range,
              packageJson: planPackageJson({
                ...packageJson,
                folderName: basename(range.start),
                dependencies: [{ name: 'agent-qa', version }],
              }),
              manager: manager(),
              mode: 'run',
              mask: maskInstallOutput,
              print: (line) => ui.line(line),
            })
            return step.outcome === 'installed' || step.outcome === 'skipped'
          },
          print: (line) => ui.line(line),
          onHandOff: () => {
            delegated = true
          },
        })
        if (handedOff) return
        const initStartedAt = Date.now()
        const force = opts.force ?? false

        const mode = initUiMode({
          stdinIsTTY: hooks.stdinIsTTY ?? hooks.isTTY ?? process.stdin.isTTY === true,
          stdoutIsTTY: hooks.stdoutIsTTY ?? hooks.isTTY ?? process.stdout.isTTY === true,
          ci: resolveIsCI(host.env),
          yes: opts.yes === true,
          json,
        })
        // Without a question drawn, every answer takes its flag or its default.
        const ask = mode === 'interactive'
        let asked = false

        // Derives the outcome from file outcomes; a scaffold that throws reaches neither call site.
        const emitInitCompleted = async (
          initMode: 'interactive' | 'scaffold' | 'rerun',
          results: readonly { readonly outcome: InitFileResult['outcome'] }[],
        ): Promise<void> => {
          const { analyticsEvent, composeAnalyticsHost } = await import(
            '../composition/analytics-host.js'
          )
          // Reads this command's own config for the opt-out; an absent config yields `undefined`.
          const { readAnalyticsPrivacyDeclaration, resolveConfig } = await import('../config.js')
          let config: Awaited<ReturnType<typeof resolveConfig>> | undefined
          try {
            config = await resolveConfig({
              configPath,
              loadAuthPlugins: false,
            })
          } catch {
            config = undefined
          }
          // Reuses `configPath`, so the declaration comes from the file already chosen.
          const analyticsConfig = config ?? (await readAnalyticsPrivacyDeclaration(configPath))
          const analytics = await (hooks.composeAnalytics ?? composeAnalyticsHost)({
            surface: 'cli',
            ...(analyticsConfig === undefined ? {} : { config: analyticsConfig }),
          })
          try {
            const createdCount = results.filter((result) => result.outcome === 'created').length
            const updatedCount = results.filter((result) => result.outcome === 'updated').length
            analytics.port.capture(analyticsEvent(analytics, 'agent-qa.init.completed', {
              init_mode: initMode,
              outcome: createdCount > 0 ? 'created' : updatedCount > 0 ? 'updated' : 'unchanged',
              created_file_count: createdCount,
              duration_ms: Date.now() - initStartedAt,
            }))
          } finally {
            await analytics.shutdown()
          }
        }

        // Later steps run through the project's agent-qa, or this one as a captured child.
        const stepContext = {
          host,
          range,
          // The range holds real paths, so the folder is found by its real path too.
          fromDir: range.start,
          runningVersion,
          inProcess: (args: readonly string[]) => runRunningAgentQa(args, host),
        }

        const validate = async (): Promise<InitStepResult> => {
          const run = await runAgentQaStep(['validate'], stepContext)
          recorder.agentQa({ version: run.version, via: run.via })
          if (run.code === 0) {
            return { outcome: 'done', text: 'validate: the config and tests are valid' }
          }
          const shown = await shownOutput(
            stripVTControlCharacters(run.output),
            maskInstallOutput,
            Number.MAX_SAFE_INTEGER,
          )
          return {
            outcome: 'failed',
            reason: validateReason(shown) ?? `validate exited ${run.code}`,
            command: VALIDATE_COMMAND,
          }
        }

        const installChromium = async (): Promise<InitStepResult> => {
          let output = ''
          for (let attempt = 0; attempt < CHROMIUM_ATTEMPTS; attempt += 1) {
            const run = await runAgentQaStep(['install-browsers', '--chromium'], stepContext)
            if (run.code === 0) return { outcome: 'done', text: 'Chromium installed' }
            output = run.output
          }
          const [last] = await shownOutput(output, maskInstallOutput, 1)
          return {
            outcome: 'failed',
            reason: `Chromium download failed twice${last === undefined ? '' : `: ${last}`}`,
            command: CHROMIUM_COMMAND,
          }
        }

        const openUi = async (): Promise<InitUi> => {
          if (mode !== 'plain' && hooks.ui === undefined) {
            const rail = hooks.rail ?? { input: process.stdin, output: process.stderr }
            const rgb = await probeTerminalBackground(
              hooks.terminal ?? processTerminalPort(process.stdin, process.stdout, host.env),
            )
            // The level follows agent-qa's colour rule over the environment and stream init is
            // given.
            const palette = brandPalette({
              background: classifyBackground(rgb, host.env),
              ...(rgb === undefined ? {} : { rgb }),
              level: colorLevelFor(host.env, rail.output),
            })
            clackUi = createClackUi({
              input: rail.input,
              output: rail.output,
              palette,
              columns: rail.output.columns ?? 0,
            })
            ui = clackUi
          }
          return ui
        }

        const maskStepText = async (text: string): Promise<string> =>
          (await shownOutput(text, maskInstallOutput, Number.MAX_SAFE_INTEGER)).join('\n')

        const configClassification = classifyInitPath(configPath, dir)
        if (opts.setup !== undefined && force) {
          throw new CliRefusal([pc.red(SETUP_WITH_FORCE_LINE)], 2)
        }
        if (opts.setup !== undefined && configClassification !== 'regular') {
          throw new CliRefusal([pc.red(SETUP_ON_FRESH_LINE)], 2)
        }
        if (configClassification === 'regular' && !force) {
          await runInitRerun({
            dir,
            configPath,
            host,
            range,
            packageJson,
            runningVersion,
            opts,
            mode,
            openUi,
            recorder,
            validate,
            validateStep: { title: 'Validating the config and tests', command: VALIDATE_COMMAND },
            mask: maskStepText,
            outro: GETTING_STARTED_URL,
            ...(hooks.onComplete === undefined ? {} : { onComplete: hooks.onComplete }),
            emitInitCompleted,
            onRunner: (runner) => {
              stepRunner = runner
              steps = () => runner.records()
            },
            chromium: hooks.chromium ?? findChromiumByDefault,
            installChromium,
            scaffoldPlans: (platform) => buildScaffoldFilePlans(dir, platform, false),
            latestVersion: hooks.latestVersion ?? askLatestVersionByDefault,
            upgrade: {
              plan: (version) =>
                planPackageJson({
                  ...packageJson,
                  folderName: basename(range.start),
                  dependencies: projectDependencies({
                    version,
                    ...configuredPackages(host.io.readText(configPath)),
                  }),
                }),
              install: installPlan,
            },
            onHandOff: () => {
              delegated = true
            },
          })
          return
        }

        const saved = await listSavedCredentials(
          getAuthPath({ env: host.env, homeDir: host.homedir }),
        )
        const modelFlags = { model: opts.model, baseUrl: opts.baseUrl, saved }
        const askModel = ask && opts.llm === undefined
        let modelPick: InitModelPick | undefined = askModel
          ? undefined
          : opts.llm === undefined
            ? preselectedModel(saved)
            : resolveLlmFlag(opts.llm, saved)
        // Resolved before anything is drawn, so a refused flag writes nothing.
        let modelSetup = modelPick === undefined ? undefined : modelEntryFor(modelPick, modelFlags)
        const flaggedAgents =
          opts.agents === undefined ? undefined : parseInitAgentsFlag(opts.agents)
        const flaggedPlatform =
          opts.platform === undefined ? undefined : parseInitPlatformList(opts.platform)
        if (flaggedPlatform !== undefined && 'refusal' in flaggedPlatform) {
          throw new CliRefusal([pc.red(flaggedPlatform.refusal)], 2)
        }

        // Every scaffold plans the knowledge .gitignore, so a folder that cannot take it is
        // refused before any question.
        const knowledgeGitignorePath = join(dir, KNOWLEDGE_ROOT_DIR, '.gitignore')
        const knowledgeGitignoreWasPresent =
          classifyInitPath(knowledgeGitignorePath, dir) === 'regular'
        if (knowledgeGitignoreWasPresent) {
          warnForMissingKnowledgeGitignoreRules(knowledgeGitignorePath)
          verifyEffectiveGitignore({
            cwd: join(dir, KNOWLEDGE_ROOT_DIR),
            label: 'existing agent-qa-knowledge/.gitignore',
            probes: KNOWLEDGE_GITIGNORE_PROBES,
            written: 'nothing',
          })
        }

        await openUi()
        if (mode !== 'plain') ui.banner()
        ui.intro()

        let platform: InitPlatformInput
        if (ask && flaggedPlatform === undefined) {
          asked = true
          const capabilities = await ui.multiselect<PlatformCapability>({
            message: 'What platform will you test?',
            options: PLATFORM_CHOICES,
            initialValues: ['web'],
            required: true,
          })

          const mobileRuntimes: MobileRuntime[] = capabilities.includes('mobile') ? ['android', 'ios'] : []

          platform = { capabilities, mobileRuntimes }
        } else {
          platform = flaggedPlatform?.platform ?? 'web'
        }

        if (modelPick === undefined) {
          asked = true
          const sections = initModelSections(saved)
          modelPick = await ui.select<InitModelPick>({
            message: 'Which model should agent-qa use?',
            sections,
            initialValue: optionFor(sections, preselectedModel(saved)),
          })
        }
        modelSetup ??= modelEntryFor(modelPick, modelFlags)

        let agents = flaggedAgents
        if (agents === undefined) {
          agents = await detectCodingAgents({
            projectDir: dir,
            homeDir: host.homedir,
            env: host.env,
            io: host.io,
          })
          if (ask) {
            asked = true
            agents = await ui.multiselect<CodingAgent>({
              message: 'Which coding agents should agent-qa set up?',
              options: INIT_AGENT_OPTIONS,
              initialValues: agents,
              required: false,
            })
          }
        }
        recorder.agents(agents)

        const config = buildDefaultConfig(
          platform,
          modelSetup.entry === undefined ? [] : [modelSetup.entry],
        )
        const agentQaVersion = agentQaAfterInstall(packageJson.text, runningVersion)
        const dependencies = projectDependencies({
          version: agentQaVersion,
          usesSubscription: usesSubscriptionModel(config),
          plugins: (config.plugins ?? []) as readonly { package?: unknown }[],
        })
        recorder.agentQa({ version: runningVersion, via: 'running' })
        recorder.plugins(
          dependencies
            .filter((dependency) => dependency.name !== 'agent-qa')
            .map((dependency) => ({ package: dependency.name, version: dependency.version })),
        )
        const packageJsonPlan = planPackageJson({
          ...packageJson,
          folderName: basename(range.start),
          dependencies,
        })
        const packageJsonFilePlan: InitPathPlan = {
          root: packageJsonPlan.root,
          path: packageJsonPlan.path,
          content: packageJsonPlan.content,
          force: packageJsonPlan.existed && packageJsonPlan.changed,
        }
        const filePlans = buildScaffoldFilePlans(dir, platform, force)
        const targetGitignorePath = join(dir, '.gitignore')
        const targetGitignorePlan: InitPathPlan = {
          root: dir,
          path: targetGitignorePath,
          content: '',
        }
        const configPlan: InitPathPlan = {
          root: dir,
          path: configPath,
          content: renderScaffoldConfigYaml(config),
          force,
        }
        const completePlan = [...filePlans, packageJsonFilePlan, targetGitignorePlan, configPlan]
        preflightInitPlan(completePlan)

        const outcomes: InitFileResult[] = []
        let boundary = 0
        const recordOutcome = (step: InitStepName, result: InitFileResult): InitFileResult => {
          outcomes.push(result)
          recorder.file(step, result)
          if (result.outcome === 'preserved') return result
          boundary += 1
          hooks.afterWrite?.(result, boundary)
          return result
        }

        const writePackageJson = async (): Promise<InitStepResult> => {
          // Written first, so no later scaffold temporary exists before its ignore rule does.
          recordOutcome(
            'package-json',
            upsertManagedGitignoreBlock(targetGitignorePath, buildGitignoreEntries()),
          )
          verifyEffectiveGitignore({
            cwd: dir,
            label: 'target .gitignore',
            probes: TARGET_GITIGNORE_PROBES,
            // The managed block is on disk by now — the refusal must not say otherwise.
            written: 'managed-gitignore',
          })
          const written = recordOutcome(
            'package-json',
            writeScaffoldFileAtomic(packageJsonFilePlan, {}),
          )
          return { outcome: 'done', text: packageJsonText(written, dir, range.start) }
        }

        const writeScaffold = async (): Promise<InitStepResult> => {
          const before = outcomes.length
          for (const plan of filePlans) {
            recordOutcome('scaffold', writeScaffoldFileAtomic(plan, {}))
          }

          if (!knowledgeGitignoreWasPresent) {
            verifyEffectiveGitignore({
              cwd: join(dir, KNOWLEDGE_ROOT_DIR),
              label: 'agent-qa-knowledge/.gitignore',
              probes: KNOWLEDGE_GITIGNORE_PROBES,
              // This one runs AFTER the scaffold loop: the whole scaffold is published.
              written: 'managed-gitignore-and-scaffold',
            })
          }

          recordOutcome('scaffold', writeConfigMarkerLast(configPlan, {}))
          hooks.onComplete?.([...outcomes])
          return { outcome: 'done', text: scaffoldText(platform, outcomes.length - before) }
        }

        const install = (): Promise<InitStepResult> => installPlan(packageJsonPlan)

        const setUpAgents = async (): Promise<InitStepResult> => {
          let setup: Awaited<ReturnType<typeof installAgentSetup>>
          try {
            setup = await installAgentSetup({ projectDir: dir, agents, host })
          } catch (error) {
            if (!isInitRefusal(error)) throw error
            return { outcome: 'failed', reason: error.message, command: SKILLS_COMMAND }
          }
          for (const file of setup.files) {
            recorder.file('skills', { path: join(dir, file.path), outcome: file.outcome })
          }
          const failed = Object.values(setup.parts).find((part) => part?.outcome === 'failed')
          if (failed !== undefined) {
            return {
              outcome: 'failed',
              reason: failed.reason ?? 'The coding agent setup failed',
              command: SKILLS_COMMAND,
            }
          }
          const from =
            setup.source === 'running'
              ? ` (from this agent-qa ${setup.version}; the project has none installed)`
              : ''
          return {
            outcome: 'done',
            text:
              `${agentNames(agents)}: ${skillCount(setup.files, agents)} skills, MCP entries, ` +
              `AGENTS.md block${from}`,
          }
        }

        const authPath = getAuthPath({ env: host.env, homeDir: host.homedir })
        const subscriptionPluginInstalled = (): boolean => {
          const installRecord = runner.records().find((record) => record.name === 'install')
          const installed =
            installRecord?.outcome === 'done' ||
            (installRecord?.outcome === 'skipped' && installRecord.reason === 'already installed')
          return (
            installed &&
            nearestInstalledPackage(
              range,
              dirname(packageJsonPlan.path),
              SUBSCRIPTION_AUTH_PACKAGE,
              host.io,
            ) !== undefined
          )
        }

        const runner = createInitStepRunner({
          ui,
          plan: freshInitPlan(),
          mask: maskStepText,
        })
        stepRunner = runner
        steps = () => runner.records()
        const packageJsonStep = await runner.run(
          'package-json',
          { title: 'Writing package.json' },
          writePackageJson,
        )
        // The config marker records a complete scaffold and the install reads what package.json
        // declares, so neither runs over a package.json that was not written.
        if (packageJsonStep.outcome === 'failed') {
          const reason = 'package.json was not written'
          runner.skip('scaffold', `Scaffold: skipped (${reason})`, reason)
          runner.skip('install', `Install: skipped (${reason})`, reason)
          runner.skip('chromium', `Chromium: skipped (${reason})`, reason)
          runner.skip('skills', `Coding agents: skipped (${reason})`, reason)
          runner.skip('validate', `validate: skipped (${reason})`, reason)
        } else {
          const scaffold = await runner.run(
            'scaffold',
            { title: 'Writing the scaffold' },
            writeScaffold,
          )
          // AFTER the config marker — the scaffold's last write — so the event describes a
          // project that exists rather than one being attempted.
          if (scaffold.outcome === 'done') {
            await emitInitCompleted(asked ? 'interactive' : 'scaffold', outcomes)
          }
          await runner.run('install', { title: 'Installing dependencies' }, install)
          if (opts.browsers === false) {
            runner.skip(
              'chromium',
              'Chromium: skipped (--no-browsers)',
              '--no-browsers',
              CHROMIUM_COMMAND,
            )
          } else if (!hasWeb(platform)) {
            runner.skip('chromium', 'Chromium: no web target', 'no web target')
          } else {
            await runner.run(
              'chromium',
              { title: 'Installing Chromium', command: CHROMIUM_COMMAND },
              installChromium,
            )
          }
          if (agents.length === 0) {
            runner.skip('skills', 'Coding agents: none chosen', 'none chosen')
          } else {
            await runner.run(
              'skills',
              { title: 'Setting up the coding agents', command: SKILLS_COMMAND },
              setUpAgents,
            )
          }
          // Nothing is installed yet, so validate would only report the uninstalled plugins.
          if (opts.pm === 'none') {
            runner.skip(
              'validate',
              'validate: install first (--pm none)',
              'install first (--pm none)',
              VALIDATE_COMMAND,
            )
          } else {
            await runner.run(
              'validate',
              { title: 'Validating the config and tests', command: VALIDATE_COMMAND },
              validate,
            )
          }
        }
        const pluginInstalled = subscriptionPluginInstalled()
        const status = await modelStatus({
          ...modelSetup,
          configPath,
          projectDir: dir,
          authPath,
          pluginInstalled,
        })
        // A Ctrl-C that landed outside a step is read here.
        if (runner.interrupted()) throw new PromptCancelled()

        const port = dashboardPortOf(config)
        let dashboard: 'starting' | { command: string } = { command: DASHBOARD_COMMAND }
        const scaffolded = runner
          .records()
          .some((record) => record.name === 'scaffold' && record.outcome === 'done')
        // The page init opens is one only this agent-qa's dashboard is known to take.
        const projectCopyDiffers = async (): Promise<boolean> => {
          const copy = await findProjectAgentQa(range, range.start, host.io)
          return copy !== undefined && copy.version !== runningVersion
        }
        if (mode !== 'interactive') {
          runner.skip('dashboard', 'Dashboard: skipped (not interactive)', 'not interactive')
        } else if (opts.dashboard === false) {
          runner.skip('dashboard', 'Dashboard: skipped (--no-dashboard)', '--no-dashboard')
        } else if (!scaffolded) {
          const reason = 'no config was written'
          runner.skip('dashboard', `Dashboard: skipped (${reason})`, reason)
        } else if (await projectCopyDiffers()) {
          const reason = "the project's agent-qa differs from this one"
          runner.skip('dashboard', `Dashboard: skipped (${reason})`, reason)
        } else {
          const ports = hooks.dashboardPort ?? { probe: probeDashboardPort, findFree: findFreePort }
          if ((await ports.probe(port)) === 'free') {
            dashboard = 'starting'
          } else {
            // The config names the port, so init never moves the dashboard to another one itself.
            const inUse = portInUse(port)
            runner.skip('dashboard', `Dashboard: skipped (${inUse})`, inUse)
            dashboard = { command: `${DASHBOARD_COMMAND} --port ${await ports.findFree()}` }
          }
        }
        recorder.model({
          ...(modelSetup.entry === undefined
            ? {}
            : { name: modelSetup.entry.name, provider: modelSetup.entry.provider }),
          ...status,
        })

        const secretsPath = join(dir, DEFAULT_SECRETS_FILE)
        const secretsPreserved = outcomes.some(
          result => result.path === secretsPath && result.outcome === 'preserved',
        )
        if (
          hasWeb(platform)
          && secretsPreserved
          && !holdsExamplePassword(host.io.readText(secretsPath))
        ) {
          showExampleSecretLine(ui)
        }
        const records = runner.records()
        const skillsDone = records.some(
          (record) => record.name === 'skills' && record.outcome === 'done',
        )
        const next = initNextSteps({
          steps: records,
          ...(modelSetup.entry === undefined
            ? {}
            : {
                model: {
                  name: modelSetup.entry.name,
                  provider: modelSetup.entry.provider,
                  status: status.status,
                  subscription: isSubscriptionProvider(modelSetup.entry.provider),
                  pluginInstalled,
                },
              }),
          web: hasWeb(platform),
          mobile: normalizePlatformSelection(platform).mobileRuntimes.length > 0,
          agents: skillsDone ? agents : [],
          dashboard,
        })
        recorder.nextSteps(next.steps)
        ui.note('Next steps', nextStepLines(next.steps))
        for (const hint of next.hints) ui.line(hint)
        if (runner.interrupted()) throw new PromptCancelled()
        if (dashboard === 'starting') {
          ui.line(`Starting the dashboard on http://${DASHBOARD_HOST}:${port} (Ctrl-C stops it)`)
          // Until here a Ctrl-C interrupts init; while the dashboard runs, the host runner alone
          // holds Ctrl-C, so stopping the dashboard is the normal end.
          runner.dispose()
          let ended: RunResult | undefined
          let failure: unknown
          try {
            ended = await runDashboardStep({
              host,
              range,
              page: dashboardPage({ model: status.status, dashboard: modelSetup.dashboard }),
            })
          } catch (error) {
            failure = error
          }
          // Drawn once the child has ended, since the child holds the terminal while it runs.
          await runner.run(
            'dashboard',
            { title: 'Dashboard', command: DASHBOARD_COMMAND },
            async (): Promise<InitStepResult> => {
              if (ended === undefined) throw failure
              return dashboardStepResult(ended, host.execPath)
            },
          )
        }
        ui.outro(GETTING_STARTED_URL)
        if (runner.failed()) throw new CliRefusal([], 3)
      } catch (error) {
        threw = true
        const interrupted =
          isPromptCancel(error) || (error instanceof CliRefusal && error.exitCode === 130)
        stepRunner?.skipRemaining(interrupted ? INTERRUPTED : NOT_RUN)
        const refusal = asInitRefusal(error)
        recorder.fail(refusal)
        throw refusal
      } finally {
        stepRunner?.dispose()
        // A project agent-qa that took over printed the run's document itself.
        if (json && !delegated) {
          writeDocument(await recorder.document(steps(), installOutputMask(configPath, host.io)))
        }
        clackUi?.dispose()
        if (!threw) releaseStdout?.()
      }
    })

  // Commander has printed its own line; a usage error exits 2, and help returns so commander exits 0.
  cmd.exitOverride((error) => {
    if (error.exitCode === 0) return
    if (cmd.opts().json === true || asksForJson(cmd)) {
      writeDocument(refusedInitDocument(error.message))
    }
    throw new CliRefusal([], 2, { cause: error })
  })

  return cmd
}
