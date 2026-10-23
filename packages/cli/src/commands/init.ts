import { Command, Option } from 'commander'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import pc from 'picocolors'
import select from '@inquirer/select'
import input from '@inquirer/input'
import checkbox from '@inquirer/checkbox'
import {
  DEFAULT_AGENT_QA_AUTH_STATES_DIR,
  DEFAULT_AGENT_QA_CACHE_DIR,
  DEFAULT_AGENT_QA_RUNTIME_DIR,
  getAgentQaVersion,
} from '@vostride/agent-qa-core'
import { getProvider, listProviders } from '@vostride/agent-qa-model'
// D-04: the scaffold's CONTENT, shared with `config.project.scaffold`. This file keeps the
// filesystem machinery and the interactive conversation; the substance being written comes from
// one producer, so the two scaffolds cannot drift.
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
// TYPE-ONLY at the top, VALUE lazily below — the same rule the `--agent` branch follows and for the
// same measured reason: this module's graph is loaded by every `init` run and by every test of one,
// and the analytics binding reaches this package's barrel (for the shipped version) which reaches
// far more of the host than a scaffold writer needs. Measured 2026-08-17: a top-level import breaks
// `init.test.ts`, whose partial `node:fs` mock does not carry every export that graph consumes.
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
  type InitFilesystemHooks,
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

// The platform vocabulary and the scaffold's content producers live in `scaffold-content.ts` now
// (D-04). Re-exported here because this module is their public door.
export { SUPPORTED_INIT_PLATFORMS, parseInitPlatform } from './scaffold-content.js'

// HOST DEFAULTS, READ HERE AND PASSED DOWN (FUNC-02). `scaffold-content.ts` may not name
// `@vostride/agent-qa-core` — the surface firewall's ledger never grows — so the two directory
// defaults are resolved on this side of the boundary and handed over as facts.
const INIT_CACHE_DIR = DEFAULT_AGENT_QA_CACHE_DIR || '.agent-qa/cache'
const INIT_AUTH_STATES_DIR = DEFAULT_AGENT_QA_AUTH_STATES_DIR || '.agent-qa/auth-states'

const PACKAGE_JSON_FILE = 'package.json'
// Kept here rather than moved: it feeds `buildGitignoreEntries`, the deliberate literal
// copy this file keeps pinned against `init-filesystem.ts`'s own — see scaffold-content.ts.
const INIT_RUNTIME_DIR = DEFAULT_AGENT_QA_RUNTIME_DIR || '.agent-qa'

function isSubscriptionProvider(provider: string): boolean {
  return getProvider(provider)?.subscription === true
}

/**
 * An `InitLLMConfig` as the registry writes it — the ONE question the provider registry answers.
 *
 * IT STAYS ON THIS SIDE OF THE BOUNDARY (FUNC-02). `needsBaseURL` and `subscription` are facts
 * about what this machine has installed, and `scaffold-content.ts` may not ask. It receives the
 * answers.
 */
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

/**
 * The interactive scaffold's config — the same shape `config.project.scaffold` renders (D-04).
 *
 * THE SIGNATURE IS UNCHANGED, deliberately: `init-config-schema.test.ts` and `init.test.ts` drive
 * it, and this function's answer is byte-identical to what it was before the shared module existed.
 * What moved is the SHAPE; what stayed is the provider resolution above and the host defaults, both
 * of which are questions about this machine rather than about a scaffold.
 */
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

// 2026-10-19 (445-04, D-40): the defaults @ai-sdk/openai and @ai-sdk/anthropic use with no baseURL.
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

// 2026-10-20 (445-14, D-32): every run starts a fresh session, so the journey asks for no reset.
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

// 2026-10-19 (445-02, D-32): a suite replaces a member's target, so the bug URL is a step.
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

// 2026-10-19 (445-03, D-40): web init's own hooks file; the proposal keeps hooks: [].
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

// 2026-10-20 (445-14, D-32): every run starts a fresh session, so the sample asks for no reset.
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

export function installedAgentQaVersion(): string {
  const version = getAgentQaVersion().trim()
  const exactSemver =
    /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u
  if (!exactSemver.test(version) || version === '0.0.0') {
    throw new Error(
      'Unable to resolve the installed agent-qa version; refusing to write a dependency range.',
    )
  }
  return version
}

