// A yaml parse error reports a position only, because the library's message quotes the source.

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { inspect } from 'node:util'

import { invokeFunction } from '@vostride/agent-qa-agent'
import { generateTestId } from '@vostride/agent-qa-ids'
import {
  formatDiagnostics,
  parseTestFile,
  resolveWorkspacePaths,
  validateProject,
  yamlParseFailureMessage,
} from '@vostride/agent-qa-core'
import { runSafetyScope } from '@vostride/agent-qa-safety-local'
import { parse as parseYaml } from 'yaml'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  loadConfigFile,
  loadRequiredConfigFile,
  mergeConfigs,
  mergeWithTestConfig,
  resolveConfig,
} from '../../config.js'
import { CLI_FUNCTION_CALLER, composeCliLocalAgent } from '../local-agent-host.js'

const CONFIG_FILE = 'agent-qa.config.yaml'

/**
 * The planted value: `sk-ant-`-shaped, and OWNED BY THIS FIXTURE.
 *
 * Shaped like the thing a person actually pastes into a file and forgets, and unmistakably not one:
 * the whole point of the cells below is that this string must not appear in any message, so it has
 * to be searchable, distinctive, and impossible to confuse with a live credential.
 */
const PLANTED_CREDENTIAL = 'sk-ant-api03-395fourteenFIXTUREONLYnotarealkey'

// Drives the built `dist/cli.js`, so a stale dist measures the previous build.
const CLI_DIST = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'dist', 'cli.js')

let root: string
let configPath: string
let agentQaRoot: string

function git(...args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) {
    // A `git` that ran and failed must not return quietly.
    throw new Error(`git ${args.join(' ')} exited ${result.status}: ${result.stderr}`)
  }
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1
}

/**
 * The config a person committed: valid-looking, comment-carrying, and holding a DUPLICATE top-level
 * key with the planted value on the line immediately above it.
 *
 * THE ADJACENCY IS THE FIXTURE. `yaml` reports a duplicate key at the key's own line and prints the
 * preceding line with it, so the credential is what the excerpt carries. That is not a contrivance —
 * it is the mechanism by which any line of a person's file can end up in an error message, and the
 * only way to measure the channel is to put something recognisable on the line it prints.
 */
// Complete on purpose: `config.field.set` validates the whole candidate, so a gap would block it.
const WELL_FORMED_CONFIG = `# my project's own agent-qa configuration
workspace:
  testMatch:
    - tests/**/*.yaml
  suiteMatch:
    - suites/**/*.suite.yaml
  hooksFile: hooks.yaml
  envFile: .env
  secretsFile: .env.secrets.local

registry:
  llms:
    - name: judge
      provider: openai-subscription
      model: gpt-5.6-terra

use:
  llm: judge
  parallel: false
  mobile:
    appState: preserve
  timeout:
    step: 30s
    test: 90m
    navigation: 2m
`

/** The ordinary line the secretless control carries where the credential otherwise sits. */
const ORDINARY_LINE = 'an ordinary line with nothing sensitive on it'

function faultyConfigText(options: { readonly credential: boolean }): string {
  const carried = options.credential
    ? `apiToken: ${PLANTED_CREDENTIAL}`
    : `apiToken: ${ORDINARY_LINE}`
  // THE SAME FILE, PLUS ONE DUPLICATE TOP-LEVEL KEY. The person's config was fine and then a merge
  // or a copy-paste gave them a second `registry:` — which is why the fixture is this file and not
  // a scrap of broken yaml: what the excerpt discloses is the content of a file worth protecting.
  return `${WELL_FORMED_CONFIG}
# pasted in from the provider dashboard months ago
${carried}
registry:
  llms: []
`
}

/**
 * Write the config and COMMIT it, because a committed file is what every road here reads.
 *
 * `config.project.scaffold` re-reads the committed set at proposal time and the apply's porcelain
 * check is scoped to it, so a fixture left dirty would be measuring a different road in.
 */
function seedConfig(text: string): void {
  writeFileSync(configPath, text)
  git('add', '--', CONFIG_FILE)
  git('commit', '--quiet', '-m', 'the project configures itself')
}

// `config show` refuses at start without the declared secrets file.
function seedSecretsFile(): void {
  writeFileSync(join(root, '.env.secrets.local'), '')
}

// One distinct value per member, so a whole-output failure says which member leaked.
const PLANTED_HOOKS_CREDENTIAL = 'sk-ant-api03-395sixteenHOOKSFIXTUREONLYnotarealkey'
const PLANTED_SUITE_CREDENTIAL = 'sk-ant-api03-395sixteenSUITEFIXTUREONLYnotarealkey'

// A plain test yaml, the other arm of `isSuiteFile`; its own value says which member leaked.
const PLANTED_TEST_CREDENTIAL = 'sk-ant-api03-395eighteenTESTFIXTUREONLYnotarealkey'

// The fifth member: `agent-qa.local.yaml`, read by `loadLocalBindings`.
const PLANTED_LOCAL_CREDENTIAL = 'sk-ant-api03-395eighteenLOCALFIXTUREONLYnotarealkey'

/** The same adjacency mechanism as the config fixture, one file class over. */
const FAULTY_HOOKS = `hooks:
  - id: 01JQZ0000000000000000LOGIN
    name: login
    runtime: node
    file: ./scripts/login.js
    timeout: 30s

# pasted in from the provider dashboard months ago
apiToken: ${PLANTED_HOOKS_CREDENTIAL}
hooks:
  - id: 01JQZ0000000000000000OTHER
`

const FAULTY_SUITE = `name: checkout
tests:
  - tests/a.yaml

# pasted in from the provider dashboard months ago
apiToken: ${PLANTED_SUITE_CREDENTIAL}
tests:
  - tests/b.yaml
`

/**
 * A plain test yaml — the same adjacency mechanism, on the member `parseTestFile` owns.
 *
 * It matches `WELL_FORMED_CONFIG`'s `testMatch` glob (`tests/**` + `*.yaml`) and NOT its
 * `suiteMatch` glob, so `validateFiles` takes the `else` arm and the file reaches
 * `validateTestFile` -> `parseTestFile` -> `formatYamlError`.
 *
 * THE DUPLICATED KEY IS THE CREDENTIAL'S OWN LINE, and that is deliberate rather than incidental.
 * `formatYamlError` speaks on two channels: the pretty `message` (which prints the excerpt AROUND
 * the flagged line) and `source` (which is a copy of the flagged line ITSELF, `content.split('\n')`
 * indexed by `linePos.line`). A fixture whose duplicate key sits on a structural line below the
 * credential reds the message channel and leaves `source` carrying `steps:` — a person's own line,
 * but not a recognisable one. Duplicating the `apiToken` key puts the planted value on BOTH
 * channels, so each channel's pre-fix RED names the value it published.
 */
