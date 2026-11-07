// plugins add: declare, install and enable, on temporary projects with a fake runner.
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { stripVTControlCharacters } from 'node:util'

import { getAgentQaVersion, PluginEntrySchema } from '@vostride/agent-qa-core'
import { Command } from 'commander'
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { parse } from 'yaml'

import { parsePackageView } from '../commands/package-manager.js'
import { pluginEntryName } from '../commands/plugins-add.js'
import { createPluginsCommand } from '../commands/plugins.js'
import type { ProjectHost, RunOptions, RunResult } from '../commands/project-host.js'
import { CliRefusal } from '../composition/cli-refusal.js'
import { resolveConfig } from '../config.js'
import {
  cleanupTempProjects,
  fakeRunner,
  tempProject,
  writeInstalledPackage,
  type FakeRunner,
  type RunnerCall,
} from './project-fixtures.js'

const VERSION = getAgentQaVersion().trim()
const KERNEL = '@vostride/agent-qa-plugin-kernel'
const SUBSCRIPTION = '@vostride/agent-qa-subscription-auth'

const WORKSPACE = [
  'workspace:',
  '  testMatch:',
  '    - tests/**/*.yaml',
  '  suiteMatch:',
  '    - suites/**/*.suite.yaml',
  '  hooksFile: hooks.yaml',
  '  envFile: .env',
  '  secretsFile: .env.secrets.local',
]

let log: MockInstance<typeof console.log>

beforeEach(() => {
  log = vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
})

afterEach(() => {
  vi.restoreAllMocks()
  cleanupTempProjects()
})

type Call = { command: string; args: readonly string[]; options: RunOptions }

function isProbe(args: readonly string[]): boolean {
  return args.length === 1 && args[0] === '--version'
}

function isLookup(args: readonly string[]): boolean {
  return args.includes('--json')
}

function declaredDependencies(folder: string): Record<string, string> {
  const manifest = JSON.parse(readFileSync(join(folder, 'package.json'), 'utf-8')) as {
    devDependencies?: Record<string, string>
    dependencies?: Record<string, string>
  }
  return { ...manifest.dependencies, ...manifest.devDependencies }
}

function installsDeclared({ options }: Call): RunResult {
  for (const [name, version] of Object.entries(declaredDependencies(options.cwd))) {
    writeInstalledPackage(options.cwd, name, version)
  }
  return { code: 0, signal: null, output: '' }
}

interface Machine {
  versions?: Record<string, string | null>
  install?: (call: Call) => RunResult
  lookup?: (call: Call) => RunResult
}

// A command listed as null is not on PATH; an unlisted one answers --version with no output.
function machine(options: Machine = {}): FakeRunner {
  const install = options.install ?? installsDeclared
  const lookup = options.lookup ?? (() => ({ code: 1, signal: null, output: 'no lookup' }))
  return fakeRunner((call) => {
    if (isProbe(call.args)) {
      const version = options.versions?.[call.command]
      if (version === null) return { code: null, signal: null, output: '', missing: true }
      return { code: 0, signal: null, output: version === undefined ? '' : `${version}\n` }
    }
    if (isLookup(call.args)) return lookup(call)
    return install(call)
  })
}

function registry(answers: Record<string, unknown>): (call: Call) => RunResult {
  return ({ args }) => {
    const spec = args[args.indexOf('--json') - 1]!
    if (!(spec in answers)) return { code: 1, signal: null, output: `npm error 404 ${spec}` }
    const answer = answers[spec]
    return {
      code: 0,
      signal: null,
      output: typeof answer === 'string' ? answer : JSON.stringify(answer),
    }
  }
}

function lookups(run: FakeRunner): string[] {
  return run.calls.filter((call) => isLookup(call.args)).map(argv)
}

function argv(call: RunnerCall): string {
  return [call.command, ...call.args].join(' ')
}

function installs(run: FakeRunner): RunnerCall[] {
  return run.calls.filter((call) => !isProbe(call.args) && !isLookup(call.args))
}

function writeConfig(root: string, lines: readonly string[]): string {
  const text = ['# the project settings agent-qa reads', ...WORKSPACE, ...lines, ''].join('\n')
  writeFileSync(join(root, 'agent-qa.config.yaml'), text)
  return text
}

