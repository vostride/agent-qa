// C445-EXAMPLES (445-02, 445-03, D-06, D-26, D-32, D-40): init writes the Komazon examples
// C445-SECRETS-LINE (445-03, D-09, D-27): the example secret goes only into a created secrets file
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

vi.mock('@inquirer/select', () => ({ default: vi.fn() }))
vi.mock('@inquirer/input', () => ({ default: vi.fn() }))
vi.mock('@inquirer/checkbox', () => ({ default: vi.fn() }))
vi.mock('@inquirer/confirm', () => ({ default: vi.fn() }))
vi.mock('@inquirer/password', () => ({ default: vi.fn() }))

vi.mock('@vostride/agent-qa-core', () => ({
  writeAuth: vi.fn(() => Promise.resolve()),
  resolveAppiumExecutable: vi.fn(() => ({ command: 'appium', source: 'path' })),
  formatAppiumInstallGuidance: vi.fn(() => 'Install Appium locally.'),
  DEFAULT_AGENT_QA_AUTH_STATES_DIR: '.agent-qa/auth-states',
  DEFAULT_AGENT_QA_CACHE_DIR: '.agent-qa/cache',
  DEFAULT_AGENT_QA_RUNTIME_DIR: '.agent-qa',
  getAgentQaVersion: vi.fn(() => '0.1.1'),
}))

import { createInitCommand } from '../commands/init.js'
import { writeScaffoldFileAtomic } from '../commands/init-filesystem.js'
import { buildScaffoldFileSet } from '../commands/scaffold-content.js'
import { writeFileSync, existsSync, readFileSync } from 'node:fs'
import { clearProviderRegistry } from '@vostride/agent-qa-model'
import { isCanonicalHookId, isCanonicalSuiteId, isCanonicalTestId } from '@vostride/agent-qa-ids'
import { SecretStore, parseEnvFile } from '@vostride/agent-qa-runner'
import { hermeticEnv } from './conformance/spawned-chat.js'

const realFs = await vi.importActual<typeof import('node:fs')>('node:fs')
const realChildProcess = await vi.importActual<typeof import('node:child_process')>(
  'node:child_process',
)
const tempRoots: string[] = []

const mockWriteFileSync = vi.mocked(writeFileSync)
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')

const DIR = '/tmp/c445-examples'
const CHECKOUT = 'tests/examples/komazon-checkout.yaml'
const CART_TOTAL_BUG = 'tests/examples/komazon-cart-total-bug.yaml'
const SUITE = 'suites/examples.suite.yaml'
const HOOK_TEST = 'tests/examples/komazon-shipping-hook.yaml'
const HOOK_SCRIPT = 'scripts/examples/make-shipping-address.mjs'
const HOOK_ENV_FILE = '/tmp/agent-qa.env'
const SECRETS_PATH = `${DIR}/.env.secrets.local`
const CONFIG_PATH = `${DIR}/agent-qa.config.yaml`
const EXAMPLE_SECRET = 'KOMAZON_PASSWORD=komazon123'
const EXAMPLE_PREFIXES = ['tests/examples/', 'scripts/examples/']
const BUG_URL = 'https://playground.vostride.dev/shop/?bug=cart-total'
const RESET_OR_CLEAR = /\b(reset|clear)\b/i
const KOMAZON_TARGETS = {
  komazon: { platform: 'web', url: 'https://playground.vostride.dev/shop/' },
  'komazon-cart-total-bug': { platform: 'web', url: BUG_URL },
}
const RETIRED_PATHS = [
  'tests/example-pass.yaml',
  'tests/example-fail.yaml',
  'tests/automation-exercise/home-smoke.yaml',
  'tests/automation-exercise/products-smoke.yaml',
  'tests/automation-exercise/cart-smoke.yaml',
  'suites/automation-exercise.suite.yaml',
  'tests/hacker-news-top-story.yaml',
  'scripts/fetch-hn-top-story.mjs',
  'tests/bad-a11y.yaml',
]
const RETIRED_TARGETS = ['example-web', 'automation-exercise', 'wai-bad']
const RETIRED_IDS = [
  't_amber-birch-coral-delta-ember-falcon-garden-harbor-island-jungle',
  't_bronze-cedar-dune-ember-fjord-glade-harbor-ivory-jade-kelp',
  't_class-volume-nth-intent-break-gun-gone-ging-twig-vert',
  't_umble-ruby-direct-notify-rama-phony-dust-owl-lop-etch',
  't_kend-lack-infect-nou-bah-kil-point-reak-ura-loo',
  's_hill-gant-verb-nast-hunter-rita-home-store-amy-crest',
  't_quad-adar-micro-magic-cross-cue-open-agog-rang-cours',
  't_ponent-toa-base-fred-click-sigma-lad-agen-report-sticky',
  'h_aster-bloom-cloud-drift-ember-field-glade-hollow-ivory-jasper',
]
const RETIRED_NAMES = [
  'example-pass',
  'example-fail',
  'automation-exercise',
  'hacker-news-top-story',
  'fetch-hn-top-story',
  'bad-a11y',
]