function subscriptionAuthDependencyRange(): string {
  return installedAgentQaVersion()
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function configUsesSubscriptionAuth(config: Record<string, unknown>): boolean {
  const plugins = objectRecord(config.plugins)
  const authPlugins = plugins?.auth
  if (!Array.isArray(authPlugins)) return false
  return authPlugins.some(plugin => objectRecord(plugin)?.package === SUBSCRIPTION_AUTH_PACKAGE)
}

type SubscriptionAuthDependencyPlan = {
  plan: InitPathPlan
  range: string
}

type SubscriptionAuthDependencyResult = InitFileResult & {
  range: string
}

function buildSubscriptionAuthPackageDependencyPlan(
  dir: string,
): SubscriptionAuthDependencyPlan {
  const packageJsonPath = join(dir, PACKAGE_JSON_FILE)
  const classification = classifyInitPath(packageJsonPath, dir)
  const existing = classification === 'regular'
    ? readFileSync(packageJsonPath, 'utf-8')
    : null
  const pkg = existing === null
    ? { private: true } as Record<string, unknown>
    : JSON.parse(existing) as Record<string, unknown>

  if (!objectRecord(pkg)) {
    throw new Error(`${PACKAGE_JSON_FILE} must contain a JSON object to add ${SUBSCRIPTION_AUTH_PACKAGE}`)
  }

  const dependencyBlocks = [
    'devDependencies',
    'dependencies',
    'optionalDependencies',
    'peerDependencies',
  ] as const
  const existingBlock = dependencyBlocks.find(blockName => {
    const block = objectRecord(pkg[blockName])
    return block && Object.prototype.hasOwnProperty.call(block, SUBSCRIPTION_AUTH_PACKAGE)
  })
  const targetBlock = existingBlock ?? 'devDependencies'
  const range = subscriptionAuthDependencyRange()
  let changed = existing === null
  const existingTargetDependencies = objectRecord(pkg[targetBlock])
  if (existingTargetDependencies?.[SUBSCRIPTION_AUTH_PACKAGE] !== range) {
    changed = true
  }
  const targetDependencies = {
    ...(existingTargetDependencies ?? {}),
    [SUBSCRIPTION_AUTH_PACKAGE]: range,
  }

  pkg[targetBlock] = targetDependencies
  for (const blockName of dependencyBlocks) {
    if (blockName === targetBlock) continue
    const block = objectRecord(pkg[blockName])
    if (!block || !Object.prototype.hasOwnProperty.call(block, SUBSCRIPTION_AUTH_PACKAGE)) continue
    changed = true
    const nextBlock = { ...block }
    delete nextBlock[SUBSCRIPTION_AUTH_PACKAGE]
    if (Object.keys(nextBlock).length > 0) pkg[blockName] = nextBlock
    else delete pkg[blockName]
  }

  const content = existing !== null && !changed
    ? existing
    : `${JSON.stringify(pkg, null, 2)}\n`
  return {
    plan: {
      path: packageJsonPath,
      root: dir,
      content,
      force: existing !== null && changed,
    },
    range,
  }
}

export function upsertSubscriptionAuthPackageDependency(
  dir: string,
  hooks: InitFilesystemHooks = {},
): SubscriptionAuthDependencyResult {
  const dependency = buildSubscriptionAuthPackageDependencyPlan(dir)
  return {
    ...writeScaffoldFileAtomic(dependency.plan, hooks),
    range: dependency.range,
  }
}

export function defaultModelForProvider(provider: string): string {
  return getProvider(provider)?.defaultModel ?? 'model-name'
}

const DEFAULT_HOOKS_FILE = 'hooks.yaml'
const DEFAULT_ENV_FILE = '.env'
const DEFAULT_SECRETS_FILE = '.env.secrets.local'
const SECRETS_FILE_MODE = 0o600
export const EXAMPLE_SECRET_LINE = 'KOMAZON_PASSWORD=komazon123'

// 2026-10-19 (445-03, D-09): applied only when init creates the file (preserveOnForce).
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
    // 394 (T-394-03): the draft shelf, which lives INSIDE `tests/` because that is the only
    // location a run will admit — see the two-sided admission note in
    // `composition/local-agent-host.ts`. Spelled literally here for the same reason the durable
    // temporary rule below is: init-filesystem.js is mocked wholesale by the init suite, and
    // `TARGET_GITIGNORE_ENTRIES` is the other copy the agreement test pins this against.
    'tests/.agent-qa-drafts/',
    'node_modules/',
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

function buildLocalConfigTemplate(): string {
  return `# This file is for machine-specific device, app, and provider bindings.
# Keep it out of git.
# Add agent-qa.local.yaml to .gitignore.

devices:
  # Example local device binding:
  # android-emu:
  #   avd: Pixel_8_API_35

apps:
  # Example app install binding:
  # example-android:
  #   path: apps/example.apk

providers:
  # Example cloud provider credentials:
  # browserstack:
  #   username: ${'${BROWSERSTACK_USERNAME}'}
  #   accessKey: ${'${BROWSERSTACK_ACCESS_KEY}'}
`
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

// The committed/derived split below is verbatim from spec/v2/knowledge-store.md §4 — do not
// paraphrase. Future-shelf lines (skills/.staging/) ship now so the split never needs a later
// edit (D-13).
//
// The final rule is a DELIBERATE DIVERGENCE from that spec section and is labelled as such in
// the emitted file. It is not part of the committed/derived split; it is an operational rule
// for this tool's own publication temporaries. It has to live here rather than in the project
// .gitignore because a knowledge tree is routinely its own repository — measured: a nested
// repository does not inherit its parent's .gitignore — and because `init` verifies the
// knowledge root BEFORE the project managed block exists.
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

// D-12: comment-only — zero active rules. An un-authored active rule would be
// sovereign prompt bytes on every run. HTML comments are stripped at serve time,
// so this scaffold is an empty policy until a human writes a rule below it.
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

// D-14: the substantive human entry point for the committed knowledge root.
// 2026-10-02 (432-40, D-24): the README states the guide's rule — knowledge changes only through
// agent-qa, applies at once, and wrong knowledge is corrected by new feedback or forget — and no
// longer cites a design-doc path a user's checkout does not have (431 D7 friction). Its other D7
// items (policies/global.md's wording, CLI/MCP setup, `<build>`/`--kind`) stay with M7 (D-21).
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

function connectionSteps(config: Record<string, unknown>, dir: string): InitNextStep[] {
  const registry = config.registry as Record<string, unknown> | undefined
  const llms = (registry?.llms ?? []) as InitLLMConfig[]
  const steps: InitNextStep[] = []
  const usesSubscription = llms.some(llm => isSubscriptionProvider(String(llm.provider)))
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

// 2026-10-19 (445-05, D-17): the same commands, in the same order, as the published quickstart.
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
  if (!hasWeb(platform)) {
    steps.push({ command: 'Edit agent-qa.local.yaml', description: 'Bind your mobile app' })
  }
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

// 431 D-20: the config marker is init's completion record, so a root block that fails to publish
// must say the scaffold is incomplete rather than leave a half-written project looking done.
function incompleteScaffoldError(error: unknown): Error {
  const reason = error instanceof Error ? error.message : String(error)
  return new Error(
    `${reason}\nThe other scaffold files were written, but agent-qa.config.yaml was not written, `
    + 'so this project is not initialized. Fix the cause above and rerun agent-qa init; '
    + 'files it already wrote are kept.',
    { cause: error },
  )
}

// 431 D-18: printed flush left, because an indented marker line is not a marker and the managed
// writer would refuse the pasted file as ambiguous.
function printAgentInstructionPointer(): void {
  console.log('')
  console.log(`  Coding agents: add this block to ${ROOT_AGENT_INSTRUCTIONS_FILE} at the project root:`)
  console.log('')
  console.log(agentInstructionPointerBlock())
}

export interface InitCommandHooks {
  afterWrite?: (result: InitFileResult, boundary: number) => void
  onComplete?: (outcomes: readonly InitFileResult[]) => void
  /**
   * How this invocation composes its analytics (398-10).
   *
   * A seam for the same reason the two hooks above are: `init` writes into a directory, and the
   * production composition resolves the real identity store. A suite substitutes it to observe the
   * one event this command emits without touching a home directory.
   */
  composeAnalytics?: typeof ComposeAnalyticsHost
  isTTY?: boolean
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
    scaffoldFilePlan(
      dir,
      DEFAULT_LOCAL_CONFIG_FILE,
      buildLocalConfigTemplate(),
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
    // 431 D-17: agent-qa's generated file, so --force regenerates it (not preserveOnForce).
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
    // 419-POLICY-WRITER: init scaffold
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

function displayInitPath(dir: string, path: string): string {
  const localPath = relative(dir, path)
  return localPath.length > 0 ? localPath : path
}

function printOutcomeSummary(dir: string, outcomes: readonly InitFileResult[]): void {
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
      console.log(`    ${pc.dim('•')} ${displayInitPath(dir, result.path)}`)
    }
  }
}

// 2026-10-19 (445-03, D-27): printed flush left so the line can be pasted as is.
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
    .option('--dir <path>', 'target directory', process.cwd())
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
    .option(
      WRITE_AGENT_INSTRUCTIONS_FLAG,
      'also write the agent-qa pointer block into AGENTS.md at the project root',
    )
    .option(
      '--agent',
      'print the JSON capability manifest (catalog, v1 name map, local posture) and exit; '
      + 'writes nothing',
    )
    .action(async (opts, command: Command) => {
      // `--agent` IS A READ, AND IT RETURNS BEFORE ANYTHING ELSE HAPPENS (D-16). Ahead of it lies
      // the whole of init: prompts, a scaffold plan, files. Returning here rather than threading a
      // flag through the prompt checks is what makes "non-interactive, idempotent, writes nothing" a
      // property of the control flow instead of a claim about it — there is no branch below this
      // one that a manifest read can reach.
      if (opts.agent === true) {
        // IMPORTED HERE AND NOT AT THE TOP, deliberately. The manifest reads the local
        // composition's posture, so its module graph reaches the agent host — and `init`'s ordinary
        // job is to write a scaffold into a directory where no host could compose yet. A top-level
        // import would make every `init` run (and every test of one) evaluate a composition root
        // that only this branch has any use for. Measured 2026-08-17: it also broke `init.test.ts`,
        // whose partial `node:fs` mock the durable-store module underneath that graph needs more of.
        const { buildAgentManifest } = await import('../capability-catalog/manifest.js')
        const globalOpts = command.parent?.opts<{ config?: string }>() ?? {}
        // `--dir`-relative when no explicit `--config` was given: `init` is a command aimed at a
        // directory, and reporting a posture read out of the caller's shell instead would describe
        // the wrong workspace.
        const configPath = globalOpts.config ?? join(resolve(opts.dir), 'agent-qa.config.yaml')
        const manifest = await buildAgentManifest({ configPath })
        // STDOUT AND NOTHING ELSE ON IT. The whole of this command's output under `--agent` is one
        // JSON document, so it pipes into a parser without a filter in between.
        console.log(JSON.stringify(manifest, null, 2))
        // 2026-08-17 (Phase 398 plan 10, D-16/D-18): AND NOTHING IS EMITTED ON THIS PATH. `--agent`
        // is a READ — it writes no file, creates no project, and returns before any scaffold exists
        // — so there is no init to report the completion of. Reporting one would count every
        // manifest read a coding agent makes as a project being initialised, which is the single
        // number this member exists to get right.
        return
      }

      const initStartedAt = Date.now()
      const dir = resolve(opts.dir)
      const force = opts.force ?? false
      // 398-14 (D-19): the ONE path the opt-out read consults, resolved once. Same derivation the
      // `--agent` branch above already uses — `--dir`-relative unless an explicit `--config` was
      // given — because `init` is a command aimed at a directory, and honouring a declaration out
      // of the caller's shell instead would be honouring the wrong project's.
      const analyticsConfigPath =
        command.parent?.opts<{ config?: string }>().config ?? join(dir, 'agent-qa.config.yaml')

      const tty = hooks.isTTY ?? process.stdin.isTTY === true
      let asked = false

      /**
       * The init/scaffold member (398-10, D-18), emitted from the ONE place that knows how the run
       * ended — which is why it is a function called from two sites rather than a line at one.
       *
       * The outcome is DERIVED from the file outcomes, never assumed: anything created makes this a
       * `created`, anything only rewritten an `updated`, and a run that changed nothing an
       * `unchanged`. `preserved` is the filesystem layer's word for a file left alone, and it is
       * what makes the third arm reachable — including through the "already initialized, use
       * --force" answer below, which is the common way a person reaches it.
       *
       * `failed` is not emitted from here and cannot be: a scaffold that throws never reaches
       * either call site. Retune: a `failed` arm needs a catch around the whole write phase, which
       * is a change to how this command reports errors, not to what it measures.
       *
       * The binding is imported LAZILY for the reason recorded at the type-only import up top.
       */
      const emitInitCompleted = async (
        results: readonly { readonly outcome: InitFileResult['outcome'] }[],
      ): Promise<void> => {
        const { analyticsEvent, composeAnalyticsHost } = await import(
          '../composition/analytics-host.js'
        )
        // 398-14 (D-19): the config THIS COMMAND IS OPERATING ON is read here and handed to the one
        // opt-out decision — `analyticsConfigPath` above, i.e. the global `--config` when given and
        // otherwise the target directory's own config file, resolved once at the top of the action.
        //
        // An absent or unresolvable config yields `undefined`, and that is a real posture rather
        // than a gap: a fresh directory genuinely has no declaration to honour yet, and refusing to
        // scaffold over a telemetry read would be refusing the capability over the telemetry
        // (`mcp.ts`'s ratified try/catch). `resolveConfig` is imported lazily for the same measured
        // reason the analytics binding is — see the type-only import up top.
        // Both readers come from the SAME lazy import — the module-graph reason above applies to
        // the pair, and taking them together also makes it structurally impossible for the raw
        // privacy read to drift onto a different module than the validating read.
        const { readAnalyticsPrivacyDeclaration, resolveConfig } = await import('../config.js')
        let config: Awaited<ReturnType<typeof resolveConfig>> | undefined
        try {
          config = await resolveConfig({
            configPath: analyticsConfigPath,
            loadAuthPlugins: false,
          })
        } catch {
          config = undefined
        }
        // F-1 / CR-01, at init's root: see the note at chat.ts's composition. `analyticsConfigPath`
        // is reused verbatim, so the declaration is read from the same file this action already
        // decided its config lives in — including the `--config` case.
        const analyticsConfig = config ?? await readAnalyticsPrivacyDeclaration(analyticsConfigPath)
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

      const refuseBaseUrl = (provider: string): boolean => {
        const refusal = opts.baseUrl === undefined ? undefined : baseUrlRefusal(provider, opts.baseUrl)
        if (refusal) {
          console.error(pc.red(refusal))
          process.exitCode = 1
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

      const configPath = join(dir, 'agent-qa.config.yaml')
      const configClassification = classifyInitPath(configPath, dir)
      if (configClassification === 'regular' && !force) {
        const completed = [{ path: configPath, outcome: 'preserved' }] as const
        console.log(pc.yellow(`Project is already initialized at ${dir}. Use --force to rebuild it.`))
        printOutcomeSummary(dir, completed)
        hooks.onComplete?.(completed)
        await emitInitCompleted(completed)
        return
      }

      const config = buildDefaultConfig(platform, [{ name: llmName, provider, model, baseURL }])
      const usesSubscriptionAuth = configUsesSubscriptionAuth(config)
      const subscriptionAuthDependency = usesSubscriptionAuth
        ? buildSubscriptionAuthPackageDependencyPlan(dir)
        : null
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
        ...(subscriptionAuthDependency ? [subscriptionAuthDependency.plan] : []),
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
        // 2026-10-20 (445-17, D-43): the refusal prints its message only, never a stack trace.
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
          console.error(pc.red(error instanceof Error ? error.message : String(error)))
          process.exitCode = 1
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

      // The managed block goes down FIRST, before any other write can create a temporary.
      // Every scaffold write publishes through a sibling temporary carrying the
      // destination's own content, and until this block exists no rule covers that name —
      // so ordering it after the scaffold loop left a window in which `.env.secrets.local`'s
      // 0600 temporary was untracked and `git add .` could pick it up. The single temporary
      // this cannot cover is its own, whose content is .gitignore bytes and never a
      // credential.
      //
      // CORRECTION (round 10): that "single temporary" claim was measured against THIS root
      // only. A knowledge tree that is its own repository does not inherit this file, so the
      // knowledge root has its own first-write rule — see `buildScaffoldFilePlans`, where the
      // knowledge `.gitignore` now leads its group for exactly this reason. One uncovered
      // temporary per root, each of them a `.gitignore`'s own.
      //
      // Verifying here does NOT make "no files were changed" true — this write has already
      // happened. The refusal states what actually happened instead; see `changed` below.
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

      if (subscriptionAuthDependency) {
        recordOutcome(writeScaffoldFileAtomic(subscriptionAuthDependency.plan, {}))
      }

      if (agentInstructionsPlan) {
        try {
          recordOutcome(upsertManagedBlock(agentInstructionsPlan))
        } catch (error) {
          throw incompleteScaffoldError(error)
        }
      }

      recordOutcome(writeConfigMarkerLast(configPlan, {}))
      hooks.onComplete?.([...outcomes])

      // AFTER the config marker — the scaffold's last write — so the event describes a project
      // that exists rather than one being attempted.
      await emitInitCompleted(outcomes)

      console.log('')
      console.log(pc.green(pc.bold('✓ agent-qa project initialized!')))
      console.log('')
      printOutcomeSummary(dir, outcomes)
      const secretsPath = join(dir, DEFAULT_SECRETS_FILE)
      const secretsPreserved = outcomes.some(
        result => result.path === secretsPath && result.outcome === 'preserved',
      )
      if (hasWeb(platform) && secretsPreserved) printExampleSecretLine()
      printNextSteps(platform, config, dir)
      if (!agentInstructionsPlan) printAgentInstructionPointer()
      console.log('')
    })

  return cmd
}