function project(lines: readonly string[] = ['plugins: []']) {
  const { root, home } = tempProject('plugins-add')
  writeConfig(root, lines)
  return { root, home }
}

async function add(
  folders: { root: string; home: string },
  run: FakeRunner,
  args: readonly string[],
  config = join(folders.root, 'agent-qa.config.yaml'),
  host: Partial<ProjectHost> = {},
): Promise<void> {
  const argv = ['--config', config, 'plugins', 'add', ...args]
  const program = new Command()
  program.exitOverride()
  program.option('--config <path>', 'config file path', 'agent-qa.config.yaml')
  program.addCommand(
    createPluginsCommand({
      host: { cwd: folders.root, homedir: folders.home, env: {}, run, argv, ...host },
    }),
  )
  await program.parseAsync(['node', 'agent-qa', ...argv])
}

function stdout(): string {
  return stripVTControlCharacters(
    log.mock.calls.map((call) => call.map(String).join(' ')).join('\n'),
  )
}

function snapshot(root: string): Record<string, string> {
  const files: Record<string, string> = {}
  const walk = (folder: string): void => {
    for (const name of readdirSync(folder)) {
      const path = join(folder, name)
      if (statSync(path).isDirectory()) walk(path)
      else files[relative(root, path)] = readFileSync(path, 'utf-8')
    }
  }
  walk(root)
  return files
}

async function refusal(promise: Promise<void>): Promise<CliRefusal> {
  const error = await promise.then(
    () => undefined,
    (thrown: unknown) => thrown,
  )
  expect(error).toBeInstanceOf(CliRefusal)
  return error as CliRefusal
}

function configOf(root: string): string {
  return readFileSync(join(root, 'agent-qa.config.yaml'), 'utf-8')
}

describe('plugins add with a first-party plugin', () => {
  it('declares it at the running version, installs it once and writes the entry under the comment', async () => {
    const folders = project()
    const run = machine()

    await add(folders, run, [KERNEL, '--pm', 'npm'])

    expect(declaredDependencies(folders.root)).toEqual({ [KERNEL]: VERSION })
    expect(installs(run).map((call) => [argv(call), call.cwd])).toEqual([
      ['npm install', realpathSync(folders.root)],
    ])
    const config = configOf(folders.root)
    expect(config).toContain('# the project settings agent-qa reads')
    expect(config).toContain(`  - name: kernel\n    package: "${KERNEL}"\n`)
    expect(stdout()).toContain(`✓ Added the plugins entry kernel for ${KERNEL} ${VERSION}.`)
    expect(stdout()).toContain('Next: npx agent-qa plugins describe kernel')
  })

  it('creates plugins when the config has none, and the result is a valid config', async () => {
    const folders = project([])

    await add(folders, machine(), [KERNEL, '--pm', 'npm'])

    const plugins = (parse(configOf(folders.root)) as { plugins: unknown[] }).plugins
    expect(plugins).toEqual([{ name: 'kernel', package: KERNEL }])
    expect(PluginEntrySchema.safeParse(plugins[0]).success).toBe(true)
    const config = await resolveConfig({
      configPath: join(folders.root, 'agent-qa.config.yaml'),
      loadAuthPlugins: false,
    })
    expect(config.plugins).toEqual([{ name: 'kernel', package: KERNEL }])
  })

  it('names the subscription package subscription', async () => {
    const folders = project()

    await add(folders, machine(), [SUBSCRIPTION, '--pm', 'npm'])

    expect(declaredDependencies(folders.root)).toEqual({ [SUBSCRIPTION]: VERSION })
    expect(configOf(folders.root)).toContain(
      `  - name: subscription\n    package: "${SUBSCRIPTION}"\n`,
    )
    expect(stdout()).toContain('Next: npx agent-qa plugins describe subscription')
  })

  it('keeps an entry that already declares the package, and still pins and installs it', async () => {
    const folders = project([
      'plugins:',
      '  - name: k',
      `    package: "${KERNEL}"`,
      '    options:',
      '      region: eu',
    ])
    const before = configOf(folders.root)
    const run = machine()

    await add(folders, run, [KERNEL, '--pm', 'npm'])

    expect(configOf(folders.root)).toBe(before)
    expect(declaredDependencies(folders.root)).toEqual({ [KERNEL]: VERSION })
    expect(installs(run).map(argv)).toEqual(['npm install'])
    expect(existsSync(join(folders.root, 'node_modules', ...KERNEL.split('/')))).toBe(true)
    expect(stdout()).toContain('Next: npx agent-qa plugins describe k')
  })
})