const FAULTY_TEST = `name: log in to the app
target: my-app
steps:
  - Click the login button

# pasted in from the provider dashboard, and again after a bad merge
apiToken: ${PLANTED_TEST_CREDENTIAL}
apiToken: ${PLANTED_TEST_CREDENTIAL}
`

// `WELL_FORMED_CONFIG` plus a device, so `devices list` reaches `loadLocalBindings`.
const CONFIG_WITH_DEVICE = WELL_FORMED_CONFIG.replace(
  'registry:\n  llms:',
  'registry:\n  devices:\n    handset:\n      platform: ios\n  llms:',
)

/** `agent-qa.local.yaml`, the same adjacency mechanism, on the file only this machine has. */
const FAULTY_LOCAL_BINDINGS = `devices:
  handset:
    udid: 00008030-001A

# pasted in from the provider dashboard, and again after a bad merge
apiToken: ${PLANTED_LOCAL_CREDENTIAL}
apiToken: ${PLANTED_LOCAL_CREDENTIAL}
`

/** Write a repo-relative file and COMMIT it — every road here reads a committed tree. */
function seedFile(relativePath: string, text: string): void {
  const absolute = join(root, relativePath)
  mkdirSync(dirname(absolute), { recursive: true })
  writeFileSync(absolute, text)
  git('add', '--', relativePath)
  git('commit', '--quiet', '-m', `the project commits ${relativePath}`)
}

/**
 * The files `WELL_FORMED_CONFIG`'s workspace block names, so the workspace road resolves and the
 * rendering under assertion is the members' own diagnostics rather than a pile of missing-file ones.
 */
function seedWorkspaceSupportFiles(): void {
  writeFileSync(join(root, '.env'), '')
  writeFileSync(join(root, '.env.secrets.local'), '')
  mkdirSync(join(root, 'scripts'), { recursive: true })
  writeFileSync(join(root, 'scripts', 'login.js'), 'console.log("login")\n')
  mkdirSync(join(root, 'tests'), { recursive: true })
  git('add', '--', '.env', '.env.secrets.local', 'scripts/login.js')
  git('commit', '--quiet', '-m', 'the project has the files its config names')
}

/**
 * The road `agent-qa validate` actually takes (commands/validate.ts:13-24), reproduced rather than
 * approximated: resolve the config, resolve the workspace, hand both to `validateProject`, and
 * RENDER. The string returned is the string the command writes to stdout.
 */
async function renderedValidateOutput(
  overrides: { readonly hooksFile?: string } = {},
): Promise<string> {
  let workspace
  try {
    const config = await resolveConfig({ configPath, loadAuthPlugins: false })
    workspace = resolveWorkspacePaths({ config, configPath })
  } catch {
    // Exactly as the command does: validateProject reports the config diagnostics itself.
  }
  const result = await validateProject({ configPath, workspace, hooksFile: overrides.hooksFile })
  return formatDiagnostics(result)
}

/**
 * Drive one verb through the PRODUCTION composition and never rethrow.
 *
 * The rejection is the subject here, so it is returned rather than thrown: every cell below reads
 * the message off it and asserts about the string itself.
 */
async function invokeComposed(input: {
  readonly functionId: string
  readonly payload: unknown
}): Promise<{ readonly answer?: unknown; readonly error?: Error }> {
  const host = composeCliLocalAgent({ agentQaRoot, configPath })
  try {
    const answer = await runSafetyScope({ executionContext: 'local-interactive' }, async () =>
      await invokeFunction(host.registry, input.functionId, input.payload, CLI_FUNCTION_CALLER))
    return { answer }
  } catch (error) {
    return { error: error as Error }
  } finally {
    await host.close()
  }
}

/** The one shape every road cell asserts: the fault is named by POSITION and by nothing else. */
function expectPositionOnly(message: string): void {
  expect(
    occurrences(message, PLANTED_CREDENTIAL),
    `the message carried the planted credential: ${message}`,
  ).toBe(0)
  expect(message).toMatch(/line \d+, column \d+/)
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'config-fault-surface-'))
  configPath = join(root, CONFIG_FILE)
  agentQaRoot = join(root, '.agent-qa')

  git('init', '--quiet')
  git('config', 'user.name', 'agent-qa fault surface test')
  git('config', 'user.email', 'fault-surface-test@example.invalid')
  git('config', 'commit.gpgsign', 'false')
  writeFileSync(join(root, '.gitignore'), '# the project\'s own rules\ndist/\n.agent-qa/\n')
  writeFileSync(join(root, 'README.md'), 'a project with a configuration it cannot parse\n')
  git('add', '--', '.gitignore', 'README.md')
  git('commit', '--quiet', '-m', 'seed')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('a committed config the parser cannot read names WHERE, never WHAT', () => {
  it("config.field.set faults with the position and none of the file's content", async () => {
    seedConfig(faultyConfigText({ credential: true }))

    const { error } = await invokeComposed({
      functionId: 'config.field.set',
      payload: { path: 'use.timeout.step', value: '45s' },
    })

    // THE OP STILL FAULTS. Converting the throw into a typed refusal arm is F-03's fix and is out
    // of this round's scope — only the message's CONTENT changes.
    expect(error, 'an unreadable committed config must still fault the op').toBeDefined()
    const message = error?.message ?? ''
    // THE DISCLOSURE ASSERTION FIRST, because it is the one F-01 is about: on pre-fix HEAD this
    // line failed with the planted credential quoted back out of the person's own file.
    expectPositionOnly(message)
    expect(message).toContain(CONFIG_FILE)
  })

  it('config.target.create faults the same way — the guard is in the LOADER', async () => {
    seedConfig(faultyConfigText({ credential: true }))

    const { error } = await invokeComposed({
      functionId: 'config.target.create',
      payload: { name: 'shop', platform: 'web', url: 'https://shop.example.com' },
    })

    expect(error, 'an unreadable committed config must still fault the op').toBeDefined()
    const message = error?.message ?? ''
    expectPositionOnly(message)
    expect(message).toContain(CONFIG_FILE)
  })

  it('config.project.scaffold faults the same way — the third op, from zero', async () => {
    seedConfig(faultyConfigText({ credential: true }))

    const { error } = await invokeComposed({
      functionId: 'config.project.scaffold',
      payload: { domain: 'booking.com' },
    })

    expect(error, 'an unreadable committed config must still fault the op').toBeDefined()
    const message = error?.message ?? ''
    expectPositionOnly(message)
    expect(message).toContain(CONFIG_FILE)
  })

  it('agent-qa validate reports the same fault position-only — the SIBLING site', async () => {
    seedConfig(faultyConfigText({ credential: true }))

    // THE ROAD `agent-qa validate` TAKES. The command catches its own `resolveConfig` failure and
    // defers to core `validateProject`, whose config-member arm is a SECOND interpolation site —
    // not a caller of the cli loader at all. A fix that hardened only the loader leaves this road
    // printing the excerpt, which is the half a three-op corpus cannot see.
    const result = await validateProject({ configPath })

    const configDiagnostics = result.diagnostics.filter((d) => d.file === configPath)
    expect(configDiagnostics).toHaveLength(1)
    const message = configDiagnostics[0]?.message ?? ''
    expectPositionOnly(message)

    // AND THE RENDERED OUTPUT, because the diagnostic is a structure and the person reads a string.
    const rendered = formatDiagnostics(result)
    expect(occurrences(rendered, PLANTED_CREDENTIAL)).toBe(0)
    expect(rendered).toMatch(/line \d+, column \d+/)
  })

  it('the chat answer carries EXACTLY this string — refusalMessage returns .message',
    async () => {
      seedConfig(faultyConfigText({ credential: true }))

      const { error } = await invokeComposed({
        functionId: 'config.project.scaffold',
        payload: { domain: 'booking.com' },
      })

      // THE EQUIVALENCE THE CHAT ROAD RESTS ON, asserted rather than assumed. `routeWriteTest`
      // captures this rejection and hands it to `refusalMessage` (turn-engine.ts:290-292), which
      // for an `Error` with a NON-EMPTY message returns that message VERBATIM — it falls through to
      // `refusalName` only otherwise. So the two predicates below are precisely the conditions
      // under which the string asserted next IS the sentence a chat turn's answer prints and the
      // session jsonl persists.
      expect(error).toBeInstanceOf(Error)
      expect(error?.message).not.toBe('')

      const asAChatTurnWouldCarryIt = error?.message ?? ''
      expectPositionOnly(asAChatTurnWouldCarryIt)
      expect(asAChatTurnWouldCarryIt).toContain(CONFIG_FILE)
    })
})

