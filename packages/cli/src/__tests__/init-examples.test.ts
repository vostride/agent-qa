// Init writes the Komazon examples; the example secret goes only into a created secrets file.
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest'
import { Command } from 'commander'
import { parse as parseYaml } from 'yaml'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { stripVTControlCharacters } from 'node:util'

vi.mock('node:fs', () => ({
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(() => ''),
}))

vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
  execFileSync: vi.fn(),
}))

vi.mock('../commands/init-filesystem.js', async () => {
  const fs = await import('node:fs')
  const writePlan = (plan: {
    path: string
    content: string | Uint8Array
    force?: boolean
    preserveOnForce?: boolean
  }) => {
    const exists = fs.existsSync(plan.path)
    if (exists && (!plan.force || plan.preserveOnForce)) {
      return { path: plan.path, outcome: 'preserved' as const }
    }
    fs.writeFileSync(plan.path, plan.content)
    return { path: plan.path, outcome: exists ? 'updated' as const : 'created' as const }
  }

  return {
    KNOWLEDGE_GITIGNORE_PROBES: [],
    TARGET_GITIGNORE_PROBES: [],
    classifyInitPath: vi.fn((path: string) => fs.existsSync(path) ? 'regular' : 'missing'),
    preflightInitPlan: vi.fn((plans: Array<{ path: string }>) => plans.map(plan => ({
      path: plan.path,
      classification: fs.existsSync(plan.path) ? 'regular' : 'missing',
    }))),
    writeScaffoldFileAtomic: vi.fn(writePlan),
    writeConfigMarkerLast: vi.fn(writePlan),
    upsertManagedGitignoreBlock: vi.fn((path: string) => {
      fs.writeFileSync(path, '# agent-qa init:start\n# agent-qa init:end\n')
      return { path, outcome: 'created' as const }
    }),
    verifyEffectiveGitignore: vi.fn(() => ({ checked: true })),
  }
})

vi.mock('../commands/install-browsers.js', () => ({
  formatInstallBrowsersRetryCommand: vi.fn(() => 'agent-qa install-browsers --chromium'),
  runBrowserInstall: vi.fn(() => ({ ok: true, status: 0, stage: 'installer' })),
}))

vi.mock('@vostride/agent-qa-core', () => ({
  writeAuth: vi.fn(() => Promise.resolve()),
  resolveAppiumExecutable: vi.fn(() => ({ command: 'appium', source: 'path' })),
  formatAppiumInstallGuidance: vi.fn(() => 'Install Appium locally.'),
  DEFAULT_AGENT_QA_AUTH_STATES_DIR: '.agent-qa/auth-states',
  DEFAULT_AGENT_QA_CACHE_DIR: '.agent-qa/cache',
  DEFAULT_AGENT_QA_RUNTIME_DIR: '.agent-qa',
  getAgentQaVersion: vi.fn(() => '0.1.1'),
  getAuthPath: vi.fn(() => '/tmp/test-home/.agent-qa/auth.json'),
  listSavedCredentials: vi.fn(async () => []),
}))

import { createInitCommand } from '../commands/init.js'
import { writeScaffoldFileAtomic } from '../commands/init-filesystem.js'
import { buildScaffoldFileSet } from '../commands/scaffold-content.js'
import { writeFileSync, existsSync, readFileSync } from 'node:fs'
import { clearProviderRegistry } from '@vostride/agent-qa-model'
import { isCanonicalHookId, isCanonicalSuiteId, isCanonicalTestId } from '@vostride/agent-qa-ids'
import { SecretStore, parseEnvFile } from '@vostride/agent-qa-runner'
import { hermeticEnv } from './conformance/spawned-chat.js'
import { defaultProjectIo } from '../commands/project-host.js'
import { fakeRunner, runningAgentQa } from './project-fixtures.js'