describe("plugins add runs as the project's agent-qa", () => {
  const NODE = '/fake/node'
  const NEWER = '99.0.0'
  const OLDER = '0.0.1'
  const RUNNING_AS =
    `Running the project's agent-qa ${NEWER} (node_modules/agent-qa) for plugins add.`
  const others: string[] = []

  afterEach(() => {
    for (const folder of others.splice(0)) rmSync(folder, { recursive: true, force: true })
  })

  function elsewhere(): string {
    const folder = mkdtempSync(join(tmpdir(), 'agent-qa-plugins-add-running-'))
    others.push(folder)
    return folder
  }

  function writeCopy(root: string, version: string): string {
    writeInstalledPackage(root, 'agent-qa', version, {
      packageJson: { bin: { 'agent-qa': 'dist/cli.js' } },
      files: { 'dist/cli.js': '' },
    })
    return join(root, 'node_modules', 'agent-qa')
  }

  function projectCopy(code: number) {
    return machine({
      install: (call) =>
        call.command === NODE ? { code, signal: null, output: '' } : installsDeclared(call),
    })
  }

  function handOffs(run: FakeRunner): RunnerCall[] {
    return run.calls.filter((call) => call.command === NODE)
  }

  it('a newer installed copy runs the same arguments, and its exit code 0 is the result', async () => {
    const folders = project()
    writeCopy(folders.root, NEWER)
    const before = snapshot(folders.root)
    const run = projectCopy(0)
    const config = join(folders.root, 'agent-qa.config.yaml')

    await add(folders, run, [KERNEL], config, { execPath: NODE, runningPackageDir: elsewhere() })

    const bin = join(realpathSync(folders.root), 'node_modules', 'agent-qa', 'dist', 'cli.js')
    expect(run.calls).toHaveLength(1)
    expect(run.calls[0]).toMatchObject({
      command: NODE,
      args: [bin, '--config', config, 'plugins', 'add', KERNEL],
      cwd: folders.root,
      stdio: 'inherit',
    })
    expect(run.calls[0]?.env.AGENT_QA_HANDED_OFF).toBe('1')
    expect(stdout()).toBe(RUNNING_AS)
    expect(snapshot(folders.root)).toEqual(before)
  })

  it("the project's copy exiting 3 makes plugins add exit 3", async () => {
    const folders = project()
    writeCopy(folders.root, NEWER)
    const before = snapshot(folders.root)
    const run = projectCopy(3)
    const host = { execPath: NODE, runningPackageDir: elsewhere() }

    const error = await refusal(add(folders, run, [KERNEL], undefined, host))

    expect(error.exitCode).toBe(3)
    expect(handOffs(run)).toHaveLength(1)
    expect(snapshot(folders.root)).toEqual(before)
  })

  it('a copy at the running version but at another real path also runs it', async () => {
    const folders = project()
    writeCopy(folders.root, VERSION)
    const run = projectCopy(0)
    const host = { execPath: NODE, runningPackageDir: elsewhere() }

    await add(folders, run, [KERNEL], undefined, host)

    expect(handOffs(run)).toHaveLength(1)
    expect(stdout()).toBe(
      `Running the project's agent-qa ${VERSION} (node_modules/agent-qa) for plugins add.`,
    )
    expect(existsSync(join(folders.root, 'package.json'))).toBe(false)
  })

  it("a version the project's copy runs at is passed to it rather than refused here", async () => {
    const folders = project()
    writeCopy(folders.root, NEWER)
    const run = projectCopy(0)
    const host = { execPath: NODE, runningPackageDir: elsewhere() }

    await add(folders, run, [`${KERNEL}@${NEWER}`], undefined, host)

    expect(handOffs(run).map((call) => call.args.at(-1))).toEqual([`${KERNEL}@${NEWER}`])
  })

  it('an older copy, which may have no plugins add, is not run: this one pins to its version', async () => {
    const folders = project()
    writeCopy(folders.root, OLDER)
    const run = projectCopy(0)
    const host = { execPath: NODE, runningPackageDir: elsewhere() }

    await add(folders, run, [`${KERNEL}@${OLDER}`, '--pm', 'npm'], undefined, host)

    expect(handOffs(run)).toEqual([])
    expect(declaredDependencies(folders.root)).toEqual({ [KERNEL]: OLDER })
    expect(stdout()).not.toContain("Running the project's agent-qa")
    expect(stdout()).toContain(`✓ Added the plugins entry kernel for ${KERNEL} ${OLDER}.`)
  })

  it("an older copy refuses a version other than its own, naming the copy's version", async () => {
    const folders = project()
    writeCopy(folders.root, OLDER)
    const run = projectCopy(0)
    const host = { execPath: NODE, runningPackageDir: elsewhere() }

    const error = await refusal(add(folders, run, [`${KERNEL}@${VERSION}`], undefined, host))

    expect(error.exitCode).toBe(2)
    expect(error.message).toBe(
      `${KERNEL} runs only at agent-qa's version, ${OLDER}. Run npx agent-qa plugins add ${KERNEL}.`,
    )
    expect(run.calls).toEqual([])
  })

  it('the copy that is running adds the plugin in this process at its version', async () => {
    const folders = project()
    const copy = writeCopy(folders.root, VERSION)
    const link = join(elsewhere(), 'agent-qa')
    symlinkSync(copy, link)
    const run = projectCopy(0)

    await add(folders, run, [KERNEL, '--pm', 'npm'], undefined, {
      execPath: NODE,
      runningPackageDir: link,
    })

    expect(handOffs(run)).toEqual([])
    expect(declaredDependencies(folders.root)).toEqual({ [KERNEL]: VERSION })
    expect(stdout()).toContain(`✓ Added the plugins entry kernel for ${KERNEL} ${VERSION}.`)
  })

  it('an agent-qa started by a hand-off adds the plugin itself, at the installed version', async () => {
    const folders = project()
    writeCopy(folders.root, NEWER)
    const run = projectCopy(0)

    await add(folders, run, [KERNEL, '--pm', 'npm'], undefined, {
      execPath: NODE,
      runningPackageDir: elsewhere(),
      env: { AGENT_QA_HANDED_OFF: '1' },
    })

    expect(handOffs(run)).toEqual([])
    expect(declaredDependencies(folders.root)).toEqual({ [KERNEL]: NEWER })
  })

  it('with no agent-qa installed this one adds the plugin at its own version', async () => {
    const folders = project()
    const run = projectCopy(0)

    await add(folders, run, [KERNEL, '--pm', 'npm'], undefined, {
      execPath: NODE,
      runningPackageDir: elsewhere(),
    })

    expect(handOffs(run)).toEqual([])
    expect(declaredDependencies(folders.root)).toEqual({ [KERNEL]: VERSION })
    expect(stdout()).not.toContain("Running the project's agent-qa")
  })
})

