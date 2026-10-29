// a v1-shaped workspace survives the documented hard cut

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, sep } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import {
  generateHookId,
  generateRunId,
  generateSuiteId,
  generateTestId,
} from '@vostride/agent-qa-ids'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { EXAMPLE_SECRET_LINE } from '../../commands/init.js'
import { HARD_CUT_STEPS } from '../../hard-cut.js'
import {
  ANCHORED_BUILDS,
  CLI_ENTRY,
  REBUILD_INSTRUCTION,
  buildFreshness,
  cleanupTempRoots,
  hermeticEnv,
  trackTempRoot,
} from './spawned-chat.js'

const INIT_ARGS = ['init', '--force', '--platform', 'web', '--llm', 'codex']
const OLD_INIT_LINE = "Run 'agent-qa init'"
const USER_TESTS = ['tests/checkout-smoke.yaml', 'tests/account/profile.yaml']
const KEPT = [...USER_TESTS, '.env', '.env.secrets.local']
const RULES_ASIDE = 'rules-before-v2'
const POLICIES = 'agent-qa-knowledge/policies'
const V1_RULES_FILE = 'agent-rules.md'
const STATE_DIRS = ['.agent-qa/', 'agent-qa-knowledge/', 'agent-qa-memory/']
const V1_EXAMPLES = [
  'tests/example-pass.yaml',
  'tests/example-fail.yaml',
  'tests/hacker-news-top-story.yaml',
  'tests/bad-a11y.yaml',
  'tests/automation-exercise/',
  'suites/automation-exercise.suite.yaml',
  'scripts/fetch-hn-top-story.mjs',
  V1_RULES_FILE,
]
const V1_AUTOMATION_TESTS = ['home-smoke', 'products-smoke', 'cart-smoke'].map(
  (name) => `tests/automation-exercise/${name}.yaml`,
)
const NEW_EXAMPLES = [
  'tests/examples/komazon-checkout.yaml',
  'tests/examples/komazon-cart-total-bug.yaml',
  'tests/examples/komazon-shipping-hook.yaml',
  'suites/examples.suite.yaml',
  'scripts/examples/make-shipping-address.mjs',
]
const POLICY_RULE = '- Dismiss the cookie banner before checking a price.'
const AGENT_RULE = '- Prefer the search box over the category menu.'
const PRE_445_KNOWLEDGE_RULES = [
  'memory/index/',
  'memory/queue/',
  '.lease',
  '.epoch',
  '**/artifacts/',
  'skills/.staging/',
  '.*.agent-qa-init-*.tmp',
]

interface Leg {
  code: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
}

interface Scene {
  root?: string
  firstValidate?: Leg
  filesBeforeDaemonStop?: Record<string, string>
  daemonStop?: Leg
  daemonStopAgain?: Leg
  filesAfterDaemonStop?: Record<string, string>
  daemonStatus?: Leg
  refusedInit?: Leg
  configKeptAfterRefusal?: boolean
  treeKeptAfterRefusal?: boolean
  init?: Leg
  validate?: Leg
  secondInit?: Leg
  keptBefore?: Record<string, string>
  keptAfter?: Record<string, string>
  secretsMode?: string
  v1Recreated?: string[]
  examplesPresent?: Record<string, boolean>
  globalPolicy?: string
  treeBeforeSecondInit?: Record<string, string>
  treeAfterSecondInit?: Record<string, string>
  error?: string
}

const scene: Scene = {}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function write(root: string, path: string, content: string, mode?: number): void {
  const absolute = join(root, path)
  mkdirSync(dirname(absolute), { recursive: true })
  writeFileSync(absolute, content, mode === undefined ? 'utf8' : { encoding: 'utf8', mode })
}

function output(leg: Leg | undefined): string {
  return leg === undefined ? '' : `${leg.stdout}${leg.stderr}`
}