const realFs = await vi.importActual<typeof import('node:fs')>('node:fs')
const realChildProcess = await vi.importActual<typeof import('node:child_process')>(
  'node:child_process',
)
const tempRoots: string[] = []

const mockWriteFileSync = vi.mocked(writeFileSync)
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')

const DIR = '/tmp/examples'
const CHECKOUT = 'tests/examples/komazon-checkout.yaml'
const CART_TOTAL = 'tests/examples/komazon-cart-total.yaml'
const CART_TOTAL_BUG = 'tests/examples/komazon-cart-total-bug.yaml'
const SEARCH = 'tests/examples/komazon-search.yaml'
const BAG = 'tests/examples/komazon-bag.yaml'
const SUITE = 'suites/examples.suite.yaml'
const HOOK_TEST = 'tests/examples/komazon-shipping-hook.yaml'
const HOOK_SCRIPT = 'scripts/examples/make-shipping-address.mjs'
const HOOK_ENV_FILE = '/tmp/agent-qa.env'
const SECRETS_PATH = `${DIR}/.env.secrets.local`
const CONFIG_PATH = `${DIR}/agent-qa.config.yaml`
const EXAMPLE_SECRET = 'KOMAZON_PASSWORD=komazon123'
const EXAMPLE_PREFIXES = ['tests/examples/', 'scripts/examples/']
const BUG_URL = 'https://playground.vostride.dev/shop/?bug=cart-total'
const RESET = /\breset\b/i
const STARTER_STEPS = [
  'Add Everyday Ceramic Mug to the bag, open the bag and increase its quantity to two.',
  'Verify the order total is $53.00.',
]
const KOMAZON_TARGETS = {
  komazon: { platform: 'web', url: 'https://playground.vostride.dev/shop/' },
  'komazon-cart-total-bug': { platform: 'web', url: BUG_URL },
}
type Write = { path: string; content: string }

// No test starts a package manager or writes coding-agent files: init runs no install and
// chooses no coding agent.
function withoutInstall(args: readonly string[]): string[] {
  if (args.includes('--capabilities')) return [...args]
  const pm = args.includes('--pm') ? [] : ['--pm', 'none']
  const agents = args.includes('--agents') ? [] : ['--agents', 'none']
  return [...args, ...pm, ...agents]
}

async function runInit(args: string[]): Promise<void> {
  const parent = new Command()
  const init = createInitCommand({
    cwd: DIR,
    host: { env: {}, run: fakeRunner(), ...runningAgentQa(defaultProjectIo) },
  })
  parent.exitOverride()
  init.exitOverride()
  parent.addCommand(init)
  await parent.parseAsync(['node', 'test', 'init', ...withoutInstall(args)])
}

async function initWrites(platform = 'web'): Promise<Write[]> {
  mockWriteFileSync.mockClear()
  vi.mocked(process.stderr.write).mockClear()
  await runInit(['--platform', platform])
  return mockWriteFileSync.mock.calls.map(call => ({
    path: String(call[0]).slice(DIR.length + 1),
    content: String(call[1]),
  }))
}

function writtenText(writes: Write[], path: string): string {
  const write = writes.find(entry => entry.path === path)
  expect(write, `init wrote ${path}`).toBeDefined()
  return write!.content
}

function written(writes: Write[], path: string): { raw: string; doc: any } {
  const raw = writtenText(writes, path)
  return { raw, doc: parseYaml(raw) }
}

// init draws its human output on stderr.
function consoleOutput(): string {
  return stripVTControlCharacters(
    vi.mocked(process.stderr.write).mock.calls.map((call) => String(call[0])).join(''),
  )
}

