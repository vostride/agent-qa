// A committed config the yaml parser cannot read, on every road that loads it (395-14 · F-01).
//
// THE DEFECT THIS FILE IS THE ACCEPTANCE FOR. `loadConfigFile`/`loadRequiredConfigFile` hand
// `parseYaml` the person's committed bytes and let its throw out uncaught. The vendored `yaml`
// package pretty-prints a `YAMLParseError` with a VERBATIM EXCERPT of the source around the point
// the parser gave up — for a duplicate top-level key that excerpt is the line before it, whatever
// that line happens to hold. Measured with a planted `sk-ant-`-shaped credential on that line, the
// excerpt reached `config.field.set`, `config.target.create` and `config.project.scaffold`; through
// `refusalMessage` (turn-engine.ts:290-292, which returns an `Error`'s `.message` verbatim) it
// reaches a chat turn's answer and the persisted session jsonl; and `agent-qa validate` printed the
// identical string through a SIBLING site, core `validateConfig`'s `YAML syntax error:`
// interpolation.
//
// THE CLOSURE IS 395-10's, ONE LAYER OUT: POSITION, NEVER CONTENT. Both sources compose their
// sentence from `yamlParseFailureMessage` — two numbers off the error and nothing else — so no road
// that loads a config can quote a byte of it.
//
// THE FIXTURE IS PRODUCED, NEVER A LITERAL. A real temp git repository, the config WRITTEN and
// COMMITTED, exactly the file a person would have in their tree. A type literal handed to a port
// would pin an input the loader never sees, and this defect lives in the loader.
//
// WHAT MAKES EACH CELL RED:
//
//  (F1) config.field.set         — the loader rethrowing the parse error, or wording its own
//                                  message out of the caught error's text.
//  (F2) config.target.create     — the same guard reached through a second op. A fix placed in one
//                                  op's handler rather than in the loader reds here.
//  (F3) config.project.scaffold  — and through a third, which reads the committed set from zero.
//  (F4) agent-qa validate        — core `validateConfig`'s own arm. This is a SIBLING SITE, not a
//                                  caller of the cli loader: a one-sided fix that hardened the
//                                  loader alone leaves this road printing the excerpt (388/390/392
//                                  — one-sided hardening is a regression generator).
//  (F5) the chat answer          — the equivalence the chat road rests on: the captured rejection
//                                  is an `Error` with a non-empty message, so `refusalMessage`
//                                  RETURNS THAT MESSAGE. The string asserted here is the string a
//                                  turn's answer and its session jsonl carry.
//  (F6) control, non-firing      — a WELL-FORMED config in the same harness still proposes. The
//                                  guard fired zero times; a catch that swallowed healthy loads
//                                  reds here.
//  (F7) control, secretless      — the same fault with NO credential anywhere still reports its
//                                  position. The guard's subject is the FAULT, not the secret, so a
//                                  fix keyed on detecting a secret reds here.
//  (W1) WR-08                    — `yamlParseFailureMessage` handed `null` and a bare string. The
//                                  395-10 copy read `.linePos` off the argument unguarded and
//                                  TypeError'd on `null`.
//  (E1) the ENOENT byte-pins     — `loadConfigFile` answers `{}` and `loadRequiredConfigFile` says
//                                  `Config file not found: <path>` VERBATIM. That exact string is
//                                  matched by the live lane's third-arm detection
//                                  (`scripts/395-live-from-zero.sh:514`) and folded by
//                                  `coveringGrantInForce`; a parse guard written as one broad catch
//                                  around the whole loader would reword it and red here.

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

/**
 * The SHIPPED binary, resolved from this file's own location (395-16 · CR-01 / S2).
 *
 * `packages/cli/src/composition/__tests__` → three levels up is `packages/cli`. The cell below
 * drives `dist/cli.js` and not the source, because the crash this measures happens in the process a
 * person actually runs — and because a reading taken on a STALE dist measures the previous build.
 * The plan's verify line rebuilds core then cli before every run of this file for exactly that
 * reason.
 */
const CLI_DIST = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'dist', 'cli.js')

let root: string
let configPath: string
let agentQaRoot: string