describe('plugins add refusals', () => {
  it.each([
    ['./plugins/x', 'agent-qa plugins add takes an npm package name. Add a path plugin by hand'],
    ['/abs/plugin', 'agent-qa plugins add takes an npm package name.'],
    ['~/plugin', 'agent-qa plugins add takes an npm package name.'],
    ['C:\\plugins\\x', 'agent-qa plugins add takes an npm package name.'],
    ['Not_A_Name!', 'Not_A_Name! is not an npm package name.'],
    [
      `${KERNEL}@0.0.1`,
      `${KERNEL} runs only at agent-qa's version, ${VERSION}. Run npx agent-qa plugins add ${KERNEL}.`,
    ],
  ])('%s exits 2, changes no file and runs nothing', async (argument, line) => {
    const folders = project()
    const before = snapshot(folders.root)
    const run = machine()

    const error = await refusal(add(folders, run, [argument, '--pm', 'npm']))

    expect(error.exitCode).toBe(2)
    expect(error.message).toContain(line)
    expect(snapshot(folders.root)).toEqual(before)
    expect(run.calls).toEqual([])
  })

  it.each(['--x', '-x', '-x@1.0.0'])(
    '%s after -- starts with a hyphen, exits 2, changes no file and runs nothing',
    async (argument) => {
      const folders = project()
      const before = snapshot(folders.root)
      const run = machine()

      const error = await refusal(add(folders, run, ['--pm', 'npm', '--', argument]))

      expect(error.exitCode).toBe(2)
      expect(error.message).toBe(`${argument} is not an npm package name: it starts with a hyphen.`)
      expect(snapshot(folders.root)).toEqual(before)
      expect(run.calls).toEqual([])
    },
  )

  it('the path refusal says how to add a path plugin by hand', async () => {
    const error = await refusal(add(project(), machine(), ['./plugins/x']))
    expect(error.message).toBe(
      'agent-qa plugins add takes an npm package name. Add a path plugin by hand: under plugins in agent-qa.config.yaml, write - name: <name> with path: <folder>.',
    )
  })

  it('a missing config exits 2 and changes nothing', async () => {
    const { root, home } = tempProject('plugins-add')
    const missing = join(root, 'missing.config.yaml')
    const run = machine()

    const error = await refusal(add({ root, home }, run, [KERNEL], missing))

    expect(error.exitCode).toBe(2)
    expect(error.message).toBe(
      `No agent-qa config at ${missing}. Run npx agent-qa init in the project's folder first.`,
    )
    expect(existsSync(join(root, 'package.json'))).toBe(false)
    expect(run.calls).toEqual([])
  })

  it('a failed install exits 3, keeps the declaration and leaves the config as it was', async () => {
    const folders = project()
    const before = configOf(folders.root)
    const run = machine({ install: () => ({ code: 1, signal: null, output: 'npm error 404' }) })

    const error = await refusal(add(folders, run, [KERNEL, '--pm', 'npm']))

    expect(error.exitCode).toBe(3)
    expect(error.lines).toEqual([])
    expect(declaredDependencies(folders.root)).toEqual({ [KERNEL]: VERSION })
    expect(configOf(folders.root)).toBe(before)
  })

  it('--pm none is not a choice and exits 2', async () => {
    const folders = project()
    const run = machine()

    const error = await refusal(add(folders, run, [KERNEL, '--pm', 'none']))

    expect(error.exitCode).toBe(2)
    expect(run.calls).toEqual([])
  })
})