async function loadCoreYamlValidators() {
  const moduleUrl = (path: string) => pathToFileURL(resolve(repoRoot, path)).href
  const [yamlParser, suiteSchema, hooksSchema] = await Promise.all([
    import(/* @vite-ignore */ moduleUrl('packages/core/src/parser/yaml-parser.ts')),
    import(/* @vite-ignore */ moduleUrl('packages/core/src/schema/suite-schema.ts')),
    import(/* @vite-ignore */ moduleUrl('packages/core/src/hooks/schema.ts')),
  ])
  return {
    parseTestFile: yamlParser.parseTestFile as (
      content: string,
      filePath: string,
    ) => { tests: any[]; errors: any[] },
    SuiteDefinitionSchema: suiteSchema.SuiteDefinitionSchema,
    HooksFileSchema: hooksSchema.HooksFileSchema,
  }
}

afterAll(() => {
  for (const root of tempRoots.splice(0)) realFs.rmSync(root, { recursive: true, force: true })
})

function setUpInitMocks(): void {
  clearProviderRegistry()
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  vi.clearAllMocks()
  vi.mocked(existsSync).mockReturnValue(false)
  vi.mocked(readFileSync).mockImplementation(path =>
    String(path).endsWith('package.json') ? '{"version":"0.1.1"}' : '',
  )
}

function tearDownInitMocks(): void {
  clearProviderRegistry()
  vi.restoreAllMocks()
}