type Write = { path: string; content: string }

async function runInit(args: string[]): Promise<void> {
  const parent = new Command()
  const init = createInitCommand({})
  parent.exitOverride()
  init.exitOverride()
  parent.addCommand(init)
  await parent.parseAsync(['node', 'test', 'init', ...args])
}

async function initWrites(platform = 'web'): Promise<Write[]> {
  mockWriteFileSync.mockClear()
  vi.mocked(console.log).mockClear()
  await runInit(['--dir', DIR, '--platform', platform])
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

function consoleOutput(): string {
  return stripVTControlCharacters(vi.mocked(console.log).mock.calls.flat().map(String).join('\n'))
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

describe('C445-EXAMPLES', () => {
  beforeEach(setUpInitMocks)
  afterEach(tearDownInitMocks)

  it('init writes the examples in their own folder and the suite selects the journey then the failing test', async () => {
    const writes = await initWrites()
    const checkout = written(writes, CHECKOUT).doc
    const bug = written(writes, CART_TOTAL_BUG).doc
    const suite = written(writes, SUITE).doc

    expect(suite.target).toBe('komazon')
    expect(suite.tests).toEqual([
      { test: CHECKOUT, id: checkout['test-id'] },
      { test: CART_TOTAL_BUG, id: bug['test-id'] },
    ])

    const samplePaths = writes
      .map(write => write.path)
      .filter(path => /^(tests|suites|scripts)\//.test(path))
    expect(samplePaths.length).toBeGreaterThanOrEqual(3)
    for (const path of samplePaths) {
      const inExamples = path === SUITE || EXAMPLE_PREFIXES.some(prefix => path.startsWith(prefix))
      expect(inExamples, `${path} is outside the examples paths`).toBe(true)
    }
  })

  it('the passing journey signs in with the declared secret, checks the order in View orders and has no reset or clear step', async () => {
    const { raw, doc } = written(await initWrites(), CHECKOUT)
    const steps = doc.steps as string[]

    expect(doc.target).toBe('komazon')
    for (const step of steps) {
      expect(step, 'the journey asks for a reset or clear').not.toMatch(RESET_OR_CLEAR)
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

  // Every run opens a fresh session, so a reset or clear has no visible effect to verify.
  it('no example test has a reset or clear step, whose effect a fresh session would hide', async () => {
    const writes = await initWrites()
    const examples = writes.filter(
      write => write.path.startsWith('tests/examples/') && write.path.endsWith('.yaml'),
    )

    expect(examples.length, 'init writes the example tests').toBeGreaterThanOrEqual(3)
    expect(examples.map(write => write.path)).toEqual(expect.arrayContaining([CHECKOUT, HOOK_TEST]))
    for (const { path, content } of examples) {
      const steps = parseYaml(content).steps as string[]
      expect(steps.length, path).toBeGreaterThanOrEqual(3)
      for (const [index, step] of steps.entries()) {
        expect(step, `${path} step ${index} asks for a reset or clear`).not.toMatch(RESET_OR_CLEAR)
      }
    }
  })

  it('the failing test reaches the bug through its first step and never resets', async () => {
    const { raw, doc } = written(await initWrites(), CART_TOTAL_BUG)
    const steps = doc.steps as string[]

    expect(doc.target).toBe('komazon-cart-total-bug')
    expect(steps[0]).toMatch(/^Navigate to /)
    expect(steps[0]).toContain(BUG_URL)
    expect(steps.some(step => /two Everyday Ceramic Mugs/.test(step))).toBe(true)
    expect(steps.some(step => step.includes('$53.00'))).toBe(true)
    for (const step of steps) {
      expect(step, 'the failing test resets or disables the bug').not.toMatch(/reset|disable/i)
    }
    expect(raw).not.toContain('headless')
  })

  it('the targets are komazon and komazon-cart-total-bug with no product field', async () => {
    const expected: Record<string, Record<string, unknown>> = {
      web: KOMAZON_TARGETS,
      android: { 'example-android': { platform: 'android' } },
      ios: { 'example-ios': { platform: 'ios' } },
      'web+android': { ...KOMAZON_TARGETS, 'example-android': { platform: 'android' } },
      'web+ios': { ...KOMAZON_TARGETS, 'example-ios': { platform: 'ios' } },
    }
    for (const [platform, targets] of Object.entries(expected)) {
      const config = written(await initWrites(platform), 'agent-qa.config.yaml').doc
      expect(config.registry.targets, platform).toEqual(targets)
    }
  })

  it('init writes none of the retired samples', async () => {
    const writes = await initWrites()
    const paths = writes.map(write => write.path)
    for (const path of RETIRED_PATHS) {
      expect(paths, `init still writes ${path}`).not.toContain(path)
    }

    const config = written(writes, 'agent-qa.config.yaml').doc
    for (const target of RETIRED_TARGETS) {
      expect(Object.keys(config.registry.targets), `target ${target}`).not.toContain(target)
    }
    for (const write of writes) {
      for (const id of RETIRED_IDS) {
        expect(write.content, `${write.path} carries ${id}`).not.toContain(id)
      }
    }

    const output = consoleOutput()
    const nextSteps = output.slice(output.indexOf('Next steps:'))
    expect(output).toContain('Next steps:')
    for (const name of RETIRED_NAMES) {
      expect(nextSteps, `the next steps name ${name}`).not.toContain(name)
    }
    const named = nextSteps.match(/\b(?:tests|suites|scripts)\/[\w./-]+/g) ?? []
    expect(named.length, 'the next steps name no example file').toBeGreaterThan(0)
    for (const path of named) {
      expect(paths, `the next steps name ${path}, which init does not write`).toContain(path)
    }
  })

  it('every generated test and suite parses with the shipped schemas', async () => {
    const writes = await initWrites()
    const { parseTestFile, SuiteDefinitionSchema } = await loadCoreYamlValidators()

    for (const path of [CHECKOUT, CART_TOTAL_BUG]) {
      const { raw } = written(writes, path)
      const parsed = parseTestFile(raw, path)
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

    expect(configIndex).toBe(paths.length - 1)
    for (const path of [CHECKOUT, CART_TOTAL_BUG, SUITE]) {
      const index = paths.indexOf(path)
      expect(index, `init wrote ${path}`).toBeGreaterThanOrEqual(0)
      expect(index, `${path} is written after the config`).toBeLessThan(configIndex)
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

  it('the hook script writes a shipping address the runtime env decoder reads', async () => {
    if (process.platform === 'win32') throw new Error('POSIX run lifecycle required; never skip')
    const script = writtenText(await initWrites(), HOOK_SCRIPT)
    expect(script).toContain(HOOK_ENV_FILE)

    const root = realFs.mkdtempSync(join(tmpdir(), 'c445-hook-'))
    tempRoots.push(root)
    const output = join(root, 'agent-qa.env')
    const scriptPath = join(root, 'make-shipping-address.mjs')
    realFs.writeFileSync(scriptPath, script.replaceAll(HOOK_ENV_FILE, output))
    const run = realChildProcess.spawnSync(process.execPath, [scriptPath], {
      cwd: root,
      env: hermeticEnv(root),
      encoding: 'utf8',
    })

    expect(run.status, run.stderr).toBe(0)
    const vars = parseEnvFile(realFs.readFileSync(output, 'utf8'))
    expect(vars.SHIPPING_ADDRESS).toMatch(/^\d{3} Cedar Lane$/)
  })
})

describe('C445-SECRETS-LINE', () => {
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
      return String(path) === SECRETS_PATH ? 'C445_OWN_SECRET=owner-value-zz\n' : ''
    })
    mockWriteFileSync.mockClear()
    await runInit(['--dir', DIR, '--platform', 'web', ...args])
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