// `util.inspect` walks the `cause` chain, so the error is checked as a value, not just its message.
describe('the loader\'s error is clean as a VALUE, and the shipped command reports it', () => {
  it('the rejection serializes position-only — util.inspect and .stack, not just .message',
    async () => {
      seedConfig(faultyConfigText({ credential: true }))

      const error = await loadConfigFile(configPath).then(
        () => undefined,
        (err: unknown) => err as Error,
      )
      expect(error, 'an unreadable committed config must still reject').toBeDefined()

      // THE CAUSE CHAIN, as every printer renders it. `inspect(err, { depth: null })` is what the
      // default uncaught printer, `console.error(err)` and every structured logger do with a thrown
      // value; a raw `YAMLParseError` attached as `cause` republishes the excerpt through all three.
      const serialized = inspect(error, { depth: null })
      expect(
        occurrences(serialized, PLANTED_CREDENTIAL),
        `the serialization carried the planted credential: ${serialized}`,
      ).toBe(0)

      // AND THE STACK, which is a second serialization of the same value — `err.stack` on an error
      // with a cause is rendered with the cause by V8's own formatter in several hosts, and is what
      // crash reporters upload.
      const stack = String(error?.stack ?? '')
      expect(
        occurrences(stack, PLANTED_CREDENTIAL),
        `the stack carried the planted credential: ${stack}`,
      ).toBe(0)

      // The `.message` surface stays position-only.
      expectPositionOnly(error?.message ?? '')
      expect(error?.message).toContain(CONFIG_FILE)
    })

  it('the SHIPPED `agent-qa config show` reports the position and never crash-prints the file',
    () => {
      seedConfig(faultyConfigText({ credential: true }))

      // THE BINARY, NOT THE SOURCE, and its WHOLE output — no stream filter, no line filter. The
      // verifier reproduced this leak by running exactly this command.
      const run = spawnSync(process.execPath, [CLI_DIST, 'config', 'show'], {
        cwd: root,
        encoding: 'utf8',
        env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
      })
      const combined = `${run.stdout ?? ''}${run.stderr ?? ''}`

      expect(
        occurrences(combined, PLANTED_CREDENTIAL),
        `the command's output carried the planted credential:\n${combined}`,
      ).toBe(0)
      expect(combined, `the command's output:\n${combined}`)
        .toMatch(/not readable as YAML at line \d+, column \d+/)
      // THE CRASH-PRINTER'S OWN RENDERING, asserted on the runtime's output. Node writes
      // `[cause]: ...` when it prints an uncaught error carrying one; no source comment can fake
      // this assertion and no `.message` cell can reach it.
      expect(combined, `the command's output:\n${combined}`).not.toMatch(/\[cause\]/)
      expect(run.status, `the command should report and exit 1, not crash-exit: ${combined}`).toBe(1)
    })
})

// Asserted over the whole rendered output with no per-file filter, the string a person reads.
describe('every member of the config file set reports position-only', () => {
  it('a hooks.yaml the parser cannot read renders position-only in the WHOLE output',
    async () => {
      // The config member must PARSE, so the road reaches its sibling at all.
      seedConfig(WELL_FORMED_CONFIG)
      seedWorkspaceSupportFiles()
      seedFile('hooks.yaml', FAULTY_HOOKS)

      const rendered = await renderedValidateOutput()

      expect(
        occurrences(rendered, PLANTED_HOOKS_CREDENTIAL),
        `the rendered validate output carried the hooks credential:\n${rendered}`,
      ).toBe(0)
      expect(rendered, `the rendered validate output:\n${rendered}`)
        .toMatch(/hooks\.yaml/)
      expect(rendered, `the rendered validate output:\n${rendered}`)
        .toMatch(/not readable as YAML at line \d+, column \d+/)
    })

  it('BOTH members poisoned at once — one whole-surface assertion over the set', async () => {
    // `hooksFile` is named explicitly: an unreadable config leaves `validateProject` short of it.
    seedConfig(faultyConfigText({ credential: true }))
    seedWorkspaceSupportFiles()
    seedFile('hooks.yaml', FAULTY_HOOKS)

    const rendered = await renderedValidateOutput({ hooksFile: join(root, 'hooks.yaml') })

    expect(
      occurrences(rendered, PLANTED_CREDENTIAL),
      `the rendered validate output carried the config credential:\n${rendered}`,
    ).toBe(0)
    expect(
      occurrences(rendered, PLANTED_HOOKS_CREDENTIAL),
      `the rendered validate output carried the hooks credential:\n${rendered}`,
    ).toBe(0)
    expect(rendered, `the rendered validate output:\n${rendered}`)
      .toMatch(/not readable as YAML at line \d+, column \d+/)

    // Both members are named and the position sentence counted once each, so a silent member fails.
    expect(rendered, `the rendered validate output:\n${rendered}`).toMatch(/agent-qa\.config\.yaml/)
    expect(rendered, `the rendered validate output:\n${rendered}`).toMatch(/hooks\.yaml/)
    expect(
      rendered.match(/not readable as YAML at line \d+, column \d+/g)?.length ?? 0,
      `the set is two members, so the rendering carries two position sentences:\n${rendered}`,
    ).toBe(2)
  })

  it('a suite file the parser cannot read renders position-only — the third member',
    async () => {
      // The suite file is found through the workspace's `suiteMatch` glob, as `validate` finds it.
      seedConfig(WELL_FORMED_CONFIG)
      seedWorkspaceSupportFiles()
      seedFile('hooks.yaml', 'hooks: []\n')
      seedFile('suites/leak.suite.yaml', FAULTY_SUITE)

      const rendered = await renderedValidateOutput()

      expect(
        occurrences(rendered, PLANTED_SUITE_CREDENTIAL),
        `the rendered validate output carried the suite credential:\n${rendered}`,
      ).toBe(0)
      expect(rendered, `the rendered validate output:\n${rendered}`)
        .toMatch(/leak\.suite\.yaml/)
      expect(rendered, `the rendered validate output:\n${rendered}`)
        .toMatch(/not readable as YAML at line \d+, column \d+/)
    })
})