function cli(root: string, args: readonly string[]): Leg {
  const result = spawnSync(process.execPath, [CLI_ENTRY, ...args], {
    cwd: root,
    env: { ...hermeticEnv(root), CI: 'true', NO_COLOR: '1' },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (result.error) throw result.error
  return {
    code: result.status,
    signal: result.signal,
    stdout: result.stdout,
    stderr: result.stderr,
  }
}

function git(root: string, args: readonly string[]): void {
  const result = spawnSync('git', args, { cwd: root, env: hermeticEnv(root), stdio: 'ignore' })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} exited ${result.status}`)
}

function tree(root: string): Record<string, string> {
  const files: Record<string, string> = {}
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      const local = relative(root, path).split(sep).join('/')
      if (local === '.git' || local === '.agent-qa') continue
      if (entry.isDirectory()) walk(path)
      else files[local] = sha256(path)
    }
  }
  walk(root)
  return Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)))
}

function everyFile(root: string): Record<string, string> {
  const files: Record<string, string> = {}
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      const local = relative(root, path).split(sep).join('/')
      if (local === '.git') continue
      if (entry.isDirectory()) walk(path)
      else files[local] = sha256(path)
    }
  }
  walk(root)
  return Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)))
}

function hashes(root: string, paths: readonly string[]): Record<string, string> {
  return Object.fromEntries(
    paths.map((path) => [path, existsSync(join(root, path)) ? sha256(join(root, path)) : 'absent']),
  )
}

function v1Config(): string {
  return [
    'workspace:',
    '  testMatch:',
    '    - tests/**/*.yaml',
    '  suiteMatch:',
    '    - suites/**/*.suite.yaml',
    '  hooksFile: hooks.yaml',
    `  agentRules: ./${V1_RULES_FILE}`,
    '  envFile: .env',
    '  secretsFile: .env.secrets.local',
    'services:',
    '  cache:',
    '    dir: .agent-qa/cache',
    '    ttl: 7d',
    '  memory:',
    '    enabled: true',
    '    provider: local',
    '    dir: agent-qa-memory',
    'registry:',
    '  llms:',
    '    - name: claude-subscription',
    '      provider: anthropic-subscription',
    '      model: claude-sonnet-4-6',
    '      screenshotSize: 50kb',
    '      effectiveResolution: 500',
    '  targets:',
    '    example-web:',
    '      platform: web',
    '      url: https://example.com',
    '    automation-exercise:',
    '      platform: web',
    '      url: https://automationexercise.com',
    '    wai-bad:',
    '      platform: web',
    '      url: https://www.w3.org/WAI/demos/bad/before/home.html',
    'plugins:',
    '  auth:',
    '    - package: "@vostride/agent-qa-subscription-auth"',
    'use:',
    '  timeout:',
    '    step: 5m',
    '    test: 30m',
    '    navigation: 1m',
    '  healing:',
    '    maxAttempts: 3',
    '  planner:',
    '    maxSubActions: 10',
    '    previousStepCount: 5',
    '  llm: claude-subscription',
    '',
  ].join('\n')
}

function v1Test(
  name: string,
  target: string,
  steps: readonly string[],
  testId = generateTestId(),
): string {
  return [
    `test-id: ${testId}`,
    `name: ${name}`,
    `target: ${target}`,
    'steps:',
    ...steps.map((step) => `  - ${step}`),
    '',
  ].join('\n')
}

function writeRunsDatabase(path: string): void {
  mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path)
  try {
    db.exec('CREATE TABLE runs (id TEXT PRIMARY KEY, status TEXT NOT NULL)')
    db.prepare('INSERT INTO runs (id, status) VALUES (?, ?)').run(generateRunId(), 'passed')
  } finally {
    db.close()
  }
}

function buildV1Workspace(): string {
  const root = trackTempRoot(mkdtempSync(join(tmpdir(), 'agent-qa-445-11-hard-cut-')))
  git(root, ['init', '--quiet'])
  write(root, 'agent-qa.config.yaml', v1Config())
  write(root, V1_RULES_FILE, `# agent-qa Rules\n\n${AGENT_RULE}\n`)
  write(root, 'agent-qa-memory/memories.jsonl', '{"text":"The cart badge counts items."}\n')
  writeRunsDatabase(join(root, '.agent-qa', 'dashboard.sqlite'))
  write(root, '.agent-qa/cache/5f0c2a.json', '{"step":"Click Add to cart","action":"click"}\n')
  write(root, 'agent-qa-knowledge/.gitignore', [...PRE_445_KNOWLEDGE_RULES, ''].join('\n'))
  write(root, `${POLICIES}/global.md`, `# Global policy\n\n${POLICY_RULE}\n`)
  write(root, 'tests/example-pass.yaml', v1Test('Example passing test', 'example-web', [
    'Verify the page says "Example Domain"',
  ]))
  write(root, 'tests/example-fail.yaml', v1Test('Example failing test', 'example-web', [
    'Verify the page says "Not Example Domain"',
  ]))
  const hookId = generateHookId()
  write(root, 'tests/hacker-news-top-story.yaml', [
    `test-id: ${generateTestId()}`,
    'name: Hacker News top story hook demo',
    'target: example-web',
    'setup:',
    `  - ${hookId}`,
    'steps:',
    '  - Verify the page shows "{{env:HN_FIRST_STORY_TITLE}}"',
    '',
  ].join('\n'))
  write(root, 'tests/bad-a11y.yaml', v1Test('W3C BAD accessibility demo', 'wai-bad', [
    'Verify the page says "Welcome to CityLights"',
  ]))
  const automationIds = V1_AUTOMATION_TESTS.map(() => generateTestId())
  V1_AUTOMATION_TESTS.forEach((path, index) => {
    write(root, path, v1Test('Automation Exercise smoke', 'automation-exercise', [
      'Verify the page says "Automation Exercise"',
    ], automationIds[index]))
  })
  write(root, 'suites/automation-exercise.suite.yaml', [
    `suite-id: ${generateSuiteId()}`,
    'name: Automation Exercise demo suite',
    'target: automation-exercise',
    'tests:',
    ...V1_AUTOMATION_TESTS.flatMap((path, index) => [
      `  - test: ${path}`,
      `    id: ${automationIds[index]}`,
    ]),
    '',
  ].join('\n'))
  write(root, 'scripts/fetch-hn-top-story.mjs', "import { writeFile } from 'node:fs/promises'\n")
  write(root, 'hooks.yaml', [
    'hooks:',
    `  - id: ${hookId}`,
    '    name: Fetch first Hacker News story',
    '    runtime: node',
    '    file: scripts/fetch-hn-top-story.mjs',
    '    timeout: 30s',
    '    network: true',
    '',
  ].join('\n'))
  write(root, 'agent-qa.local.yaml', 'devices:\napps:\nproviders:\n')
  write(root, '.gitignore', [
    '.agent-qa/',
    '.agent-qa/auth-states/',
    'node_modules/',
    'agent-qa.local.yaml',
    '.env',
    '.env.secrets.local',
    '',
  ].join('\n'))
  write(root, 'package.json', `${JSON.stringify({
    private: true,
    devDependencies: { '@vostride/agent-qa-subscription-auth': '*' },
  }, null, 2)}\n`)
  write(root, '.env', 'C445_OWN_ENV=kept-value\n')
  write(root, '.env.secrets.local', '', 0o600)
  for (const path of USER_TESTS) {
    write(root, path, v1Test(`Own test ${path}`, 'komazon', [
      'Open the account menu',
      'Verify the page shows "Your orders"',
    ]))
  }
  return root
}

function applyDocumentedSteps(root: string): void {
  const aside = join(root, RULES_ASIDE)
  mkdirSync(aside)
  for (const name of readdirSync(join(root, POLICIES)).filter((name) => name.endsWith('.md'))) {
    copyFileSync(join(root, POLICIES, name), join(aside, name))
  }
  copyFileSync(join(root, V1_RULES_FILE), join(aside, V1_RULES_FILE))
  for (const path of [...STATE_DIRS, ...V1_EXAMPLES]) {
    rmSync(join(root, path), { recursive: true, force: true })
  }
}

function pasteRulesBack(root: string): void {
  const aside = join(root, RULES_ASIDE)
  const pasted = readdirSync(aside)
    .sort()
    .map((name) => readFileSync(join(aside, name), 'utf8'))
    .join('\n')
  const global = join(root, POLICIES, 'global.md')
  writeFileSync(global, `${readFileSync(global, 'utf8')}\n${pasted}`, 'utf8')
  rmSync(aside, { recursive: true, force: true })
}

function drive(): void {
  const root = buildV1Workspace()
  scene.root = root
  scene.keptBefore = hashes(root, KEPT)
  scene.firstValidate = cli(root, ['validate'])
  scene.filesBeforeDaemonStop = everyFile(root)
  scene.daemonStop = cli(root, ['daemon', 'stop'])
  scene.daemonStopAgain = cli(root, ['daemon', 'stop'])
  scene.filesAfterDaemonStop = everyFile(root)
  scene.daemonStatus = cli(root, ['daemon', 'status'])
  const config =readFileSync(join(root, 'agent-qa.config.yaml'), 'utf8')
  const beforeRefusal = tree(root)
  scene.refusedInit = cli(root, INIT_ARGS)
  scene.configKeptAfterRefusal = readFileSync(join(root, 'agent-qa.config.yaml'), 'utf8') === config
  scene.treeKeptAfterRefusal = JSON.stringify(tree(root)) === JSON.stringify(beforeRefusal)
  applyDocumentedSteps(root)
  scene.init = cli(root, INIT_ARGS)
  pasteRulesBack(root)
  scene.validate = cli(root, ['validate'])
  scene.keptAfter = hashes(root, KEPT)
  scene.secretsMode = (statSync(join(root, '.env.secrets.local')).mode & 0o777).toString(8)
  scene.v1Recreated = [...V1_EXAMPLES, ...V1_AUTOMATION_TESTS].filter((path) =>
    existsSync(join(root, path)),
  )
  scene.examplesPresent = Object.fromEntries(
    NEW_EXAMPLES.map((path) => [path, existsSync(join(root, path))]),
  )
  scene.globalPolicy = readFileSync(join(root, POLICIES, 'global.md'), 'utf8')
  scene.treeBeforeSecondInit = tree(root)
  scene.secondInit = cli(root, INIT_ARGS)
  scene.treeAfterSecondInit = tree(root)
}

function seen(): string {
  return JSON.stringify(
    scene,
    (_key, value: unknown) =>
      typeof value === 'string' && value.length > 1200 ? `…${value.slice(-1200)}` : value,
    2,
  )
}

function exited(
  leg: Leg | undefined,
): { code: number | null; signal: NodeJS.Signals | null } | undefined {
  return leg === undefined ? undefined : { code: leg.code, signal: leg.signal }
}

function assertFreshBuild(): void {
  const freshness = buildFreshness(ANCHORED_BUILDS)
  expect(
    { missing: freshness.missing, stale: freshness.stale },
    `these cells drive the built CLI: ${REBUILD_INSTRUCTION}`,
  ).toEqual({ missing: [], stale: [] })
}

describe('upgrading a v1 workspace', () => {
  beforeAll(() => {
    if (process.platform === 'win32') throw new Error('POSIX run lifecycle required; never skip')
    try {
      drive()
    } catch (error) {
      scene.error = message(error)
    }
  })

  afterAll(() => {
    cleanupTempRoots()
  })

  it('a v1 workspace is told the hard cut steps by its first command', () => {
    assertFreshBuild()
    expect(scene.error, seen()).toBeUndefined()
    expect(exited(scene.firstValidate), seen()).toEqual({ code: 1, signal: null })
    const text = output(scene.firstValidate)
    expect(text, seen()).toContain(HARD_CUT_STEPS)
    expect(text, seen()).toContain('agent-qa init --force')
    expect(text, seen()).toContain('agent-qa-memory/')
    expect(text, seen()).not.toContain(OLD_INIT_LINE)
  })

  it('daemon stop on a v1 config says nothing to stop twice and changes no file, and daemon status still names the hard cut', () => {
    assertFreshBuild()
    expect(scene.error, seen()).toBeUndefined()
    const firstStep = HARD_CUT_STEPS.split('\n')[0]!
    for (const leg of [scene.daemonStop, scene.daemonStopAgain]) {
      expect(leg?.signal, seen()).toBeNull()
      const text = output(leg)
      expect(text, seen()).toContain('agent-qa daemon has nothing to stop')
      expect(text, seen()).not.toContain('Config validation failed')
      expect(text, seen()).not.toContain(firstStep)
    }
    expect(scene.daemonStopAgain?.code, seen()).toBe(scene.daemonStop?.code)
    expect(Object.keys(scene.filesBeforeDaemonStop ?? {}).length, seen()).toBeGreaterThan(0)
    expect(scene.filesAfterDaemonStop, seen()).toEqual(scene.filesBeforeDaemonStop)
    expect(exited(scene.daemonStatus), seen()).toEqual({ code: 1, signal: null })
    expect(output(scene.daemonStatus), seen()).toContain(HARD_CUT_STEPS)
  })

  it('init --force over the old knowledge root refuses and names the missing rule', () => {
    assertFreshBuild()
    expect(scene.error, seen()).toBeUndefined()
    expect(scene.refusedInit?.signal, seen()).toBeNull()
    expect(scene.refusedInit?.code, seen()).not.toBe(0)
    expect(output(scene.refusedInit), seen()).toContain('Add ".writer-authority.sqlite*"')
    expect(scene.configKeptAfterRefusal, `the refusal wrote no config\n${seen()}`).toBe(true)
    expect(scene.treeKeptAfterRefusal, `the refusal changed no file\n${seen()}`).toBe(true)
  })

  it('the old knowledge gitignore refusal prints its message and exits 1 with no stack frame', () => {
    assertFreshBuild()
    expect(scene.error, seen()).toBeUndefined()
    expect(exited(scene.refusedInit), seen()).toEqual({ code: 1, signal: null })
    const text = output(scene.refusedInit)
    expect(text, seen()).toContain('Add ".writer-authority.sqlite*"')
    const lines = text.split('\n')
    expect(lines.filter((line) => /^\s+at\s/u.test(line)), seen()).toEqual([])
    expect(lines.filter((line) => line.includes('throw new Error(')), seen()).toEqual([])
  })

  it('after the documented steps the users tests are byte identical and validate is clean', () => {
    assertFreshBuild()
    expect(scene.error, seen()).toBeUndefined()
    expect(exited(scene.init), seen()).toEqual({ code: 0, signal: null })
    expect(Object.keys(scene.keptBefore ?? {}), seen()).toEqual(KEPT)
    for (const path of KEPT) {
      expect(scene.keptBefore?.[path], `${path} existed before the cut\n${seen()}`)
        .not.toBe('absent')
      expect(scene.keptAfter?.[path], `${path} is byte identical after the cut\n${seen()}`)
        .toBe(scene.keptBefore?.[path])
    }
    expect(scene.secretsMode, seen()).toBe('600')
    expect(exited(scene.validate), seen()).toEqual({ code: 0, signal: null })
    expect(output(scene.validate), seen()).toContain('All files valid')
    expect(scene.v1Recreated, seen()).toEqual([])
    expect(scene.globalPolicy, seen()).toContain(POLICY_RULE)
    expect(scene.globalPolicy, seen()).toContain(AGENT_RULE)
  })

  it('the new examples are present and the preserved secrets file gets the printed line', () => {
    assertFreshBuild()
    expect(scene.error, seen()).toBeUndefined()
    expect(exited(scene.init), seen()).toEqual({ code: 0, signal: null })
    expect(scene.examplesPresent, seen()).toEqual(
      Object.fromEntries(NEW_EXAMPLES.map((path) => [path, true])),
    )
    expect(EXAMPLE_SECRET_LINE).toBe('KOMAZON_PASSWORD=komazon123')
    expect(output(scene.init).split('\n'), seen()).toContain(EXAMPLE_SECRET_LINE)
    expect(scene.keptAfter?.['.env.secrets.local'], seen())
      .toBe(scene.keptBefore?.['.env.secrets.local'])
  })

  it('a second init force changes no byte', () => {
    assertFreshBuild()
    expect(scene.error, seen()).toBeUndefined()
    expect(exited(scene.secondInit), seen()).toEqual({ code: 0, signal: null })
    const before = scene.treeBeforeSecondInit ?? {}
    expect(Object.keys(before), seen()).toEqual(
      expect.arrayContaining([...KEPT, ...NEW_EXAMPLES, 'agent-qa.config.yaml']),
    )
    expect(scene.treeAfterSecondInit, seen()).toEqual(before)
  })

})