describe('the init examples', () => {
  beforeEach(setUpInitMocks)
  afterEach(tearDownInitMocks)

  it('init writes the examples in their own folder and the suite holds the journey, search and bag tests, with no starter and no hook test', async () => {
    const writes = await initWrites()
    const suite = written(writes, SUITE).doc
    const idOf = (path: string) => written(writes, path).doc['test-id']

    expect(suite.target).toBe('komazon')
    expect(suite.tests).toEqual([
      { test: CHECKOUT, id: idOf(CHECKOUT) },
      { test: SEARCH, id: idOf(SEARCH) },
      { test: BAG, id: idOf(BAG) },
    ])
    const members = suite.tests as { test: string; id: string }[]
    for (const path of [CART_TOTAL, CART_TOTAL_BUG, HOOK_TEST]) {
      expect(members.map(member => member.test), `${path} is a member`).not.toContain(path)
      expect(members.map(member => member.id), `${path}'s id is a member`).not.toContain(idOf(path))
    }

    const samplePaths = writes
      .map(write => write.path)
      .filter(path => /^(tests|suites|scripts)\//.test(path))
    expect(samplePaths.length).toBeGreaterThanOrEqual(3)
    for (const path of samplePaths) {
      const inExamples = path === SUITE || EXAMPLE_PREFIXES.some(prefix => path.startsWith(prefix))
      expect(inExamples, `${path} is outside the examples paths`).toBe(true)
    }
  })

  it('the passing journey signs in with the declared secret, checks the order in View orders and has no reset step', async () => {
    const { raw, doc } = written(await initWrites(), CHECKOUT)
    const steps = doc.steps as string[]

    expect(doc.target).toBe('komazon')
    for (const step of steps) {
      expect(step, 'the journey asks for a reset').not.toMatch(RESET)
    }
    const signIn = steps.find(step => step.includes('alex@example.com'))
    expect(signIn, 'a step signs in with the printed email').toBeDefined()
    expect(signIn).toContain('{{secret:KOMAZON_PASSWORD}}')
    expect(steps.some(step => /add everyday ceramic mug/i.test(step))).toBe(true)
    expect(steps.some(step => step.includes('Place order'))).toBe(true)
    expect(steps.at(-1)).toContain('View orders')
    expect(steps.at(-1)).toContain('Everyday Ceramic Mug')
    expect(raw).not.toContain('headless')
  })

  // Every run opens a fresh session, so a reset has no visible effect to verify.
  it('no example test has a reset step, whose effect a fresh session would hide', async () => {
    const writes = await initWrites()
    const examples = writes.filter(
      write => write.path.startsWith('tests/examples/') && write.path.endsWith('.yaml'),
    )

    expect(examples.length, 'init writes the example tests').toBeGreaterThanOrEqual(3)
    expect(examples.map(write => write.path)).toEqual(expect.arrayContaining([CHECKOUT, HOOK_TEST]))
    for (const { path, content } of examples) {
      const steps = parseYaml(content).steps as string[]
      for (const [index, step] of steps.entries()) {
        expect(step, `${path} step ${index} asks for a reset`).not.toMatch(RESET)
      }
    }
  })

  it('the failing starter is named [Bug], runs the starter steps on its own target with no navigation and is in no suite', async () => {
    const writes = await initWrites()
    const { doc } = written(writes, CART_TOTAL_BUG)
    const steps = doc.steps as string[]

    expect(doc.name).toBe('[Bug] Komazon cart total is wrong for two mugs')
    expect(doc.target).toBe('komazon-cart-total-bug')
    expect(steps).toEqual(STARTER_STEPS)
    for (const [index, step] of steps.entries()) {
      expect(step, `step ${index} navigates`).not.toMatch(/^Navigate to /)
      expect(step, `step ${index} holds a URL`).not.toMatch(/https?:\/\//)
    }

    const suite = written(writes, SUITE).doc
    expect(suite.tests.map((member: { test: string }) => member.test)).not.toContain(CART_TOTAL_BUG)
    expect(suite.tests.map((member: { id: string }) => member.id)).not.toContain(doc['test-id'])
  })

  it('the passing starter runs the starter steps on komazon and differs from the [Bug] starter only in id, name and target', async () => {
    const writes = await initWrites()
    const passing = written(writes, CART_TOTAL).doc
    const failing = written(writes, CART_TOTAL_BUG).doc

    expect(passing.name).toBe('Komazon cart total')
    expect(passing.target).toBe('komazon')
    expect(passing.steps).toEqual(STARTER_STEPS)
    expect(failing.steps).toEqual(STARTER_STEPS)
    expect(Object.keys(passing)).toEqual(Object.keys(failing))
    for (const key of Object.keys(passing)) {
      if (['test-id', 'name', 'target'].includes(key)) {
        expect(passing[key], `the starters share their ${key}`).not.toEqual(failing[key])
      } else {
        expect(passing[key], `the starters differ in ${key}`).toEqual(failing[key])
      }
    }
  })

  it('every suite member runs on the suite target, has no setup hook and repeats no starter step', async () => {
    const writes = await initWrites()
    const suite = written(writes, SUITE).doc

    for (const member of suite.tests as { test: string }[]) {
      const doc = written(writes, member.test).doc
      const repeated = (doc.steps as string[]).filter(step => STARTER_STEPS.includes(step))
      expect(doc.target, member.test).toBe(suite.target)
      expect(doc, `${member.test} has a setup hook`).not.toHaveProperty('setup')
      expect(repeated, `${member.test} repeats a starter step`).toEqual([])
    }
  })

  it('every example test has a canonical id that no other example test shares', async () => {
    const examples = (await initWrites())
      .filter(write => write.path.startsWith('tests/examples/') && write.path.endsWith('.yaml'))
      .map(write => ({ path: write.path, id: parseYaml(write.content)['test-id'] }))

    expect(examples.length, 'init writes the example tests').toBeGreaterThan(1)
    for (const [index, { path, id }] of examples.entries()) {
      expect(isCanonicalTestId(id), path).toBe(true)
      expect(examples.findIndex(other => other.id === id), `${path} shares its id`).toBe(index)
    }
  })

  it('the targets are komazon and komazon-cart-total-bug with no product field', async () => {
    const expected: Record<string, Record<string, unknown>> = {
      web: KOMAZON_TARGETS,
      android: { 'example-android': { platform: 'android' } },
      ios: { 'example-ios': { platform: 'ios' } },
      'web,android': { ...KOMAZON_TARGETS, 'example-android': { platform: 'android' } },
      'web,ios': { ...KOMAZON_TARGETS, 'example-ios': { platform: 'ios' } },
    }
    for (const [platform, targets] of Object.entries(expected)) {
      const config = written(await initWrites(platform), 'agent-qa.config.yaml').doc
      expect(config.registry.targets, platform).toEqual(targets)
    }
  })

  it('the next steps name only example files init writes', async () => {
    const writes = await initWrites()
    const paths = writes.map(write => write.path)
    const output = consoleOutput()
    const nextSteps = output.slice(output.indexOf('Next steps\n'))
    expect(output).toContain('Next steps\n')
    const named = nextSteps.match(/\b(?:tests|suites|scripts)\/[\w./-]+/g) ?? []
    expect(named.length, 'the next steps name no example file').toBeGreaterThan(0)
    for (const path of named) {
      expect(paths, `the next steps name ${path}, which init does not write`).toContain(path)
    }
  })

  it('every generated test and suite parses with the shipped schemas', async () => {
    const writes = await initWrites()
    const { parseTestFile, SuiteDefinitionSchema } = await loadCoreYamlValidators()
    const examples = writes.filter(
      write => write.path.startsWith('tests/examples/') && write.path.endsWith('.yaml'),
    )

    expect(examples.map(write => write.path)).toEqual(
      expect.arrayContaining([CHECKOUT, CART_TOTAL_BUG]),
    )
    for (const { path, content } of examples) {
      const parsed = parseTestFile(content, path)
      expect(parsed.errors, path).toEqual([])
      expect(parsed.tests, path).toHaveLength(1)
      expect(isCanonicalTestId(parsed.tests[0]['test-id']), path).toBe(true)
    }

    const suite = SuiteDefinitionSchema.safeParse(written(writes, SUITE).doc)
    if (!suite.success) throw new Error(JSON.stringify(suite.error.issues, null, 2))
    expect(isCanonicalSuiteId(suite.data['suite-id'])).toBe(true)
    for (const member of suite.data.tests) {
      expect(isCanonicalTestId(member.id), member.test).toBe(true)
    }
  })

  it('the example files are written before the config, which is written last', async () => {
    const paths = (await initWrites()).map(write => write.path)
    const configIndex = paths.indexOf('agent-qa.config.yaml')
    const examples = paths.filter(path =>
      ['tests/examples/', 'suites/', 'scripts/examples/'].some(prefix => path.startsWith(prefix)),
    )

    expect(configIndex).toBe(paths.length - 1)
    expect(examples.length, 'init writes the examples').toBeGreaterThan(0)
    for (const path of examples) {
      expect(paths.indexOf(path), `${path} is written after the config`).toBeLessThan(configIndex)
    }
  })

  it('accessibility runs at test end, never fails the run, and its comment sits on the accessibility block', async () => {
    const writes = await initWrites()
    const { raw, doc } = written(writes, 'agent-qa.config.yaml')

    expect(doc.services.accessibility).toEqual({
      enabled: true,
      standard: 'wcag2aa',
      runAfter: 'test-end',
      failOnViolation: false,
    })
    const lines = raw.split('\n')
    const block = lines.indexOf('  accessibility:')
    expect(block, 'the config has an accessibility block').toBeGreaterThan(0)
    expect(lines[block - 1], 'the line above the accessibility block').toMatch(/^ {2}# \S/)
    for (const write of writes) {
      expect(write.content, write.path).not.toContain('W3C')
      expect(write.content, write.path).not.toContain('BAD demo')
    }
  })

  it('the config scaffold proposal writes an empty hooks list and names no script', () => {
    const input = {
      cacheDir: '.agent-qa/cache',
      authStatesDir: '.agent-qa/auth-states',
      targetName: 'booking-com',
      baseUrl: 'https://booking.com',
      gitignoreEntries: ['.env'],
    }
    const fresh = buildScaffoldFileSet(input)
    const merged = buildScaffoldFileSet({
      ...input,
      existingConfig: {
        path: 'agent-qa.config.yaml',
        text: 'registry:\n  llms: []\n',
        hooksPath: 'hooks.yaml',
        hooksPresent: false,
      },
    })

    for (const [mode, files] of [['fresh', fresh], ['merge', merged]] as const) {
      const hooks = files.find(file => file.path === 'hooks.yaml')
      expect(hooks, `${mode}: the proposal has a hooks member`).toBeDefined()
      expect(hooks!.text, mode).toBe('hooks: []\n')
      expect(hooks!.text, mode).not.toContain('file:')
    }
  })

  it('the hook sample makes its value locally with no network and is not in the suite', async () => {
    const writes = await initWrites()
    const { parseTestFile, HooksFileSchema } = await loadCoreYamlValidators()

    const hooksDoc = written(writes, 'hooks.yaml').doc
    const hooksFile = HooksFileSchema.safeParse(hooksDoc)
    if (!hooksFile.success) throw new Error(JSON.stringify(hooksFile.error.issues, null, 2))
    expect(hooksFile.data.hooks).toHaveLength(1)
    const [hook] = hooksFile.data.hooks
    expect(isCanonicalHookId(hook.id)).toBe(true)
    expect(hook).toMatchObject({ runtime: 'node', file: HOOK_SCRIPT, timeout: 30_000 })
    expect(hooksDoc.hooks[0].network, 'the hook declares network: false').toBe(false)

    const script = writtenText(writes, HOOK_SCRIPT)
    for (const banned of ['fetch(', 'http:', 'https:', 'node:http', 'node:https', 'node:net']) {
      expect(script, `the hook script names ${banned}`).not.toContain(banned)
    }
    const imports = [...script.matchAll(/from '([^']+)'/g)].map(match => match[1]).sort()
    expect(imports).toEqual(['node:crypto', 'node:fs/promises'])

    const { raw, doc } = written(writes, HOOK_TEST)
    const parsed = parseTestFile(raw, HOOK_TEST)
    expect(parsed.errors).toEqual([])
    expect(parsed.tests).toHaveLength(1)
    expect(isCanonicalTestId(doc['test-id'])).toBe(true)
    expect(doc.name).toMatch(/^\[Hook\] /)
    expect(doc.target).toBe('komazon')
    expect(doc.setup).toEqual([hook.id])
    expect(doc.use).toEqual({ cache: false })
    const steps = doc.steps as string[]
    const typed = steps.find(step => step.includes('Street address'))
    expect(typed, 'a step types into the Street address field').toBeDefined()
    expect(typed).toContain('{{env:SHIPPING_ADDRESS}}')
    const review = steps.find(step => /review shows/i.test(step))
    expect(review, 'a step verifies the review').toBeDefined()
    expect(review).toContain('{{env:SHIPPING_ADDRESS}}')

    const suite = written(writes, SUITE).doc
    expect(suite.tests.map((member: { test: string }) => member.test)).not.toContain(HOOK_TEST)
    expect(suite.tests.map((member: { id: string }) => member.id)).not.toContain(doc['test-id'])
  })

  it('the hook script writes a shipping address numbered 100 to 999 that the runtime env decoder reads', async () => {
    if (process.platform === 'win32') throw new Error('POSIX run lifecycle required; never skip')
    const script = writtenText(await initWrites(), HOOK_SCRIPT)
    expect(script).toContain(HOOK_ENV_FILE)
    expect(script).toContain("import { randomInt } from 'node:crypto'")
    expect(script).toContain('randomInt(100, 1000)')

    const root = realFs.mkdtempSync(join(tmpdir(), 'hook-'))
    tempRoots.push(root)
    const output = join(root, 'agent-qa.env')
    const scriptPath = join(root, 'make-shipping-address.mjs')
    realFs.writeFileSync(scriptPath, script.replaceAll(HOOK_ENV_FILE, output))
    for (let attempt = 0; attempt < 5; attempt++) {
      const run = realChildProcess.spawnSync(process.execPath, [scriptPath], {
        cwd: root,
        env: hermeticEnv(root),
        encoding: 'utf8',
      })

      expect(run.status, run.stderr).toBe(0)
      const vars = parseEnvFile(realFs.readFileSync(output, 'utf8'))
      const match = /^(\d+) Cedar Lane$/.exec(vars.SHIPPING_ADDRESS ?? '')
      expect(match, vars.SHIPPING_ADDRESS).not.toBeNull()
      const number = Number(match![1])
      expect(number).toBeGreaterThanOrEqual(100)
      expect(number).toBeLessThanOrEqual(999)
    }
  })
})

describe('the example secrets line', () => {
  beforeEach(setUpInitMocks)
  afterEach(tearDownInitMocks)

  function outputLines(): string[] {
    return consoleOutput().split('\n')
  }

  async function initOverExistingSecrets(args: string[]): Promise<Write[]> {
    const existing = new Set([SECRETS_PATH, ...(args.includes('--force') ? [CONFIG_PATH] : [])])
    vi.mocked(existsSync).mockImplementation(path => existing.has(String(path)))
    vi.mocked(readFileSync).mockImplementation(path => {
      if (String(path).endsWith('package.json')) return '{"version":"0.1.1"}'
      return String(path) === SECRETS_PATH ? 'OWN_SECRET=owner-value-zz\n' : ''
    })
    mockWriteFileSync.mockClear()
    await runInit(['--platform', 'web', ...args])
    return mockWriteFileSync.mock.calls.map(call => ({
      path: String(call[0]),
      content: String(call[1]),
    }))
  }

  function expectPrintedLineAndUntouchedFile(writes: Write[]): void {
    expect(writes.length, 'init wrote its scaffold').toBeGreaterThan(0)
    expect(writes.map(write => write.path)).not.toContain(SECRETS_PATH)
    const plan = vi.mocked(writeScaffoldFileAtomic).mock.calls
      .map(([candidate]) => candidate)
      .find(candidate => candidate.path === SECRETS_PATH)
    expect(plan?.preserveOnForce, 'the secrets plan is preserved on --force').toBe(true)

    const lines = outputLines()
    const index = lines.indexOf(EXAMPLE_SECRET)
    expect(index, 'init prints the example line on its own line').toBeGreaterThan(0)
    const sentence = lines.slice(0, index).reverse().find(line => line.trim().length > 0)
    expect(sentence).toContain('.env.secrets.local')
    expect(sentence).toMatch(/sign in/)
    expect(consoleOutput()).not.toContain('owner-value-zz')
  }

  it('a created secrets file holds the example line at mode 0600', async () => {
    const writes = await initWrites()
    const plan = vi.mocked(writeScaffoldFileAtomic).mock.calls
      .map(([candidate]) => candidate)
      .find(candidate => candidate.path === SECRETS_PATH)

    expect(plan, 'init plans the secrets file').toBeDefined()
    expect(plan!.mode).toBe(0o600)
    expect(plan!.preserveOnForce).toBe(true)
    const content = writtenText(writes, '.env.secrets.local')
    expect(content).toBe(plan!.content)
    expect(SecretStore.fromEnvContent(content).get('KOMAZON_PASSWORD')).toBe('komazon123')
    expect(content.split('\n')).toContain(EXAMPLE_SECRET)
    expect(outputLines(), 'a created file needs no printed line').not.toContain(EXAMPLE_SECRET)
  })

  it('an existing secrets file is never written and init prints the exact line', async () => {
    expectPrintedLineAndUntouchedFile(await initOverExistingSecrets([]))
  })

  it('the same holds under --force', async () => {
    expectPrintedLineAndUntouchedFile(await initOverExistingSecrets(['--force']))
  })
})