// `formatYamlError` speaks through the message and `ParseError.source`; each gets a cell.
describe('the plain-test member reports position-only on BOTH channels', () => {
  it('the SHIPPED `agent-qa validate` renders a plain test yaml position-only', () => {
    // The config member must PARSE, so discovery resolves a workspace and the road reaches the
    // plain-test member at all.
    seedConfig(WELL_FORMED_CONFIG)
    seedWorkspaceSupportFiles()
    seedFile('hooks.yaml', 'hooks: []\n')
    seedFile('tests/leak.yaml', FAULTY_TEST)

    // THE BINARY, NOT THE SOURCE, and the BARE discovery road — no file argument, so the file is
    // found through the workspace's own `testMatch` glob exactly as a person's `agent-qa validate`
    // finds it. Whole combined stdout+stderr, no stream or line filter.
    const run = spawnSync(process.execPath, [CLI_DIST, 'validate'], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
    })
    const combined = `${run.stdout ?? ''}${run.stderr ?? ''}`

    expect(
      occurrences(combined, PLANTED_TEST_CREDENTIAL),
      `the command's output carried the planted credential:\n${combined}`,
    ).toBe(0)
    expect(combined, `the command's output:\n${combined}`)
      .toMatch(/not readable as YAML at line \d+, column \d+/)
    // The fault is still REPORTED, and the person is still told which file to open.
    expect(combined, `the command's output:\n${combined}`).toMatch(/leak\.yaml/)
    expect(run.status, `an unreadable test file is still an error exit: ${combined}`).toBe(1)
  })

  it("the producer's own ParseError is position-only in message AND in source", () => {
    // `ParseError.source` skips `validate` but reaches `run`'s printer and the dashboard DB.
    seedConfig(WELL_FORMED_CONFIG)
    seedWorkspaceSupportFiles()
    seedFile('tests/leak.yaml', FAULTY_TEST)

    // PRODUCED, NEVER A LITERAL: the bytes handed to the parser are read back off the committed
    // file, so this cell cannot pin content the seeding road does not actually put on disk.
    const testPath = join(root, 'tests', 'leak.yaml')
    const committed = readFileSync(testPath, 'utf-8')
    const result = parseTestFile(committed, testPath)

    expect(result.errors.length, 'a duplicate top-level key is a parse fault').toBeGreaterThan(0)
    const first = result.errors[0]

    // THE SOURCE CHANNEL FIRST, because it is the one no other cell in this file can reach.
    expect(
      first?.source,
      `ParseError.source is a copy of the person's own line, printed by run.ts:599-613 and `
      + `persisted into the dashboard DB at run.ts:2676: ${JSON.stringify(first?.source)}`,
    ).toBe('')
    expect(
      occurrences(first?.message ?? '', PLANTED_TEST_CREDENTIAL),
      `the message carried the planted credential: ${first?.message}`,
    ).toBe(0)
    expect(first?.message).toMatch(/^not readable as YAML at line \d+, column \d+$/)
  })
})

describe('the other person-visible yaml-parse roads report position-only', () => {
  it('the SHIPPED `agent-qa run --suite` never quotes the suite file back', () => {
    seedConfig(WELL_FORMED_CONFIG)
    seedWorkspaceSupportFiles()
    seedFile('hooks.yaml', 'hooks: []\n')
    seedFile('tests/ok.yaml', 'name: fine\ntarget: my-app\nsteps:\n  - Click something\n')
    seedFile('suites/leak.suite.yaml', FAULTY_SUITE)

    // `parseSuiteFile` (core/src/parser/suite-parser.ts:8) handed `parseYaml` the person's bytes
    // with NO catch at all, and `run.ts:1079` awaits it inside the suite preflight. The throw is
    // reported as `Framework error: <the library's pretty excerpt>`.
    const run = spawnSync(process.execPath, [CLI_DIST, 'run', '--suite', 'suites/leak.suite.yaml'], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
    })
    const combined = `${run.stdout ?? ''}${run.stderr ?? ''}`

    expect(
      occurrences(combined, PLANTED_SUITE_CREDENTIAL),
      `the command's output carried the planted credential:\n${combined}`,
    ).toBe(0)
    expect(combined, `the command's output:\n${combined}`)
      .toMatch(/not readable as YAML at line \d+, column \d+/)
    expect(combined, `the command's output:\n${combined}`).toMatch(/leak\.suite\.yaml/)
  })

  it('the SHIPPED `agent-qa devices list` never crash-prints agent-qa.local.yaml', () => {
    // `loadLocalBindings` (cli/src/devices.ts:67) parsed `agent-qa.local.yaml` unguarded, so the
    // raw `YAMLParseError` left the process through Node's default uncaught printer — the excerpt,
    // the stack, and the `linePos` object, all of it. The config below names a device so the
    // command reaches the local-bindings road at all.
    seedConfig(CONFIG_WITH_DEVICE)
    seedFile('agent-qa.local.yaml', FAULTY_LOCAL_BINDINGS)

    const run = spawnSync(process.execPath, [CLI_DIST, 'devices', 'list'], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
    })
    const combined = `${run.stdout ?? ''}${run.stderr ?? ''}`

    expect(
      occurrences(combined, PLANTED_LOCAL_CREDENTIAL),
      `the command's output carried the planted credential:\n${combined}`,
    ).toBe(0)
    expect(combined, `the command's output:\n${combined}`)
      .toMatch(/not readable as YAML at line \d+, column \d+/)
    expect(combined, `the command's output:\n${combined}`).toMatch(/agent-qa\.local\.yaml/)
    // The uncaught printer's own marks. A report is not a crash.
    expect(combined, `the command's output:\n${combined}`).not.toMatch(/YAMLParseError/)
    expect(combined, `the command's output:\n${combined}`).not.toMatch(/linePos/)
  })
})

/** The `agent-qa.local.yaml` an older `agent-qa init` wrote: a `providers:` block holding only comments. */
const OLDER_INIT_LOCAL_BINDINGS = `# This file is for machine-specific device, app, and provider bindings.
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
`

