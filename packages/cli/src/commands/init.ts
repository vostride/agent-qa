import { Command, Option } from 'commander'
import { existsSync, readFileSync } from 'node:fs'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import pc from 'picocolors'
import select from '@inquirer/select'
import input from '@inquirer/input'
import checkbox from '@inquirer/checkbox'
import {
  DEFAULT_AGENT_QA_AUTH_STATES_DIR,
  DEFAULT_AGENT_QA_CACHE_DIR,
  DEFAULT_AGENT_QA_RUNTIME_DIR,
} from '@vostride/agent-qa-core'
import { guardJsonText, reserveStdoutForData } from '@vostride/agent-qa-core/run-text-output'
import { getProvider, listProviders } from '@vostride/agent-qa-model'
// The scaffold's content comes from the shared producer, so the two scaffolds cannot drift.
import {
  SUBSCRIPTION_AUTH_PACKAGE,
  SUPPORTED_INIT_PLATFORMS,
  buildHooksFile,
  buildScaffoldConfig,
  hasWeb,
  normalizePlatformSelection,
  parseInitPlatform,
  renderScaffoldConfigYaml,
  type InitLLMConfig,
  type InitPlatformInput,
  type MobileRuntime,
  type PlatformCapability,
  type Platform,
} from './scaffold-content.js'
// Type-only here and the value loaded lazily: the analytics graph breaks `init.test.ts`'s fs mock.
import type { composeAnalyticsHost as ComposeAnalyticsHost } from '../composition/analytics-host.js'
import {
  KNOWLEDGE_GITIGNORE_PROBES,
  TARGET_GITIGNORE_PROBES,
  classifyInitPath,
  preflightInitPlan,
  preflightManagedBlock,
  upsertManagedBlock,
  upsertManagedGitignoreBlock,
  verifyEffectiveGitignore,
  writeConfigMarkerLast,
  writeScaffoldFileAtomic,
  type InitFileResult,
  type InitPathPlan,
  type ManagedBlockUpsertPlan,
} from './init-filesystem.js'
import {
  WRITE_AGENT_INSTRUCTIONS_FLAG,
  buildAgentInstructionPointer,
  buildKnowledgeAgentGuide,
} from './knowledge-guide.js'
import {
  AGENT_QA_INIT_MARKDOWN_BLOCK,
  renderManagedBlock,
  type ManagedBlockContent,
} from './managed-block.js'
import { CliRefusal } from '../composition/cli-refusal.js'
import { InitRefusal, isInitRefusal } from './init-refusal.js'
import { initFolderOptionRefusal, initFolderRefusal } from './init-project-folder.js'
import {
  installedAgentQaVersion,
  parsePackageJson,
  planPackageJson,
  projectDependencies,
  readProjectPackageJson,
} from './package-json-plan.js'
import { runInstallStep } from './package-install.js'
import { detectPackageManager } from './package-manager.js'
import { declaredAgentQaVersion, handOffToProjectAgentQa } from './project-agent-qa.js'
import { projectHost, type ProjectHost } from './project-host.js'
import { projectRange } from './project-range.js'

// Re-exported because this module is their public door.
export { SUPPORTED_INIT_PLATFORMS, parseInitPlatform } from './scaffold-content.js'

// `scaffold-content.ts` may not name `@vostride/agent-qa-core`, so the defaults are resolved here.
const INIT_CACHE_DIR = DEFAULT_AGENT_QA_CACHE_DIR || '.agent-qa/cache'
const INIT_AUTH_STATES_DIR = DEFAULT_AGENT_QA_AUTH_STATES_DIR || '.agent-qa/auth-states'

const DEFAULT_CONFIG_FILE_NAME = 'agent-qa.config.yaml'
// Kept here rather than moved: it feeds `buildGitignoreEntries`, the deliberate literal
// copy this file keeps pinned against `init-filesystem.ts`'s own — see scaffold-content.ts.
const INIT_RUNTIME_DIR = DEFAULT_AGENT_QA_RUNTIME_DIR || '.agent-qa'

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
export const INIT_LLM_CHOICES = [
  'claude-code',
  'codex',
  'openai-compatible',
  'anthropic-compatible',
  'gemini',
] as const
export type InitLLMChoice = (typeof INIT_LLM_CHOICES)[number]