function git(...args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) {
    // 395-24 · WR-12 — a `git` that ran and failed must not return quietly; see
    // validate-resolution-surface.test.ts for the full note.
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
/**
 * A configuration the shipped schema accepts WHOLE — the non-firing control's input, and the body
 * the faulty fixture is built from.
 *
 * COMPLETE ON PURPOSE. `config.field.set` validates the whole candidate (CFGM-01), so a config
 * missing `workspace.envFile` blocks with `schema-fail` and the control cell would be measuring the
 * validator rather than the loader guard it is the control for.
 */
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

// 2026-10-15 (441-20): `config show` refuses at start without the declared secrets file.
function seedSecretsFile(): void {
  writeFileSync(join(root, '.env.secrets.local'), '')
}

/**
 * The OTHER members of the file set `enumerateConfigFileSet` pins (395-16 · CR-02 / WINDOWS 139).
 *
 * ONE VALUE PER MEMBER, ON PURPOSE. Three distinct planted strings, so a cell that reads the whole
 * rendered output can say WHICH member leaked rather than only that something did — cross-member
 * misattribution is visible instead of averaged away. This project's recurring failure mode is a
 * guard hardened on one member of a set while its sibling leaks (388/390/392); the fixtures below
 * exist so the set is measured as a set.
 */
const PLANTED_HOOKS_CREDENTIAL = 'sk-ant-api03-395sixteenHOOKSFIXTUREONLYnotarealkey'
const PLANTED_SUITE_CREDENTIAL = 'sk-ant-api03-395sixteenSUITEFIXTUREONLYnotarealkey'

/**
 * The FOURTH member's own value (395-18 · F-01-R3a).
 *
 * A plain test yaml — the `else` arm of the `isSuiteFile` branch at `validate.ts:341-345` whose
 * `if` arm 395-16 hardened. Distinct from the three above for the same reason they are distinct
 * from each other: when a whole-output cell reds, the value says WHICH member leaked. `.suite.yaml`
 * is an extension, not a property of what a file contains, and it was the only thing separating a
 * hardened member from a leaking one.
 */
const PLANTED_TEST_CREDENTIAL = 'sk-ant-api03-395eighteenTESTFIXTUREONLYnotarealkey'

/** The fifth: `agent-qa.local.yaml`, the file `loadLocalBindings` reads (395-18 · V4). */
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

/**
 * `WELL_FORMED_CONFIG` with a device registered, so `agent-qa devices list` gets past
 * `registry.devices` and reaches `loadLocalBindings` — the road (V4) measures.
 *
 * DERIVED from the shipped-schema-accepted body rather than written beside it: a second hand-kept
 * config is a second thing that can drift out of what the schema accepts, and then the control it
 * feeds would be measuring the validator.
 */
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

describe('a committed config the parser cannot read names WHERE, never WHAT (395-14 · F-01)', () => {
  it('(F1) config.field.set faults with the position and none of the file\'s content', async () => {
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

  it('(F2) config.target.create faults the same way — the guard is in the LOADER', async () => {
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

  it('(F3) config.project.scaffold faults the same way — the third op, from zero', async () => {
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

  it('(F4) agent-qa validate reports the same fault position-only — the SIBLING site', async () => {
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

  it('(F5) the chat answer carries EXACTLY this string — refusalMessage returns .message',
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

// THE SURFACE THE ROUND-2 CORPUS COULD NOT SEE (395-16 · RULING 1 / CR-01).
//
// Every cell above reads `error.message`. The channel that survived them reads the error as a
// VALUE: `util.inspect` walks the `cause` chain, and Node's default uncaught printer is a
// util.inspect call — so `agent-qa config show`, which awaited the loader bare, crash-printed the
// person's file back at them while ten cells stayed green. The two cells here change the assertion
// SURFACE rather than the case count: the serialization as a printer reads it, and the shipped
// binary's entire stdout+stderr.
describe('the loader\'s error is clean as a VALUE, and the shipped command reports it (395-16)', () => {
  it('(S1) the rejection serializes position-only — util.inspect and .stack, not just .message',
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

      // The `.message` surface the round-2 corpus asserted on is unchanged, and still position-only.
      expectPositionOnly(error?.message ?? '')
      expect(error?.message).toContain(CONFIG_FILE)
    })

  it('(S2) the SHIPPED `agent-qa config show` reports the position and never crash-prints the file',
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

// THE FILE SET, MEASURED AS A SET (395-16 · RULING 1 / CR-02 · WINDOWS 139).
//
// `enumerateConfigFileSet` pins a SET: the config yaml, the hooks file, and the suite files beside
// them. 395-14 hardened ONE member and left its siblings interpolating the library's pretty excerpt
// — this project's documented recurring failure mode, and invisible to cell (F4) because (F4)
// filters diagnostics to `d.file === configPath`. Every cell here asserts over the WHOLE rendered
// `formatDiagnostics` output with NO per-file filter, which is the string the command writes to
// stdout and the surface a person reads.
describe('every member of the config file set reports position-only (395-16)', () => {
  it('(H1) a hooks.yaml the parser cannot read renders position-only in the WHOLE output',
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

  it('(H2) BOTH members poisoned at once — one whole-surface assertion over the set', async () => {
    // THE SHAPE (F4)'s FILTER MADE IMPOSSIBLE. One rendering, every member's diagnostics in it, and
    // one assertion per planted value. A guard that covers the member it was written for and misses
    // the one beside it cannot pass this cell by being filtered out of view.
    //
    // `hooksFile` is passed EXPLICITLY here, and that is a finding rather than a convenience: when
    // the config itself is unreadable the command's `resolveConfig` throws, `workspace` stays
    // undefined, and `validateProject` never reaches the hooks member at all. Driving the set as a
    // set therefore needs the member named, or the cell would be green on a leak it never provoked.
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

    // DE-VACUIZED (395-18 · WR-01). The clauses above are all satisfiable by ONE member: two
    // zero-counts are trivially true of a member that produced no diagnostic at all, and the single
    // position regex is satisfied by whichever sibling did produce one. The verifier measured
    // exactly that — disabling the hooks member's diagnostic production entirely left this cell
    // GREEN while the member it exists to measure was never reached. So the set is now asserted AS
    // a set: both members named in the rendering, and the position sentence counted, once per
    // member. A member whose diagnostic production regresses to nothing reds here.
    expect(rendered, `the rendered validate output:\n${rendered}`).toMatch(/agent-qa\.config\.yaml/)
    expect(rendered, `the rendered validate output:\n${rendered}`).toMatch(/hooks\.yaml/)
    expect(
      rendered.match(/not readable as YAML at line \d+, column \d+/g)?.length ?? 0,
      `the set is two members, so the rendering carries two position sentences:\n${rendered}`,
    ).toBe(2)
  })

  it('(SU1) a suite file the parser cannot read renders position-only — the third member',
    async () => {
      // WINDOWS 139, driven on the road `agent-qa validate` walks: the suite file is DISCOVERED
      // through the workspace's own suiteMatch glob, not handed in as a path.
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

// THE FOURTH MEMBER — the `else` arm of the branch round 3 hardened (395-18 · F-01-R3a).
//
// `validateFiles` branches on `isSuiteFile` (`core/src/validation/validate.ts:341-345`). Round 3
// hardened the `if` arm — (SU1) above is its cell — and left the `else` arm: every non-suite test
// yaml, running `validateTestFile` -> `parseTestFile` (`prettyErrors: true`) -> `formatYamlError`,
// whose body was `message: err.message`, the yaml library's pretty print with the verbatim source
// excerpt and caret. The verifier reproduced this on the shipped binary while the SAME dist
// rendered a `.suite.yaml` twin position-only in the same run.
//
// `formatYamlError` speaks on TWO channels and only one of them is the message: `ParseError.source`
// is a straight copy of the person's own line, printed by `run.ts:599-613` and persisted into the
// dashboard DB at `run.ts:2676`. A store is a surface with a delay, so the message fix alone does
// not hold on the `run` road — hence two cells, one per channel.
describe('the plain-test member reports position-only on BOTH channels (395-18)', () => {
  it('(V1) the SHIPPED `agent-qa validate` renders a plain test yaml position-only', () => {
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

  it('(V2) the producer\'s own ParseError is position-only in message AND in source', () => {
    // THE SECOND CHANNEL, PINNED AT ITS SOURCE. `ParseError.source` never reaches the `validate`
    // road (`validateTestFile` maps only file/line/column/message/severity), so (V1) cannot see it.
    // It reaches the `run` road's printer and the dashboard DB, which is why it is asserted on the
    // value the producer returns rather than on any one consumer's rendering.
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

// THE REST OF THE CLASS, FOUND BY ENUMERATION RATHER THAN BY THE NEXT VERIFIER (395-18 · Task 2).
//
// Task 2's mechanical sweep of every yaml-parse call site in `packages/*/src` turned up three more
// members of the identical mechanism, two of them reproduced on the shipped binary before a line
// was changed. 2026-10-19 (445-09, D-37): the third, the hook-reference migration audit, was
// deleted with its cell. They are here rather than in a deferral row because they are `agent-qa`'s
// own person-visible roads, which is the boundary the plan draws: dashboard surfaces defer (WINDOWS
// 140), CLI and core surfaces get fixed in the pass that finds them.
describe('the other person-visible yaml-parse roads report position-only (395-18)', () => {
  it('(V3) the SHIPPED `agent-qa run --suite` never quotes the suite file back', () => {
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

  it('(V4) the SHIPPED `agent-qa devices list` never crash-prints agent-qa.local.yaml', () => {
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

describe('the controls: the guard fires on the FAULT, and on nothing else (395-14)', () => {
  it('(F6) a WELL-FORMED config still changes — the guard fired zero times', async () => {
    seedConfig(WELL_FORMED_CONFIG)

    const { answer, error } = await invokeComposed({
      functionId: 'config.field.set',
      payload: { path: 'use.timeout.step', value: '45s' },
    })

    // Named rather than swallowed: a catch that had started eating healthy loads would fail here
    // with the message it failed with.
    expect(error?.message ?? null).toBeNull()
    // 432-11 D-05: a healthy load reaches the direct write, which lands in the call.
    expect((answer as { outcome?: string }).outcome).toBe('applied')
  })

  it('(F7) the same fault with NO credential anywhere still reports its position', async () => {
    // THE PRECONDITION-GUARDED CORPUS LAW. Every other road cell is drawn from inside the rule's
    // own assumption — a fault WITH a secret beside it. A fix keyed on detecting a secret rather
    // than on the fault would pass all of them and red here, and a fallback that hid the fault
    // entirely (T-395-42) would red here too.
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

describe('the shared primitive answers rather than crashes (395-14 · WR-08 / F-09)', () => {
  it('(W1) a null or primitive throw gets the value-free fallback, and no TypeError', () => {
    // THE 395-10 COPY READ `.linePos` OFF THE ARGUMENT UNGUARDED. `throw null` is a legal throw, and
    // `null.linePos` is a TypeError raised inside the code whose entire job is to turn a fault into
    // a sentence — the fault would be replaced by a crash in the reporter.
    expect(yamlParseFailureMessage(null)).toBe('not readable as YAML (position unavailable)')
    expect(yamlParseFailureMessage('boom')).toBe('not readable as YAML (position unavailable)')
    expect(yamlParseFailureMessage(undefined)).toBe('not readable as YAML (position unavailable)')
    expect(yamlParseFailureMessage(7)).toBe('not readable as YAML (position unavailable)')
    // And an object with no position — the shape the fallback exists for — answers the same.
    expect(yamlParseFailureMessage(new Error('a message nobody may publish')))
      .toBe('not readable as YAML (position unavailable)')
  })
})

describe('the ENOENT arms are byte-identical (395-14 · T-395-41)', () => {
  it('(E1) a missing file answers the empty object, and the required loader\'s VERBATIM sentence',
    async () => {
      const missing = join(root, 'nowhere', 'agent-qa.config.yaml')

      expect(await loadConfigFile(missing)).toEqual({})

      // BYTE-EQUAL, not `toContain`. `scripts/395-live-from-zero.sh:514` matches this sentence to
      // decide whether SC-5's third arm has reopened, and `coveringGrantInForce`'s fold is
      // documented against it. A parse guard written as one broad catch around the whole loader
      // would reword it, and this is the cell that would say so.
      const error = await loadRequiredConfigFile(missing).then(
        () => undefined,
        (err: unknown) => err as Error,
      )
      expect(error?.message).toBe(`Config file not found: ${missing}`)
      // THE CLASS IS NOT THE PARSE CLASS — the fact this line has asserted all along, now stated
      // directly instead of through a proxy. It read `toBe('Error')` because the throw was a bare
      // `Error`; 395-27 · WR-02 gave the absent-file case its own name so `showAction` can
      // recognise it by `instanceof` rather than by matching THIS VERY SENTENCE, which is the
      // reasoning `ConfigFileNotYamlError`'s own doc block already wrote down. The byte-pin above
      // is what the live lane matches and it is unchanged; only the class name moved.
      expect(error?.name).not.toBe('ConfigFileNotYamlError')
      expect(error?.name).toBe('ConfigFileNotFoundError')
    })

  it('(E1b) a non-ENOENT READ fault is rethrown untouched — the guard is parse-scoped', async () => {
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

// A HEALTHY CONFIG ON THE TWO SHIPPED CONFIG VERBS (395-20 · F-03). Since 441-20 (D-29) config
// output has no masks of its own: values render and write as the person wrote them, and only a
// declared secret is masked (C441-CONFIG in `__tests__/config.test.ts`).

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

describe('a healthy config\'s values are shown and written as they are (395-20 · F-03)', () => {
  it('(K4a) an ordinary value still WRITES and still says so — the no-over-redaction control', () => {
    seedConfig(WELL_FORMED_CONFIG)
    seedSecretsFile()

    const { status, combined } = runShippedCli('config', 'set', 'use.timeout.step', '45s')

    const after = readFileSync(configPath, 'utf8')
    expect(combined, `an ordinary set must succeed:\n${combined}`)
      .toContain('use.timeout.step = 45s saved to agent-qa.config.yaml')
    expect(after, `the ordinary value was not written:\n${after}`).toContain('step: 45s')
    expect(status).toBe(0)
  })

  it('(K4b) base URLs, target names and ports still render VERBATIM at show', () => {
    seedConfig(CONTROL_CONFIG)
    seedSecretsFile()

    const { status, combined } = runShippedCli('config', 'show')

    expect(combined, `the base URL was not shown:\n${combined}`).toContain(CONTROL_BASE_URL)
    expect(combined, `the target name was not shown:\n${combined}`).toContain(CONTROL_TARGET_NAME)
    expect(combined, `the port was not shown:\n${combined}`).toContain(CONTROL_PORT)
    expect(status).toBe(0)
  })
})

// THE FLAG THE PERSON TYPED, ON THE CONFIG VERBS (395-24 · WR-03).
//
// `setAction` hardcoded `const configPath = 'agent-qa.config.yaml'` and `showAction` hardcoded the
// same string into its `loadConfigFile` call, while the ROOT program has carried a `--config <path>`
// option all along. The measured consequence is the worst shape a config bug takes: a SILENT WRONG-FILE
// WRITE. `agent-qa --config staging.yaml config set version 9` reported
// `✓ version = 9 saved to agent-qa.config.yaml` and modified the file the person was explicitly
// steering away from, while `staging.yaml` stayed untouched. Nothing in the output said so.
//
// (W3) drives both halves on the shipped binary, and the load-bearing assertion is the NEGATIVE one:
// the default config's bytes are hash-compared before and after. A cell that only checked
// "staging.yaml got the value" would pass on an implementation that wrote BOTH.

/** A key only the staging config carries — the row that says WHICH file `config show` read. */
const STAGING_ONLY_KEY = 'stagingOnlyMarker'
const STAGING_ONLY_VALUE = 'staging-sentinel-value-395-24'

describe('the config verbs read and write the file --config names (395-24 · WR-03)', () => {
  it('(W3) `--config staging.yaml config set` writes STAGING and leaves the default byte-identical', () => {
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

  it('(W3-show) `--config staging.yaml config show` renders the row only STAGING carries', () => {
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

// BOTH SIDES OF THE CONFIG VERB PAIR REPORT THEIR FAULTS (395-27 · WR-01 / WR-02).
//
// WHAT 395-24 MINTED AND THIS CLOSES. Once `--config <path>` reached these verbs the path became
// PERSON-SUPPLIED, and neither verb was ready for a path that does not resolve:
//
//   $ agent-qa --config sub/staging.yaml config set version 9
//   node:internal/fs/promises:642
//   Error: ENOENT: no such file or directory, open 'sub/staging.yaml'
//       at async setAction (file:///…/packages/cli/dist/cli.js:18376:3) { errno: -2, … }
//
// That is Node's DEFAULT UNCAUGHT PRINTER — the printer 395-16 exists to keep config content away
// from — reached by the ordinary road of typing a path with a typo in it. `showAction` was given
// the report-not-crash guard in 395-16 (*"THE OP REPORTS, IT DOES NOT CRASH"*); its sibling one
// function above was not. Fifth filing of the one-sided-hardening shape in this arc.
//
// AND THE READ SIDE LIES RATHER THAN CRASHING. `showAction` calls `loadConfigFile`, which swallows
// ENOENT and answers `{}`, so `agent-qa --config nope.yaml config show` printed
// `(no config values)` and exited 0: the person named a file, and the command described nothing at
// all as though it had read it. `validate` was given the opposite (correct) posture in the same
// round — `(W2)` in validate-resolution-surface.test.ts pins a non-zero exit naming the file — so
// the two verbs disagreeing about the same missing file IS the bug.
//
// WHAT MAKES EACH CELL RED:
//
//  (W8)         — the write guard removed. The uncaught rejection returns and the stack-frame
//                 assertions count above 0. Leg M-W1.
//  (W8-read)    — the READ's non-ENOENT rethrow one line above the write. `--config <a directory>`
//                 crashed identically, on the same verb, in the same function: guarding the write
//                 alone would have been the SIXTH filing of the shape this plan exists to close.
//  (W9)         — the explicit-path refusal removed. `config show` describes an empty config for a
//                 file that is not there. Leg M-W2.
//  (W9-control) — THE SCOPE BOUNDARY, MEASURED RATHER THAN DECLARED. A project with genuinely no
//                 config and no `--config` flag is not being lied to, and widening the refusal
//                 there would change behaviour in every zero-config project and in the live lane.
//                 Its reading was taken on the pre-change tree and is asserted here verbatim, so
//                 "unchanged" is a comparison. It stays GREEN under leg M-W2 — that is what proves
//                 the two roads are DISTINGUISHED rather than both refused.
//
// RECORDED AND DELIBERATELY NOT ACTED ON: on the unflagged road `validate` refuses (it reaches
// `loadRequiredConfigFile` through `resolveConfig`) while `config show` reports an empty table at
// exit 0. The two verbs stay different there on purpose — `validate`'s whole job is to answer
// whether a config resolves, and `config show`'s is to say which keys resolve from where, which is
// a truthful (if short) answer in a project that declares none. Stated here so a later round does
// not discover it as news.

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
  // AND NO ABSOLUTE PATH OUT OF THE PERSON'S FILESYSTEM. The raw error carried
  // `file:///…/packages/cli/dist/cli.js` and the temp root; a report names the path the person
  // TYPED and nothing else (WR-07's discipline).
  expect(combined, `${what} printed the shipped binary's own path:\n${combined}`)
    .not.toContain(CLI_DIST)
  expect(combined, `${what} printed an absolute path the person never typed:\n${combined}`)
    .not.toContain(root)
}

describe('the config verbs report their faults instead of crashing (395-27 · WR-01/WR-02)', () => {
  it('(W8) `config set` on an unwritable path REPORTS it and leaves the default byte-identical', () => {
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

  it('(W8-read) the same verb\'s READ fault reports too — the sibling one line above the write', () => {
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

  it('(W9) `--config nope.yaml config show` says the file is ABSENT and exits non-zero', () => {
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
    // AND IT DOES NOT SPEAK ABOUT A FILE THE PERSON DID NOT ASK ABOUT — (W2)'s naming discipline,
    // applied to this verb's twin of the same fault.
    expect(
      occurrences(combined, CONFIG_FILE),
      `config show named a file the person did not ask about:\n${combined}`,
    ).toBe(0)
    expectNoRawNodeStack(combined, '`config show` over an absent named file')
  })

  it('(W9-control) the UNFLAGGED road in a project with NO config is measured unchanged', () => {
    // THE PRE-CHANGE READING, TAKEN ON THE TREE AS 395-26 LEFT IT AND ASSERTED VERBATIM:
    //   exit 0, stdout "\nResolved Configuration:\n\n  (no config values)\n\n"
    // No `seedConfig` — this project genuinely declares no configuration, which is the state the
    // new refusal must REJECT (384 · round 4: a guard needs a case it does not fire on, or every
    // cell around it is drawn from inside the guard's own assumption).
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

// AN ARRAY SUBTREE RENDERS ONE ROW PER MEMBER (395-23 · F-03-R4a), each value as written.

/** The container fixture's own values — fresh, fixture-owned, never the verifier's own strings. */
const PLANTED_ARRAY_URLINFO = 'sk-ant-api03-395twentythreeURLUSERINFOFIXTUREONLYnotarealkey'
const PLANTED_ARRAY_HEADER = 'sk-ant-api03-395twentythreeHEADERAUTHFIXTUREONLYnotarealkey'

/** The non-credential members (K6) pins: a name and a credential-free URL-shaped field. */
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

describe('credentials nested in an array subtree (395-23 · F-03-R4a)', () => {
  it('(K6) non-credential members of that same array still render VERBATIM', () => {
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

// A YAML ALIAS CYCLE IS BOUNDED OUTPUT, NOT A CRASH (395-27 · WR-03).
//
// WHAT THE REVIEWER MEASURED ON THE SHIPPED BINARY, with `cycle: &anchor\n  child: *anchor`:
//
//   file:///…/packages/cli/dist/cli.js:193
//     for (const [key, value] of Object.entries(obj)) {
//   RangeError: Maximum call stack size exceeded
//       at flattenObject (file:///…/packages/cli/dist/cli.js:193:37)
//       at flattenObject (file:///…/packages/cli/dist/cli.js:194:27)
//       … ~10k frames …
//   Node.js v24.10.0
//
// `flattenObject` has no cycle guard, `showAction`'s `try` wraps only the load, and the `RangeError`
// therefore escapes into Node's DEFAULT PRINTER — the printer 395-16 exists to keep config content
// away from. The object arm always had this exposure; 395-23's array arm widened the input class
// that reaches it, so an alias cycle through a `registry.llms[]` element gets there too.
//
// AND THE OBVIOUS FIX IS THE WRONG ONE. A `WeakSet` of every container ever VISITED — the shape the
// review itself suggested — cannot tell a cycle from a REPEAT. One anchor referenced twice as
// siblings is an ordinary config a person writes on purpose (it is what YAML anchors are FOR), and
// a visited-set marks the second copy circular and blanks a subtree that was never cyclic. The
// guard is therefore scoped to the CURRENT PATH — the chain of ancestors of the node being
// flattened, released as the recursion unwinds.
//
// WHAT MAKES EACH CELL RED:
//
//  (W10)         — the guard removed: the RangeError returns and the stack markers count above 0.
//  (W10-control) — THE DISCRIMINATION CONTROL, and the reason this task is not a one-liner. It
//                  REDS under the visited-set implementation (leg M-W3) while (W10) stays green,
//                  which is what makes "path-scoped, not visited-scoped" a measurement instead of
//                  a sentence in a comment.

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

describe('a cyclic config is bounded output and a repeated one is not (395-27 · WR-03)', () => {
  it('(W10) an alias CYCLE renders a bounded marker and `config show` completes', () => {
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

  it('(W10-control) a REPEATED alias is not a cycle — both copies render VERBATIM', () => {
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