const GRID = '@acme/agent-qa-plugin-grid'
const REMOTE_MANIFEST = {
  kind: 'remote',
  runs: 'process',
  protocol: 1,
  entry: './dist/main.js',
  serves: ['playwright'],
  methods: [],
  options: './dist/options.schema.json',
  settings: './dist/settings.schema.json',
}

function published(version: string, plugin: unknown = REMOTE_MANIFEST): Record<string, unknown> {
  return {
    name: GRID,
    version,
    ...(plugin === null ? {} : { 'agent-qa': { plugin } }),
  }
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
}

describe('plugins add with a third-party plugin', () => {
  it('pins a bare package at the version npm reports for latest and names the entry after it', async () => {
    const folders = project()
    const run = machine({ lookup: registry({ [`${GRID}@latest`]: published('1.4.2') }) })

    await add(folders, run, [GRID])

    expect(lookups(run)).toEqual([`npm view ${GRID}@latest --json`])
    expect(declaredDependencies(folders.root)).toEqual({ [GRID]: '1.4.2' })
    expect(installs(run).map(argv)).toEqual(['npm install'])
    expect(configOf(folders.root)).toContain(`  - name: grid\n    package: "${GRID}"\n`)
    expect(stdout()).toContain(`✓ Added the plugins entry grid for ${GRID} 1.4.2.`)
    expect(stdout()).toContain('Next: npx agent-qa plugins describe grid')
  })

  it('pins a given exact version at that version', async () => {
    const folders = project()
    const run = machine({ lookup: registry({ [`${GRID}@1.2.3`]: published('1.2.3') }) })

    await add(folders, run, [`${GRID}@1.2.3`])

    expect(lookups(run)).toEqual([`npm view ${GRID}@1.2.3 --json`])
    expect(declaredDependencies(folders.root)).toEqual({ [GRID]: '1.2.3' })
  })

  it('uses the last element of an npm answer that is an array', async () => {
    const folders = project()
    const answer = [published('1.4.1'), published('1.4.2')]
    const run = machine({ lookup: registry({ [`${GRID}@latest`]: answer }) })

    await add(folders, run, [GRID])

    expect(declaredDependencies(folders.root)).toEqual({ [GRID]: '1.4.2' })
  })

  it('refuses a range with exit 2 before running anything', async () => {
    const folders = project()
    const before = snapshot(folders.root)
    const run = machine()

    const error = await refusal(add(folders, run, [`${GRID}@^1`]))

    expect(error.exitCode).toBe(2)
    expect(error.message).toBe(
      `Give an exact version, such as ${GRID}@1.2.3, or none to install the latest.`,
    )
    expect(snapshot(folders.root)).toEqual(before)
    expect(run.calls).toEqual([])
  })

  it.each([
    [
      'no manifest',
      null,
      `${GRID}@1.4.2 has no valid agent-qa plugin manifest (agent-qa.plugin is missing); nothing was changed.`,
    ],
    [
      'an invalid manifest',
      { kind: 'remote', runs: 'process' },
      `${GRID}@1.4.2 has no valid agent-qa plugin manifest (agent-qa.plugin.protocol); nothing was changed.`,
    ],
    [
      'an in-process manifest',
      { kind: 'model-auth', runs: 'in-process', entry: './dist/index.js' },
      `${GRID} asks to run inside agent-qa's process, which only first-party plugins may do; nothing was changed.`,
    ],
  ])('a package with %s exits 2 and changes nothing', async (_label, plugin, line) => {
    const folders = project()
    const before = snapshot(folders.root)
    const run = machine({ lookup: registry({ [`${GRID}@latest`]: published('1.4.2', plugin) }) })

    const error = await refusal(add(folders, run, [GRID]))

    expect(error.exitCode).toBe(2)
    expect(error.message).toBe(line)
    expect(snapshot(folders.root)).toEqual(before)
    expect(installs(run)).toEqual([])
  })

  it('a failed lookup prints its last lines and the command, exits 3 and changes nothing', async () => {
    const folders = project()
    const before = snapshot(folders.root)
    const run = machine({ lookup: registry({}) })

    const error = await refusal(add(folders, run, [GRID]))

    expect(error.exitCode).toBe(3)
    expect(error.lines).toEqual([])
    expect(stdout()).toContain(`✗ Could not look up ${GRID}: npm exited 1`)
    expect(stdout()).toContain(`  npm error 404 ${GRID}@latest`)
    expect(stdout()).toContain(`  Run: npm view ${GRID}@latest --json`)
    expect(snapshot(folders.root)).toEqual(before)
    expect(installs(run)).toEqual([])
  })
})