/** `CONFIG_WITH_DEVICE` with an iOS target, so a test on it runs on the registered device. */
const CONFIG_WITH_DEVICE_TARGET = CONFIG_WITH_DEVICE.replace(
  'registry:\n',
  'registry:\n  targets:\n    my-app:\n      platform: ios\n      bundleId: com.example.app\n',
)

function deviceTest(testId: string): string {
  return `test-id: ${testId}\nname: probe\ntarget: my-app\nuse:\n  device: handset\nsteps:\n  - Tap the login button\n`
}

function runShipped(args: readonly string[]): { status: number | null; combined: string } {
  const run = spawnSync(process.execPath, [CLI_DIST, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
  })
  return { status: run.status, combined: `${run.stdout ?? ''}${run.stderr ?? ''}` }
}

function expectLocalFileRefusal(result: { status: number | null; combined: string }): void {
  const { status, combined } = result
  expect(combined, `the command's output:\n${combined}`)
    .toMatch(/agent-qa\.local\.yaml:\s+providers: providers was removed: .* Delete this block\./)
  expect(status, `the command's output:\n${combined}`).toBe(1)
  // Node's uncaught printer leaves a stack frame and its version line.
  expect(combined, `the command's output:\n${combined}`).not.toMatch(/^\s+at /m)
  expect(combined, `the command's output:\n${combined}`).not.toMatch(/Node\.js v\d+/)
}

describe('a refused agent-qa.local.yaml refuses the command that reads it', () => {
  it('the SHIPPED `agent-qa devices list` reports the refusal and exits 1', () => {
    seedConfig(CONFIG_WITH_DEVICE)
    seedFile('agent-qa.local.yaml', OLDER_INIT_LOCAL_BINDINGS)

    expectLocalFileRefusal(runShipped(['devices', 'list']))
  })

  it('the SHIPPED `agent-qa run` on a device test refuses before the run is recorded', () => {
    seedConfig(CONFIG_WITH_DEVICE_TARGET)
    seedWorkspaceSupportFiles()
    seedFile('hooks.yaml', 'hooks: []\n')
    seedFile('tests/probe.yaml', deviceTest(generateTestId()))
    seedFile('agent-qa.local.yaml', OLDER_INIT_LOCAL_BINDINGS)

    const result = runShipped(['run', 'tests/probe.yaml'])

    expectLocalFileRefusal(result)
    expect(result.combined, `the command's output:\n${result.combined}`).not.toMatch(/Framework error/)
    expect(result.combined, `the command's output:\n${result.combined}`).not.toMatch(/Run ID:/)
    expect(existsSync(join(root, '.agent-qa', 'runs.db'))).toBe(false)
  })

  it('the SHIPPED `agent-qa run --suite` on a device suite refuses before the run is recorded', () => {
    seedConfig(CONFIG_WITH_DEVICE_TARGET)
    seedWorkspaceSupportFiles()
    seedFile('hooks.yaml', 'hooks: []\n')
    const testId = generateTestId()
    seedFile('tests/probe.yaml', deviceTest(testId))
    seedFile(
      'suites/device.suite.yaml',
      `name: device\ntarget: my-app\ntests:\n  - test: tests/probe.yaml\n    id: ${testId}\n`,
    )
    seedFile('agent-qa.local.yaml', OLDER_INIT_LOCAL_BINDINGS)

    const result = runShipped(['run', '--suite', 'suites/device.suite.yaml'])

    expectLocalFileRefusal(result)
    expect(result.combined, `the command's output:\n${result.combined}`).not.toMatch(/Framework error/)
    expect(result.combined, `the command's output:\n${result.combined}`).not.toMatch(/Run ID:/)
    expect(existsSync(join(root, '.agent-qa', 'runs.db'))).toBe(false)
  })
})

describe('the controls: the guard fires on the FAULT, and on nothing else', () => {
  it('a WELL-FORMED config still changes — the guard fired zero times', async () => {
    seedConfig(WELL_FORMED_CONFIG)

    const { answer, error } = await invokeComposed({
      functionId: 'config.field.set',
      payload: { path: 'use.timeout.step', value: '45s' },
    })

    // Named rather than swallowed: a catch that had started eating healthy loads would fail here
    // with the message it failed with.
    expect(error?.message ?? null).toBeNull()
    // A healthy load reaches the direct write, which lands in the call.
    expect((answer as { outcome?: string }).outcome).toBe('applied')
  })

  it('the same fault with NO credential anywhere still reports its position', async () => {
    // No secret beside the fault: a fix keyed on detecting a secret would fail here.
    seedConfig(faultyConfigText({ credential: false }))

    const { error } = await invokeComposed({
      functionId: 'config.field.set',
      payload: { path: 'use.timeout.step', value: '45s' },
    })

    expect(error, 'a secretless parse fault is still a fault').toBeDefined()
    const message = error?.message ?? ''
    expect(message).toMatch(/line \d+, column \d+/)
    expect(message).toContain(CONFIG_FILE)
    // The file's own content stays out of it here too — the line this fixture carries instead of
    // the credential is still the person's text.
    expect(message).not.toContain(ORDINARY_LINE)
  })
})

describe('the shared primitive answers rather than crashes', () => {
  it('a null or primitive throw gets the value-free fallback, and no TypeError', () => {
    // `throw null` is legal, so reading `.linePos` unguarded would crash the reporter.
    expect(yamlParseFailureMessage(null)).toBe('not readable as YAML (position unavailable)')
    expect(yamlParseFailureMessage('boom')).toBe('not readable as YAML (position unavailable)')
    expect(yamlParseFailureMessage(undefined)).toBe('not readable as YAML (position unavailable)')
    expect(yamlParseFailureMessage(7)).toBe('not readable as YAML (position unavailable)')
    // And an object with no position — the shape the fallback exists for — answers the same.
    expect(yamlParseFailureMessage(new Error('a message nobody may publish')))
      .toBe('not readable as YAML (position unavailable)')
  })
})

describe('the ENOENT arms are byte-identical', () => {
  it("a missing file answers the empty object, and the required loader's VERBATIM sentence",
    async () => {
      const missing = join(root, 'nowhere', 'agent-qa.config.yaml')

      expect(await loadConfigFile(missing)).toEqual({})

      // BYTE-EQUAL, not `toContain`, because callers match this sentence. A parse guard written as
      // one broad catch around the whole loader would reword it, and this is the cell that would
      // say so.
      const error = await loadRequiredConfigFile(missing).then(
        () => undefined,
        (err: unknown) => err as Error,
      )
      expect(error?.message).toBe(`Config file not found: ${missing}`)
      // The absent-file error is not the parse class; `showAction` matches it by `instanceof`.
      expect(error?.name).not.toBe('ConfigFileNotYamlError')
      expect(error?.name).toBe('ConfigFileNotFoundError')
    })

  it('a non-ENOENT READ fault is rethrown untouched — the guard is parse-scoped', async () => {
    // A directory where a file should be is EISDIR, a fact about the filesystem and not about any
    // file's content. A catch broad enough to reword it would be reporting a yaml position for a
    // file that was never parsed.
    const asDirectory = join(root, 'is-a-dir.yaml')
    mkdirSync(asDirectory)
    const error = await loadConfigFile(asDirectory).then(
      () => undefined,
      (err: unknown) => err as NodeJS.ErrnoException,
    )
    expect(error?.code).toBe('EISDIR')
    expect(error?.name).not.toBe('ConfigFileNotYamlError')
  })
})