const INIT_LLM_ENTRIES: Record<InitLLMChoice, { name: string; provider: string }> = {
  'claude-code': { name: 'claude-code', provider: 'anthropic-subscription' },
  codex: { name: 'codex', provider: 'openai-subscription' },
  'openai-compatible': { name: 'default', provider: 'openai-compatible' },
  'anthropic-compatible': { name: 'default', provider: 'anthropic-compatible' },
  gemini: { name: 'default', provider: 'gemini' },
}

const INIT_LLM_NAMES: Record<InitLLMChoice, string> = {
  'claude-code': 'Claude Code (Anthropic subscription)',
  codex: 'Codex (OpenAI subscription)',
  'openai-compatible': 'OpenAI-compatible API',
  'anthropic-compatible': 'Anthropic-compatible API',
  gemini: 'Gemini API',
}

// The defaults @ai-sdk/openai and @ai-sdk/anthropic use with no baseURL.
export const INIT_BASE_URL_DEFAULTS: Readonly<Record<string, string>> = {
  'openai-compatible': 'https://api.openai.com/v1',
  'anthropic-compatible': 'https://api.anthropic.com/v1',
}

const BASE_URL_FORM_REFUSAL = '--base-url must be an absolute http or https URL'

function baseUrlFormRefusal(value: string): string | undefined {
  const url = URL.canParse(value) ? new URL(value) : undefined
  return url?.protocol === 'http:' || url?.protocol === 'https:' ? undefined : BASE_URL_FORM_REFUSAL
}

function baseUrlRefusal(provider: string, value: string): string | undefined {
  if (getProvider(provider)?.needsBaseURL !== true) {
    return '--base-url applies only to --llm openai-compatible or anthropic-compatible'
  }
  return baseUrlFormRefusal(value)
}