describe('plugins add entry names', () => {
  it.each([
    [KERNEL, 'kernel'],
    [SUBSCRIPTION, 'subscription'],
    ['agent-qa-plugin-grid', 'grid'],
    [GRID, 'grid'],
    ['@acme/Fancy_Thing', 'fancy-thing'],
    ['left-pad', 'left-pad'],
  ])('%s is named %s', (packageName, name) => {
    expect(pluginEntryName(packageName)).toBe(name)
  })

  it('--name replaces the name taken from the package', async () => {
    const folders = project()
    const run = machine({ lookup: registry({ [`${GRID}@latest`]: published('1.4.2') }) })

    await add(folders, run, [GRID, '--name', 'grid2'])

    expect(configOf(folders.root)).toContain(`  - name: grid2\n    package: "${GRID}"\n`)
    expect(stdout()).toContain('Next: npx agent-qa plugins describe grid2')
  })

  it('a name another entry uses exits 2 listing the names, and --name then adds it', async () => {
    const folders = project([
      'plugins:',
      '  - name: grid',
      '    package: "@other/grid"',
      '  - name: local',
      '    path: ./plugins/local',
    ])
    const before = snapshot(folders.root)
    const run = machine({ lookup: registry({ [`${GRID}@latest`]: published('1.4.2') }) })

    const error = await refusal(add(folders, run, [GRID]))

    expect(error.exitCode).toBe(2)
    expect(error.message).toBe(
      'plugins already has an entry named grid. plugins lists: grid, local. ' +
        'Pass --name <another name>.',
    )
    expect(snapshot(folders.root)).toEqual(before)
    expect(run.calls).toEqual([])

    await add(folders, run, [GRID, '--name', 'grid2'])

    const plugins = (parse(configOf(folders.root)) as { plugins: { name: string }[] }).plugins
    expect(plugins.map((entry) => entry.name)).toEqual(['grid', 'local', 'grid2'])
  })

  it('a name that fails the plugins name rule exits 2 and changes nothing', async () => {
    const folders = project()
    const before = snapshot(folders.root)
    const run = machine()

    const error = await refusal(add(folders, run, [KERNEL, '--name', 'Bad_Name']))

    expect(error.exitCode).toBe(2)
    expect(error.message).toBe(
      'Bad_Name is not a plugins entry name: use lowercase letters, digits, hyphens and dots, ' +
        'starting with a letter or digit. Pass --name <name>.',
    )
    expect(snapshot(folders.root)).toEqual(before)
    expect(run.calls).toEqual([])
  })
})