// Config output renders values as written; only a declared secret is masked.

/** The control values: the ordinary things a config carries, none of them credential-shaped. */
const CONTROL_TARGET_NAME = 'my-app-staging'
const CONTROL_BASE_URL = 'https://shop.example.com/checkout'
const CONTROL_PORT = '4173'

/**
 * DERIVED from the shipped-schema-accepted body, for `CONFIG_WITH_DEVICE`'s reason: a second
 * hand-kept config drifts, and then the control is measuring the drift.
 */
const CONTROL_CONFIG = `${WELL_FORMED_CONFIG.replace(
  'registry:\n  llms:',
  `registry:\n  targets:\n    ${CONTROL_TARGET_NAME}:\n      platform: web\n      url: ${CONTROL_BASE_URL}\n  llms:`,
)}
services:
  dashboard:
    port: ${CONTROL_PORT}
`

/** The shipped binary, its WHOLE output, no stream filter and no line filter. */
function runShippedCli(...args: string[]): { status: number | null; combined: string } {
  const run = spawnSync(process.execPath, [CLI_DIST, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
  })
  return { status: run.status, combined: `${run.stdout ?? ''}${run.stderr ?? ''}` }
}

describe("a healthy config's values are shown and written as they are", () => {
  it('an ordinary value still WRITES and still says so — the no-over-redaction control', () => {
    seedConfig(WELL_FORMED_CONFIG)
    seedSecretsFile()

    const { status, combined } = runShippedCli('config', 'set', 'use.timeout.step', '45s')

    const after = readFileSync(configPath, 'utf8')
    expect(combined, `an ordinary set must succeed:\n${combined}`)
      .toContain('use.timeout.step = 45s saved to agent-qa.config.yaml')
    expect(after, `the ordinary value was not written:\n${after}`).toContain('step: 45s')
    expect(status).toBe(0)
  })

  it('base URLs, target names and ports still render VERBATIM at show', () => {
    seedConfig(CONTROL_CONFIG)
    seedSecretsFile()

    const { status, combined } = runShippedCli('config', 'show')

    expect(combined, `the base URL was not shown:\n${combined}`).toContain(CONTROL_BASE_URL)
    expect(combined, `the target name was not shown:\n${combined}`).toContain(CONTROL_TARGET_NAME)
    expect(combined, `the port was not shown:\n${combined}`).toContain(CONTROL_PORT)
    expect(status).toBe(0)
  })
})

// The root `--config <path>` reaches the config verbs; the default file's bytes are hash-compared.

/** A key only the staging config carries — the row that says WHICH file `config show` read. */
const STAGING_ONLY_KEY = 'stagingOnlyMarker'
const STAGING_ONLY_VALUE = 'staging-sentinel-value-395-24'

describe('the config verbs read and write the file --config names', () => {
  it('`--config staging.yaml config set` writes STAGING and leaves the default byte-identical', () => {
    seedConfig(WELL_FORMED_CONFIG)
    seedSecretsFile()
    const stagingPath = join(root, 'staging.yaml')
    writeFileSync(stagingPath, `${WELL_FORMED_CONFIG}${STAGING_ONLY_KEY}: ${STAGING_ONLY_VALUE}\n`)
    const defaultBefore = readFileSync(configPath, 'utf8')

    const { status, combined } = runShippedCli('--config', 'staging.yaml', 'config', 'set', 'version', '9')

    expect(status, `the set must succeed:\n${combined}`).toBe(0)
    // `config set` writes the CLI argument, which is a string, so `yaml` quotes it — matched as the
    // shipped writer actually renders it rather than as this cell would have guessed.
    expect(readFileSync(stagingPath, 'utf8'), 'the file the person named did not receive the value')
      .toMatch(/^version: "?9"?$/m)
    // THE WRONG-FILE CLAUSE. Byte-for-byte, not "does not contain 9" — a write that reformatted the
    // yaml without changing a value is still a write to a file the person steered away from.
    expect(readFileSync(configPath, 'utf8'), 'config set touched the file the person did NOT name')
      .toBe(defaultBefore)
    expect(combined, `the success line named the wrong file:\n${combined}`)
      .toContain('saved to staging.yaml')
    expect(
      occurrences(combined, CONFIG_FILE),
      `config set spoke about a file the person did not ask about:\n${combined}`,
    ).toBe(0)
  })

  it('`--config staging.yaml config show` renders the row only STAGING carries', () => {
    seedConfig(WELL_FORMED_CONFIG)
    seedSecretsFile()
    writeFileSync(
      join(root, 'staging.yaml'),
      `${WELL_FORMED_CONFIG}${STAGING_ONLY_KEY}: ${STAGING_ONLY_VALUE}\n`,
    )

    const { status, combined } = runShippedCli('--config', 'staging.yaml', 'config', 'show')

    expect(status, `config show must stay a success:\n${combined}`).toBe(0)
    expect(combined, `config show read the default file, not the one named:\n${combined}`)
      .toContain(STAGING_ONLY_VALUE)
  })
})

// A missing `--config` path is reported, never crashed on or read as an empty config.

/** A path whose PARENT DIRECTORY does not exist — the person's own typo, rendered as they typed it. */
const UNWRITABLE_CONFIG_PATH = 'sub/staging.yaml'

/** A `--config` value naming a file no project has. */
const ABSENT_CONFIG_PATH = 'nope.yaml'

/** The frame markers Node's default uncaught printer emits and a report never does. */
const NODE_STACK_MARKERS = ['node:internal/', 'at async ', 'Require stack'] as const

function expectNoRawNodeStack(combined: string, what: string): void {
  for (const marker of NODE_STACK_MARKERS) {
    expect(
      occurrences(combined, marker),
      `${what} rendered Node's default printer (\`${marker}\`):\n${combined}`,
    ).toBe(0)
  }
  // A report names the path the person typed and no absolute path of their filesystem.
  expect(combined, `${what} printed the shipped binary's own path:\n${combined}`)
    .not.toContain(CLI_DIST)
  expect(combined, `${what} printed an absolute path the person never typed:\n${combined}`)
    .not.toContain(root)
}