export function getProviderChoices(): Array<{ value: string; name: string }> {
  return listProviders().map(provider => ({ value: provider.id, name: provider.label }))
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
import { randomBytes } from 'node:crypto'

const address = \`\${100 + (randomBytes(1)[0] % 900)} Cedar Lane\`
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

export function defaultModelForProvider(provider: string): string {
  return getProvider(provider)?.defaultModel ?? 'model-name'
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
const DEFAULT_LOCAL_CONFIG_FILE = 'agent-qa.local.yaml'

function directoryGitignoreEntry(value: string): string {
  return value.endsWith('/') ? value : `${value}/`
}

function buildGitignoreEntries(): string[] {
  return [
    directoryGitignoreEntry(INIT_RUNTIME_DIR),
    directoryGitignoreEntry(INIT_AUTH_STATES_DIR),
    // Spelled literally because the init suite mocks init-filesystem.js; a test pins both equal.
    'tests/.agent-qa-drafts/',
    'node_modules/',
    // init no longer writes this file; the rule keeps one an older init wrote out of git.
    DEFAULT_LOCAL_CONFIG_FILE,
    DEFAULT_ENV_FILE,
    DEFAULT_SECRETS_FILE,
    // The namespace `writeDurableTemporary` publishes through. The temporary is a sibling of
    // its destination carrying that destination's content — for the secrets file, live
    // credential bytes at 0600 — and it outlives any cleanup that cannot run. Spelled
    // literally rather than imported because init-filesystem.js is mocked wholesale by the
    // init suite; `DURABLE_TEMPORARY_GITIGNORE_RULE` is the other copy, and the two are
    // pinned together by the runtime-versus-defaults agreement test.
    '.*.agent-qa-init-*.tmp',
  ]
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

Sovereignty: policies are human-asserted and win every conflict. Once policy
serving lands, every active line here is served to the agent verbatim on every
run — never summarized, never budgeted out — so keep rules few and deliberate.

HTML comments are stripped at serve time: a comment-only file like this one is
an empty policy. Add rules below this comment block to activate them.
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

type InitNextStep = { command: string; description: string }

function subscriptionAuthInstalled(dir: string): boolean {
  let current = resolve(dir)
  while (true) {
    const manifest = join(
      current,
      'node_modules',
      ...SUBSCRIPTION_AUTH_PACKAGE.split('/'),
      'package.json',
    )
    if (existsSync(manifest)) return true
    const parent = dirname(current)
    if (parent === current) return false
    current = parent
  }
}

function configuredLlms(config: Record<string, unknown>): InitLLMConfig[] {
  const registry = config.registry as Record<string, unknown> | undefined
  return (registry?.llms ?? []) as InitLLMConfig[]
}

function usesSubscriptionModel(config: Record<string, unknown>): boolean {
  return configuredLlms(config).some(llm => isSubscriptionProvider(String(llm.provider)))
}

function connectionSteps(config: Record<string, unknown>, dir: string): InitNextStep[] {
  const llms = configuredLlms(config)
  const steps: InitNextStep[] = []
  const usesSubscription = usesSubscriptionModel(config)
  if (usesSubscription && !subscriptionAuthInstalled(dir)) {
    steps.push({
      command: `npm install -D ${SUBSCRIPTION_AUTH_PACKAGE}`,
      description: 'Install the subscription sign-in plugin',
    })
  }
  for (const llm of llms) {
    const name = String(llm.name)
    const provider = String(llm.provider)
    if (isSubscriptionProvider(provider)) {
      steps.push({
        command: `npx agent-qa auth login --config ${name}`,
        description: 'Sign in with your subscription',
      })
      continue
    }
    steps.push({
      command: `npx agent-qa auth set --config ${name} --type api-key`,
      description: 'Save your API key at a hidden prompt',
    })
    if (getProvider(provider)?.authModes.includes('bearer-token')) {
      steps.push({
        command: `npx agent-qa auth set --config ${name} --type bearer-token`,
        description: 'Or save a bearer token at a hidden prompt',
      })
    }
  }
  return steps
}

// The same commands, in the same order, as the published quickstart.
function initNextSteps(
  platform: InitPlatformInput,
  config: Record<string, unknown>,
  dir: string,
): InitNextStep[] {
  const steps: InitNextStep[] = []
  if (hasWeb(platform)) {
    steps.push({
      command: 'npx agent-qa install-browsers --chromium',
      description: 'Install the browser the examples run in',
    })
  }
  if (normalizePlatformSelection(platform).mobileRuntimes.length > 0) {
    steps.push({
      command: 'npx agent-qa install-mobile-drivers --all',
      description: 'Install mobile driver support',
    })
  }
  steps.push(...connectionSteps(config, dir))
  steps.push({ command: 'npx agent-qa validate', description: 'Check the config and the tests' })
  if (hasWeb(platform)) {
    steps.push({
      command: `npx agent-qa run ${EXAMPLES_SUITE_PATH}`,
      description: "Run the examples: one passes, one fails on the playground's deliberate bug (exit 1)",
    })
  }
  steps.push({
    command: GETTING_STARTED_URL,
    description: 'The rest of the route: the hook sample, the dashboard and what the run taught agent-qa',
  })
  return steps
}

const ROOT_AGENT_INSTRUCTIONS_FILE = 'AGENTS.md'

function agentInstructionPointerContent(): ManagedBlockContent {
  return {
    descriptor: AGENT_QA_INIT_MARKDOWN_BLOCK,
    body: buildAgentInstructionPointer(),
    target: ROOT_AGENT_INSTRUCTIONS_FILE,
  }
}

function agentInstructionPointerBlock(): string {
  return renderManagedBlock(agentInstructionPointerContent())
}

// The config marker records completion, so a failed root block reports the scaffold incomplete.
function incompleteScaffoldError(error: unknown, configName: string): Error {
  const reason = error instanceof Error ? error.message : String(error)
  const message =
    `${reason}\nThe other scaffold files were written, but ${configName} was not written, `
    + 'so this project is not initialized. Fix the cause above and rerun agent-qa init; '
    + 'files it already wrote are kept.'
  return isInitRefusal(error)
    ? new InitRefusal(message, { cause: error })
    : new Error(message, { cause: error })
}

// A refusal exits 2 with its message alone; a bug or a prompt cancel passes through unchanged.
function asInitRefusal(error: unknown): unknown {
  if (error instanceof CliRefusal) return error
  if (isInitRefusal(error)) {
    return new CliRefusal([pc.red(error.message)], 2, { cause: error })
  }
  return error
}

// Printed flush left: an indented marker line is not a marker, and the writer would refuse it.
function printAgentInstructionPointer(): void {
  console.log('')
  console.log(`  Coding agents: add this block to ${ROOT_AGENT_INSTRUCTIONS_FILE} at the project root:`)
  console.log('')
  console.log(agentInstructionPointerBlock())
}

export interface InitCommandHooks {
  afterWrite?: (result: InitFileResult, boundary: number) => void
  onComplete?: (outcomes: readonly InitFileResult[]) => void
  // A seam so a suite observes the one event without touching a home directory.
  composeAnalytics?: typeof ComposeAnalyticsHost
  isTTY?: boolean
  cwd?: string
  host?: Partial<ProjectHost>
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

function isOutside(relativePath: string): boolean {
  return relativePath === '..' || relativePath.startsWith(`..${sep}`)
}

// A file above the folder, such as the project's package.json, is found by its real path.
function displayInitPath(dir: string, realDir: string, path: string): string {
  const fromDir = relative(dir, path)
  const localPath = isOutside(fromDir) && realDir !== dir ? relative(realDir, path) : fromDir
  return localPath.length > 0 ? localPath : path
}

function printOutcomeSummary(
  dir: string,
  outcomes: readonly InitFileResult[],
  realDir = dir,
): void {
  const groups = [
    ['created', 'Created'],
    ['updated', 'Updated'],
    ['preserved', 'Preserved'],
  ] as const

  for (const [outcome, label] of groups) {
    const matching = outcomes.filter(result => result.outcome === outcome)
    if (matching.length === 0) continue
    console.log(`  ${label}:`)
    for (const result of matching) {
      console.log(`    ${pc.dim('•')} ${displayInitPath(dir, realDir, result.path)}`)
    }
  }
}

// Printed flush left so the line can be pasted as is.
function printExampleSecretLine(): void {
  console.log('')
  console.log(`  Add this line to ${DEFAULT_SECRETS_FILE} so the examples can sign in:`)
  console.log(EXAMPLE_SECRET_LINE)
}

function printNextSteps(
  platform: InitPlatformInput,
  config: Record<string, unknown>,
  dir: string,
): void {
  console.log('')
  console.log('  Next steps:')
  for (const [index, step] of initNextSteps(platform, config, dir).entries()) {
    console.log(`    ${index + 1}. ${pc.cyan(step.command)}  ${step.description}`)
  }
}

export function createInitCommand(hooks: InitCommandHooks = {}): Command {
  const cmd = new Command('init')
    .description('Initialize a new agent-qa project')
    .addOption(new Option('--dir <path>').hideHelp())
    .addOption(new Option('--config <path>').hideHelp())
    .addOption(
      new Option('--platform <type>', 'platform to configure')
        .choices([...SUPPORTED_INIT_PLATFORMS]),
    )
    .addOption(
      new Option('--llm <provider>', 'model connection (default: claude-code)')
        .choices([...INIT_LLM_CHOICES]),
    )
    .option('--model <id>', "model id (default: the provider's default model)")
    .option(
      '--base-url <url>',
      'endpoint for openai-compatible or anthropic-compatible (default: the provider API)',
    )
    .option('--force', 'overwrite existing files')
    .addOption(
      new Option(
        '--pm <name>',
        'package manager to install with (default: detected from the project)',
      ).choices(['npm', 'pnpm', 'yarn', 'bun', 'none']),
    )
    .option(
      WRITE_AGENT_INSTRUCTIONS_FLAG,
      'also write the agent-qa pointer block into AGENTS.md at the project root',
    )
    .option(
      '--agent',
      'print the JSON capability manifest (catalog and local posture) and exit; writes nothing',
    )
    .action(async (opts, command: Command) => {
      // Taken first and released only after the document: a failure's block must go to stderr.
      const releaseStdout = opts.agent === true ? reserveStdoutForData() : undefined
      const optionRefusal = initFolderOptionRefusal(command, opts)
      if (optionRefusal !== undefined) throw new CliRefusal([pc.red(optionRefusal)], 2)
      const projectDir = hooks.cwd ?? process.cwd()
      const configPath = join(projectDir, DEFAULT_CONFIG_FILE_NAME)
      // `--agent` is a read that returns before any prompt or file, so no branch below can write.
      if (opts.agent === true) {
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
        // STDOUT AND NOTHING ELSE ON IT. The whole of this command's output under `--agent` is
        // one JSON document, so it pipes into a parser without a filter in between.
        console.log(guardJsonText(JSON.stringify(manifest, null, 2)))
        releaseStdout?.()
        // `--agent` writes nothing, so it emits no init event.
        return
      }

      try {
        const dir = projectDir
        const folderRefusal = await initFolderRefusal(dir)
        if (folderRefusal !== undefined) throw new CliRefusal([pc.red(folderRefusal)], 2)
        const host = projectHost({ cwd: dir, ...hooks.host })
        const range = await projectRange(dir, host)
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
        const maskInstallOutput = async (text: string): Promise<string> => {
          try {
            const secrets = await import('../composition/declared-secrets.js')
            return secrets.createDeclaredSecretMask(configPath).mask(text)
          } catch {
            return text
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
            })
            return step.outcome === 'installed' || step.outcome === 'skipped'
          },
        })
        if (handedOff) return
        const initStartedAt = Date.now()
        const force = opts.force ?? false

        const tty = hooks.isTTY ?? process.stdin.isTTY === true
        let asked = false

        // Derives the outcome from file outcomes; a scaffold that throws reaches neither call site.
        const emitInitCompleted = async (
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
              init_mode: asked ? 'interactive' : 'scaffold',
              outcome: createdCount > 0 ? 'created' : updatedCount > 0 ? 'updated' : 'unchanged',
              created_file_count: createdCount,
              duration_ms: Date.now() - initStartedAt,
            }))
          } finally {
            await analytics.shutdown()
          }
        }

        const configClassification = classifyInitPath(configPath, dir)
        if (configClassification === 'regular' && !force) {
          const completed = [{ path: configPath, outcome: 'preserved' }] as const
          console.log(pc.yellow(`Project is already initialized at ${dir}. Use --force to rebuild it.`))
          printOutcomeSummary(dir, completed)
          hooks.onComplete?.(completed)
          await emitInitCompleted(completed)
          return
        }

        const refuseBaseUrl = (provider: string): boolean => {
          const refusal = opts.baseUrl === undefined ? undefined : baseUrlRefusal(provider, opts.baseUrl)
          if (refusal) {
            console.error(pc.red(refusal))
            process.exitCode = 2
          }
          return refusal !== undefined
        }
        const askLlm = tty && opts.llm === undefined
        const flaggedLlm = (opts.llm ?? 'claude-code') as InitLLMChoice
        if (!askLlm && refuseBaseUrl(INIT_LLM_ENTRIES[flaggedLlm].provider)) return

        let platform: InitPlatformInput
        if (tty && opts.platform === undefined) {
          asked = true
          const capabilities = await checkbox<PlatformCapability>({
            message: 'What platform will you test?',
            choices: [
              { value: 'web', name: 'Web', description: 'Test web apps with Playwright', checked: true },
              { value: 'mobile', name: 'Mobile', description: 'Test Android or iOS apps with Appium', checked: false },
            ],
            required: true,
            validate: (value) => value.length > 0 || 'Select at least one platform.',
          }) as PlatformCapability[]

          const mobileRuntimes: MobileRuntime[] = capabilities.includes('mobile') ? ['android', 'ios'] : []

          platform = { capabilities, mobileRuntimes }
        } else {
          platform = (opts.platform ?? 'web') as Platform
        }

        let llm: InitLLMChoice = opts.llm ?? 'claude-code'
        if (askLlm) {
          asked = true
          llm = await select<InitLLMChoice>({
            message: 'Which model connection?',
            choices: INIT_LLM_CHOICES.map(value => ({ value, name: INIT_LLM_NAMES[value] })),
            default: 'claude-code',
          })
        }
        const { name: llmName, provider } = INIT_LLM_ENTRIES[llm]
        if (askLlm && refuseBaseUrl(provider)) return

        let model: string = opts.model ?? defaultModelForProvider(provider)
        if (tty && opts.model === undefined && !isSubscriptionProvider(provider)) {
          asked = true
          model = (await input({
            message: 'Model:',
            default: model,
            validate: (value) => value.trim().length > 0 || 'Enter a model id.',
          })).trim()
        }

        const needsBaseURL = getProvider(provider)?.needsBaseURL === true
        let baseURL: string | undefined = needsBaseURL
          ? opts.baseUrl ?? INIT_BASE_URL_DEFAULTS[provider]
          : undefined
        if (tty && opts.baseUrl === undefined && needsBaseURL) {
          asked = true
          baseURL = (await input({
            message: 'Base URL:',
            default: baseURL,
            validate: (value) => baseUrlFormRefusal(value.trim()) ?? true,
          })).trim()
        }

        const config = buildDefaultConfig(platform, [{ name: llmName, provider, model, baseURL }])
        const packageJsonPlan = planPackageJson({
          ...packageJson,
          folderName: basename(range.start),
          dependencies: projectDependencies({
            runningVersion,
            usesSubscription: usesSubscriptionModel(config),
            plugins: (config.plugins ?? []) as readonly { package?: unknown }[],
          }),
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
        const agentInstructionsPlan: ManagedBlockUpsertPlan | null = opts.writeAgentInstructions === true
          ? {
            root: dir,
            path: join(dir, ROOT_AGENT_INSTRUCTIONS_FILE),
            content: agentInstructionPointerContent(),
          }
          : null
        const completePlan = [
          ...filePlans,
          packageJsonFilePlan,
          targetGitignorePlan,
          ...(agentInstructionsPlan ? [{ root: dir, path: agentInstructionsPlan.path, content: '' }] : []),
          configPlan,
        ]
        const preflight = preflightInitPlan(completePlan)
        if (agentInstructionsPlan) preflightManagedBlock(agentInstructionsPlan)

        const knowledgeGitignorePath = join(dir, KNOWLEDGE_ROOT_DIR, '.gitignore')
        const knowledgeGitignoreWasPresent = preflight.some(
          result => result.path === knowledgeGitignorePath
            && result.classification === 'regular',
        )
        if (knowledgeGitignoreWasPresent) {
          // The refusal prints its message only, never a stack trace.
          try {
            warnForMissingKnowledgeGitignoreRules(knowledgeGitignorePath)
            verifyEffectiveGitignore({
              cwd: join(dir, KNOWLEDGE_ROOT_DIR),
              label: 'existing agent-qa-knowledge/.gitignore',
              probes: KNOWLEDGE_GITIGNORE_PROBES,
              // Nothing has been written yet at this point in the run.
              written: 'nothing',
            })
          } catch (error) {
            if (!isInitRefusal(error)) throw error
            console.error(pc.red(error.message))
            process.exitCode = 2
            return
          }
        }

        const outcomes: InitFileResult[] = []
        let boundary = 0
        const recordOutcome = (result: InitFileResult): void => {
          outcomes.push(result)
          if (result.outcome === 'preserved') return
          boundary += 1
          hooks.afterWrite?.(result, boundary)
        }

        // Written first, so no later scaffold temporary exists before its ignore rule does.
        recordOutcome(upsertManagedGitignoreBlock(
          targetGitignorePath,
          buildGitignoreEntries(),
        ))
        verifyEffectiveGitignore({
          cwd: dir,
          label: 'target .gitignore',
          probes: TARGET_GITIGNORE_PROBES,
          // The managed block is on disk by now — the refusal must not say otherwise.
          written: 'managed-gitignore',
        })

        recordOutcome(writeScaffoldFileAtomic(packageJsonFilePlan, {}))

        for (const plan of filePlans) {
          recordOutcome(writeScaffoldFileAtomic(plan, {}))
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

        if (agentInstructionsPlan) {
          try {
            recordOutcome(upsertManagedBlock(agentInstructionsPlan))
          } catch (error) {
            throw incompleteScaffoldError(error, DEFAULT_CONFIG_FILE_NAME)
          }
        }

        recordOutcome(writeConfigMarkerLast(configPlan, {}))
        hooks.onComplete?.([...outcomes])

        // AFTER the config marker — the scaffold's last write — so the event describes a
        // project that exists rather than one being attempted.
        await emitInitCompleted(outcomes)

        const installStep = await runInstallStep({
          host,
          range,
          packageJson: packageJsonPlan,
          manager: manager(),
          mode: opts.pm === 'none' ? 'none' : 'run',
          mask: maskInstallOutput,
        })

        console.log('')
        console.log(pc.green(pc.bold('✓ agent-qa project initialized!')))
        console.log('')
        printOutcomeSummary(dir, outcomes, range.start)
        const secretsPath = join(dir, DEFAULT_SECRETS_FILE)
        const secretsPreserved = outcomes.some(
          result => result.path === secretsPath && result.outcome === 'preserved',
        )
        if (hasWeb(platform) && secretsPreserved) printExampleSecretLine()
        printNextSteps(platform, config, dir)
        if (!agentInstructionsPlan) printAgentInstructionPointer()
        console.log('')
        if (installStep.outcome === 'failed') throw new CliRefusal([], 3)
      } catch (error) {
        throw asInitRefusal(error)
      }
    })

  // Commander has printed its own line; a usage error exits 2, and help returns so commander exits 0.
  cmd.exitOverride((error) => {
    if (error.exitCode !== 0) throw new CliRefusal([], 2, { cause: error })
  })

  return cmd
}