describe('plugins add looks a package up with the project manager', () => {
  const spec = `${GRID}@latest`
  const answers = { [spec]: published('1.4.2') }

  it('pnpm views it', async () => {
    const folders = project()
    writeFileSync(join(folders.root, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n")
    const run = machine({ lookup: registry(answers) })

    await add(folders, run, [GRID])

    expect(lookups(run)).toEqual([`pnpm view ${spec} --json`])
    expect(installs(run).map(argv)).toEqual(['pnpm install'])
  })

  it('Yarn 4 asks npm info', async () => {
    const folders = project()
    writeJson(join(folders.root, 'package.json'), { packageManager: 'yarn@4.18.1' })
    const run = machine({ versions: { yarn: '4.18.1' }, lookup: registry(answers) })

    await add(folders, run, [GRID])

    expect(lookups(run)).toEqual([`yarn npm info ${spec} --json`])
  })

  it('Yarn 1 asks info, and its inspect answer parses', async () => {
    const folders = project()
    writeJson(join(folders.root, 'package.json'), { packageManager: 'yarn@1.22.19' })
    const inspect = [
      JSON.stringify({ type: 'warning', data: 'package.json: No license field' }),
      JSON.stringify({ type: 'inspect', data: published('1.4.2') }),
    ].join('\n')
    const run = machine({ versions: { yarn: '1.22.19' }, lookup: registry({ [spec]: inspect }) })

    await add(folders, run, [GRID])

    expect(lookups(run)).toEqual([`yarn info ${spec} --json`])
    expect(declaredDependencies(folders.root)).toMatchObject({ [GRID]: '1.4.2' })
  })

  it('bun views it through pm', async () => {
    const folders = project()
    writeFileSync(join(folders.root, 'bun.lock'), '{}\n')
    const run = machine({ lookup: registry(answers) })

    await add(folders, run, [GRID])

    expect(lookups(run)).toEqual([`bun pm view ${spec} --json`])
  })

  it('a manager reached through corepack keeps the corepack prefix', async () => {
    const folders = project()
    writeJson(join(folders.root, 'package.json'), { packageManager: 'pnpm@12.17.0' })
    const run = machine({
      versions: { pnpm: null, corepack: '0.36.0' },
      lookup: registry(answers),
    })

    await add(folders, run, [GRID])

    expect(lookups(run)).toEqual([`corepack pnpm@12.17.0 view ${spec} --json`])
  })

  it('a manager reached through npx keeps the npx prefix', async () => {
    const folders = project()
    writeJson(join(folders.root, 'package.json'), { packageManager: 'pnpm@12.17.0' })
    const run = machine({ versions: { pnpm: null, corepack: null }, lookup: registry(answers) })

    await add(folders, run, [GRID])

    expect(lookups(run)).toEqual([`npx -y pnpm@12.17.0 view ${spec} --json`])
  })
})

describe('parsePackageView', () => {
  it('reads an object, the last element of an array and an inspect envelope', () => {
    expect(parsePackageView('{"version":"1.0.0"}')).toEqual({ version: '1.0.0' })
    expect(parsePackageView('[{"version":"1.0.0"},{"version":"1.1.0"}]')).toEqual({
      version: '1.1.0',
    })
    expect(parsePackageView('{"type":"inspect","data":{"version":"2.0.0"}}')).toEqual({
      version: '2.0.0',
    })
  })

  it('finds the answer after warning lines and gives nothing for text that is not JSON', () => {
    expect(parsePackageView('npm warn config something\n{\n  "version": "1.0.0"\n}\n')).toEqual({
      version: '1.0.0',
    })
    expect(parsePackageView('not json')).toBeUndefined()
    expect(parsePackageView('"1.0.0"')).toBeUndefined()
  })
})