describe('the config verbs report their faults instead of crashing', () => {
  it('`config set` on an unwritable path REPORTS it and leaves the default byte-identical', () => {
    seedConfig(WELL_FORMED_CONFIG)
    const defaultBefore = readFileSync(configPath, 'utf8')

    const { status, combined } = runShippedCli(
      '--config', UNWRITABLE_CONFIG_PATH, 'config', 'set', 'version', '9')

    // THE REPORT, NOT THE CRASH. The exit code alone cannot tell these apart — an uncaught
    // rejection also exits 1 — so the load-bearing assertion is the absence of the printer.
    expect(status, `an unwritable config path is a non-zero exit:\n${combined}`).not.toBe(0)
    expectNoRawNodeStack(combined, '`config set`')
    expect(combined, `the report did not name the path the person typed:\n${combined}`)
      .toContain(UNWRITABLE_CONFIG_PATH)
    // AND NOTHING WAS WRITTEN ANYWHERE. Byte-for-byte on the file the person did NOT name, and the
    // success line must not have been printed for a write that did not happen.
    expect(readFileSync(configPath, 'utf8'), 'a failed write touched the default config')
      .toBe(defaultBefore)
    expect(combined, `a failed write claimed success:\n${combined}`).not.toContain('saved to')
  })

  it("the same verb's READ fault reports too — the sibling one line above the write", () => {
    // THE HALF A GUARD ON THE WRITE ALONE WOULD HAVE LEFT OPEN, measured before it was closed:
    //   $ agent-qa --config adir config set version 9
    //   Error: EISDIR: illegal operation on a directory, read
    //       at async setAction (file:///…/dist/cli.js:18366:21) { errno: -21, code: 'EISDIR', … }
    // Same verb, same function, same printer, one line above the frozen item. `setAction`'s read
    // catch answers ENOENT with a fresh document and rethrew everything else.
    seedConfig(WELL_FORMED_CONFIG)
    mkdirSync(join(root, 'adir'))
    const defaultBefore = readFileSync(configPath, 'utf8')

    const { status, combined } = runShippedCli('--config', 'adir', 'config', 'set', 'version', '9')

    expect(status, `an unreadable config path is a non-zero exit:\n${combined}`).not.toBe(0)
    expectNoRawNodeStack(combined, '`config set` over an unreadable path')
    expect(combined, `the report did not name the path the person typed:\n${combined}`)
      .toContain('adir')
    expect(readFileSync(configPath, 'utf8'), 'a failed read touched the default config')
      .toBe(defaultBefore)
  })

  it('`--config nope.yaml config show` says the file is ABSENT and exits non-zero', () => {
    seedConfig(WELL_FORMED_CONFIG)

    const { status, combined } = runShippedCli('--config', ABSENT_CONFIG_PATH, 'config', 'show')

    expect(status, `a config the person named and does not have is a failure:\n${combined}`).toBe(1)
    expect(combined, `the report did not name the file the person asked about:\n${combined}`)
      .toContain(ABSENT_CONFIG_PATH)
    // THE LIE CLAUSE, AND IT IS THE ONE THAT REDS PRE-FIX. Describing an empty configuration is a
    // read the person will believe they performed.
    expect(
      occurrences(combined, '(no config values)'),
      `config show described an empty config for a file that is not there:\n${combined}`,
    ).toBe(0)
    expect(
      occurrences(combined, 'Resolved Configuration'),
      `config show composed a table for a file that is not there:\n${combined}`,
    ).toBe(0)
    // Nor does it name a file the person did not ask about.
    expect(
      occurrences(combined, CONFIG_FILE),
      `config show named a file the person did not ask about:\n${combined}`,
    ).toBe(0)
    expectNoRawNodeStack(combined, '`config show` over an absent named file')
  })

  it('CONTROL: the UNFLAGGED road in a project with NO config is measured unchanged', () => {
    // No config and no `--config` flag: `config show` prints an empty table and exits 0.
    const { status, combined } = runShippedCli('config', 'show')

    expect(status, `the unflagged zero-config road must stay a success:\n${combined}`).toBe(0)
    expect(combined, `the unflagged road stopped composing its table:\n${combined}`)
      .toContain('Resolved Configuration:')
    expect(combined, `the unflagged road stopped saying it has no values:\n${combined}`)
      .toContain('(no config values)')
    // THE WIDENING CLAUSE. If the refusal leaked onto the default road it would name the default
    // file in a refusal sentence; the table names it nowhere.
    expect(
      occurrences(combined, 'Config file not found'),
      `the explicit-path refusal widened onto the unflagged road:\n${combined}`,
    ).toBe(0)
  })
})

// An array subtree renders one row per member, each value as written.

/** The container fixture's own values — fresh, fixture-owned, never the verifier's own strings. */
const PLANTED_ARRAY_URLINFO = 'sk-ant-api03-395twentythreeURLUSERINFOFIXTUREONLYnotarealkey'
const PLANTED_ARRAY_HEADER = 'sk-ant-api03-395twentythreeHEADERAUTHFIXTUREONLYnotarealkey'

/** Non-credential members: a name and a credential-free URL-shaped field. */
const CONTAINER_LLM_NAME = 'primary-container-fixture'
const CONTAINER_CLEAN_URL = 'https://docs.example.com/models'

/** The exact llms entry `WELL_FORMED_CONFIG` ships, replaced wholesale below. */
const WELL_FORMED_LLM_ENTRY = `    - name: judge
      provider: openai-subscription
      model: gpt-5.6-terra`

/** Values nested inside `registry.llms[]`, derived from `WELL_FORMED_CONFIG`. */
const ARRAY_LEAK_CONFIG = WELL_FORMED_CONFIG.replace(
  WELL_FORMED_LLM_ENTRY,
  `    - name: ${CONTAINER_LLM_NAME}
      provider: openai-compatible
      model: gpt-5.6-terra
      docsUrl: ${CONTAINER_CLEAN_URL}
      baseURL: https://user:${PLANTED_ARRAY_URLINFO}@api.example.com
      providerHeaders:
        X-Client-Auth: ${PLANTED_ARRAY_HEADER}`,
)

describe('credentials nested in an array subtree', () => {
  it('non-credential members of that same array still render VERBATIM', () => {
    expect(ARRAY_LEAK_CONFIG, 'the container fixture must differ from the plain well-formed one')
      .not.toBe(WELL_FORMED_CONFIG)
    seedConfig(ARRAY_LEAK_CONFIG)
    seedSecretsFile()

    const { status, combined } = runShippedCli('config', 'show')

    expect(combined, `the array member's name was not shown:\n${combined}`)
      .toContain(CONTAINER_LLM_NAME)
    expect(combined, `a URL-shaped member was not shown:\n${combined}`)
      .toContain(CONTAINER_CLEAN_URL)
    expect(combined, 'each array member is its own row')
      .toContain('registry.llms[0].providerHeaders.X-Client-Auth')
    expect(status, 'config show must stay a success').toBe(0)
  })
})

// Cycle detection tracks the current path, not every visited node, so a repeated anchor renders.

/** The bounded marker a cyclic position renders as. */
const CIRCULAR_MARKER = '<circular>'

/** An ordinary leaf sharing the cyclic container — the bound on how much the guard may swallow. */
const CYCLE_SIBLING_VALUE = 'cycle-sibling-fixtureonly-395-27'

/**
 * A REAL object cycle after parsing: the anchor is aliased from INSIDE itself.
 *
 * Derived from the shipped-schema-accepted body for `CONTROL_CONFIG`'s reason, and asserted cyclic
 * BY IDENTITY in the cell below before any behavioural claim rests on it.
 */
const CYCLIC_ALIAS_CONFIG = `${WELL_FORMED_CONFIG}
cycleHolder: &loop
  child: *loop
  ordinaryLeaf: ${CYCLE_SIBLING_VALUE}
`

/** The label both copies of the repeated (NON-cyclic) alias must render verbatim. */
const REPEATED_ALIAS_LABEL = 'repeated-alias-fixtureonly-395-27'

/**
 * One anchor, referenced twice as SIBLINGS. Shared object identity, no cycle — the ordinary thing a
 * person uses a YAML anchor for, and the case a visited-set guard destroys.
 */
const REPEATED_ALIAS_CONFIG = `${WELL_FORMED_CONFIG}
sharedBlock: &shared
  label: ${REPEATED_ALIAS_LABEL}
firstUse: *shared
secondUse: *shared
`

describe('a cyclic config is bounded output and a repeated one is not', () => {
  it('an alias CYCLE renders a bounded marker and `config show` completes', () => {
    // THE FIXTURE IS WHAT IT CLAIMS, ASSERTED BY IDENTITY. A fixture that merely LOOKS cyclic would
    // make every assertion below a measurement of nothing.
    const parsed = parseYaml(CYCLIC_ALIAS_CONFIG) as Record<string, Record<string, unknown>>
    expect(parsed.cycleHolder.child, 'the fixture must contain a REAL object cycle')
      .toBe(parsed.cycleHolder)

    // AND THE MERGE ABOVE THE FLATTEN IS MEASURED, NOT ASSUMED SAFE. The frozen item is "`config
    // show` crashes", not "`flattenObject` recurses": if `deepMerge` were where the cyclic input
    // actually died, a guard in the flatten would close nothing. It survives because `deepMerge`
    // recurses on the keys of the OVERRIDE, and the show road's overrides are empty — its depth is
    // bounded by the override's depth and never by the base's.
    const merged = mergeConfigs(parsed, {}, {})
    expect((merged as Record<string, Record<string, unknown>>).cycleHolder.child,
      'the merge must preserve the cycle rather than dying on it or flattening it away')
      .toBe((merged as Record<string, Record<string, unknown>>).cycleHolder)
    expect(mergeWithTestConfig(parsed, {}, {}), 'the show road\'s own merge must complete')
      .toBeTypeOf('object')

    seedConfig(CYCLIC_ALIAS_CONFIG)
    seedSecretsFile()
    const cyclic = runShippedCli('config', 'show')

    // THE CRASH IS GONE, ASSERTED AT THE SURFACE A PERSON READS.
    expect(
      occurrences(cyclic.combined, 'RangeError'),
      `config show still crashes on an alias cycle:\n${cyclic.combined}`,
    ).toBe(0)
    expect(
      occurrences(cyclic.combined, 'at flattenObject'),
      `Node's default printer rendered the recursion:\n${cyclic.combined}`,
    ).toBe(0)
    expectNoRawNodeStack(cyclic.combined, '`config show` over a cyclic config')

    // AND IT IS STILL THE COMMAND IT WAS: a table, at the status the healthy road produces.
    expect(cyclic.combined, `config show printed no table:\n${cyclic.combined}`)
      .toContain('Resolved Configuration:')
    expect(
      cyclic.combined,
      `the cyclic position did not render a bounded marker:\n${cyclic.combined}`,
    ).toContain(CIRCULAR_MARKER)
    expect(cyclic.combined, `the cyclic key lost its row:\n${cyclic.combined}`)
      .toContain('cycleHolder.child')
    // THE BOUND IS ON HOW MUCH THE GUARD SWALLOWS, TOO. An ordinary leaf sharing the cyclic
    // container is not part of the cycle and still renders.
    expect(cyclic.combined, `the guard blanked a non-cyclic sibling:\n${cyclic.combined}`)
      .toContain(CYCLE_SIBLING_VALUE)
    // BOUNDED OUTPUT, MEASURED. The pre-fix reading was a ~10,000-frame stack; a guard that
    // recursed "a bit less" rather than stopping would pass every assertion above.
    expect(
      cyclic.combined.length,
      `config show produced unbounded output (${cyclic.combined.length} bytes)`,
    ).toBeLessThan(8_000)

    // EXIT PARITY WITH THE HEALTHY ROAD, MEASURED RATHER THAN ASSUMED.
    seedConfig(WELL_FORMED_CONFIG)
    const healthy = runShippedCli('config', 'show')
    expect(cyclic.status, `the cyclic road must exit as the healthy one does:\n${cyclic.combined}`)
      .toBe(healthy.status)
    expect(healthy.status, 'the measured healthy status').toBe(0)
  })

  it('CONTROL: a REPEATED alias is not a cycle — both copies render VERBATIM', () => {
    // THE FIXTURE IS SHARED AND NOT CYCLIC, BOTH ASSERTED BY IDENTITY. Shared identity is what
    // makes a visited-set guard fire here; the absence of a cycle is what makes firing WRONG.
    const parsed = parseYaml(REPEATED_ALIAS_CONFIG) as Record<string, Record<string, unknown>>
    expect(parsed.firstUse, 'both uses must be the SAME object — that is what an alias is')
      .toBe(parsed.secondUse)
    expect(parsed.sharedBlock, 'and the same object as the anchor').toBe(parsed.firstUse)
    expect(parsed.sharedBlock.label, 'and it must be an ordinary leaf, not a cycle')
      .toBe(REPEATED_ALIAS_LABEL)

    seedConfig(REPEATED_ALIAS_CONFIG)
    seedSecretsFile()
    const { status, combined } = runShippedCli('config', 'show')

    // THREE ROWS, THREE COPIES OF THE VALUE. Under a visited-set guard this counts 1 and the two
    // aliased copies come back as markers — a subtree blanked that was never cyclic.
    expect(
      occurrences(combined, REPEATED_ALIAS_LABEL),
      `a repeated (non-cyclic) alias lost a copy — the guard is visited-scoped, not path-scoped:\n${combined}`,
    ).toBe(3)
    expect(combined, 'the anchor row').toContain('sharedBlock.label')
    expect(combined, 'the first alias row').toContain('firstUse.label')
    expect(combined, 'the second alias row').toContain('secondUse.label')
    expect(
      occurrences(combined, CIRCULAR_MARKER),
      `nothing here is circular and the guard said otherwise:\n${combined}`,
    ).toBe(0)
    expect(status, `a repeated alias is an ordinary healthy config:\n${combined}`).toBe(0)
  })
})
