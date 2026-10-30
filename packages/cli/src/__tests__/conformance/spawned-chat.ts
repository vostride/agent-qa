// The one spawned-binary instrument; its freshness guard refuses a missing or stale `dist` by name.

import { spawn } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { generateSuiteId, generateTestId } from '@vostride/agent-qa-ids'

import { removeTempRoots } from '../temp-roots.js'

/** This directory. */
export const CONFORMANCE_DIR = dirname(fileURLToPath(import.meta.url))
/** `packages/cli`. */
export const CLI_PACKAGE_ROOT = resolve(CONFORMANCE_DIR, '..', '..', '..')
/** `packages`. */
export const PACKAGES_ROOT = resolve(CLI_PACKAGE_ROOT, '..')
/** The built entry a spawned cell actually executes — the thing a person installs. */
export const CLI_ENTRY = join(CLI_PACKAGE_ROOT, 'dist', 'cli.js')

export const REBUILD_INSTRUCTION =
  'the built artifacts these anchors measure are missing or older than their sources; run '
  + '`pnpm build` at the repository root before running this file (see its header). An anchor '
  + 'spawned against a stale build certifies the PREVIOUS revision while reading as proof of this '
  + 'one.'

// ---- The stale-dist guard ----------------------------------------------------------------------

/**
 * The built artifacts the spawned halves of these cells actually execute.
 *
 * `cli` is bundled from its own source; the other four arrive as their own dists because tsup leaves
 * workspace dependencies external. All five are listed because the enumeration a spawned binary
 * answers with is composed out of all five, and a guard that watched only the entry point would be
 * green while the registry the entry point lists was a revision behind.
 */
export const ANCHORED_BUILDS: readonly { readonly pkg: string; readonly artifact: string }[] =
  Object.freeze([
    Object.freeze({ pkg: 'schema', artifact: join('dist', 'index.js') }),
    Object.freeze({ pkg: 'agent', artifact: join('dist', 'index.js') }),
    Object.freeze({ pkg: 'agent-local', artifact: join('dist', 'index.js') }),
    Object.freeze({ pkg: 'mcp', artifact: join('dist', 'index.js') }),
    Object.freeze({ pkg: 'cli', artifact: join('dist', 'cli.js') }),
    // The bin entry only loads this bundle, which holds the CLI.
    Object.freeze({ pkg: 'cli', artifact: join('dist', 'cli-main.js') }),
  ])

/** What a freshness reading found, as data — so a refusal names files rather than a boolean. */
export interface BuildFreshness {
  /** Packages whose built artifact does not exist at all. */
  readonly missing: readonly string[]
  /** Packages whose newest product source is newer than the artifact built from it. */
  readonly stale: readonly string[]
}

/**
 * The newest PRODUCT source under a directory, walked rather than globbed.
 *
 * Test sources are skipped for the reason in this file's header. Everything else under `src` counts,
 * including files a bundler may have tree-shaken away: a guard that tried to model the bundler's
 * reachability would be a second, quieter copy of the build.
 */
function newestProductSource(dir: string): { path: string; mtimeMs: number } | undefined {
  let newest: { path: string; mtimeMs: number } | undefined
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue
      const full = join(current, entry.name)
      if (entry.isDirectory()) {
        walk(full)
        continue
      }
      if (!entry.isFile()) continue
      if (!/\.(?:ts|tsx|mts|cts|js|mjs|cjs|json|css|html)$/u.test(entry.name)) continue
      if (/\.test(?:-d)?\.[cm]?tsx?$/u.test(entry.name)) continue
      const { mtimeMs } = statSync(full)
      if (newest === undefined || mtimeMs > newest.mtimeMs) newest = { path: full, mtimeMs }
    }
  }
  walk(dir)
  return newest
}

/**
 * Whether every artifact these anchors execute exists and post-dates the source it was built from.
 *
 * RETURNED AS DATA rather than thrown or asserted here, so the cells assert it with their own
 * message. Both lists are relative paths, because an absolute path in a failure message is a path
 * that differs on every machine and therefore cannot be recognised.
 *
 * THE ROOT AND THE BUILD LIST ARE ARGUMENTS, and that is what makes the guard's own two branches
 * drivable: the control cell in `parity-anchors.test.ts` points it at a synthetic package tree and
 * watches it report a missing artifact and a stale one. A guard whose refusing branches could only
 * be reached by deleting a real `dist` is a guard nobody has watched refuse.
 */
export function buildFreshness(
  builds: readonly { readonly pkg: string; readonly artifact: string }[] = ANCHORED_BUILDS,
  packagesRoot: string = PACKAGES_ROOT,
): BuildFreshness {
  const missing: string[] = []
  const stale: string[] = []
  for (const build of builds) {
    const artifact = join(packagesRoot, build.pkg, build.artifact)
    if (!existsSync(artifact)) {
      missing.push(relative(packagesRoot, artifact))
      continue
    }
    const sourceRoot = join(packagesRoot, build.pkg, 'src')
    if (!existsSync(sourceRoot)) continue
    const newest = newestProductSource(sourceRoot)
    if (newest === undefined) continue
    if (newest.mtimeMs > statSync(artifact).mtimeMs) {
      stale.push(
        `${relative(packagesRoot, newest.path)} is newer than `
        + `${relative(packagesRoot, artifact)}`,
      )
    }
  }
  return { missing, stale }
}

// ---- Fixtures ----------------------------------------------------------------------------------

const roots: string[] = []

/**
 * Register a temporary directory for removal by {@link cleanupTempRoots}.
 *
 * Exported because the control cells that plant SYNTHETIC package trees make their own roots and
 * must not have to remember a second cleanup path — one list, one sweep, whoever made the directory.
 */
export function trackTempRoot(root: string): string {
  roots.push(root)
  return root
}

/**
 * Remove every tracked root. Each importing test file calls this from its own `afterEach`.
 *
 * IT IS CALLED, NOT REGISTERED HERE. A module-level `afterEach` in a non-test module would attach
 * to whichever file imported it first under a runner that shared module state, and a cleanup whose
 * owner is ambiguous is a cleanup that runs at an ambiguous time.
 */
export function cleanupTempRoots(): void {
  removeTempRoots(roots.splice(0))
}

// No token, key or LLM block is planted: a value that does not exist cannot be printed.
export function fixtureProject(
  label: string,
  // A legacy `services.mcp.tokens` block, which fails strict validation; values stay in env.
  tokens: readonly { name: string; tokenEnvVar: string; scopes: readonly string[] }[] = [],
): { root: string; configPath: string } {
  const root = trackTempRoot(mkdtempSync(join(tmpdir(), `agent-qa-chat-${label}-`)))
  const configPath = join(root, 'agent-qa.config.yaml')
  writeFileSync(
    configPath,
    `${JSON.stringify(
      {
        workspace: {
          testMatch: ['tests/**/*.yaml'],
          testPathIgnore: [],
          suiteMatch: ['suites/**/*.suite.yaml'],
          hooksFile: 'hooks.yaml',
          envFile: '.env',
          secretsFile: '.env.secrets.local',
        },
        use: { mobile: { appState: 'preserve' } },
        services: {
          mcp: {
            ...(tokens.length === 0 ? {} : { tokens }),
          },
        },
      },
      null,
      2,
    )}\n`,
    'utf8',
  )
  mkdirSync(join(root, '.agent-qa'), { recursive: true })
  // Ask and chat refuse a project whose secrets file is missing.
  writeFileSync(join(root, '.env.secrets.local'), '', 'utf8')
  return { root, configPath }
}

/**
 * The child's whole environment, constructed rather than inherited.
 *
 * INHERITING WOULD MAKE THE CELL'S RESULT DEPEND ON WHOSE MACHINE IT RAN ON: a developer with a
 * provider key exported would be running a different chat composition from CI, and — worse — a
 * spawned process holding a real credential is a process whose stderr can print one. `HOME` and
 * `TMPDIR` point INTO the fixture so nothing the child writes escapes the directory the cleanup
 * above deletes.
 */
export function hermeticEnv(root: string): Record<string, string> {
  return {
    PATH: process.env.PATH ?? '',
    HOME: root,
    TMPDIR: join(root, '.agent-qa'),
    NODE_ENV: 'test',
  }
}

// ---- Driving the shipped binary ----------------------------------------------------------------

export interface SpawnOutcome {
  readonly code: number | null
  readonly signal: NodeJS.Signals | null
  readonly stdout: string
  readonly stderr: string
}

// One spawn helper, so there is one answer to what the child inherited.
export async function spawnCollecting(
  root: string,
  args: readonly string[],
  extraEnv: Readonly<Record<string, string>> = {},
): Promise<SpawnOutcome> {
  const child = spawn(process.execPath, [...args], {
    cwd: root,
    env: { ...hermeticEnv(root), ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString('utf8')
  })
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8')
  })
  return await new Promise<SpawnOutcome>((settle, fail) => {
    child.once('error', fail)
    child.once('close', (code, signal) => settle({ code, signal, stdout, stderr }))
  })
}

// The deterministic resolver route, which reaches no model.
export const CHAT_ANCHOR_UTTERANCE = '/fn quarantine.list'

/**
 * Drive the SHIPPED binary's chat command over a real pipe, and wait for it to exit.
 *
 * THE UTTERANCE IS A PARAMETER, NOT A SECOND DRIVER (the no-second-copy law this module is named
 * for). A second spawn helper would be a second answer to "what did the child inherit", which is
 * the one property every cell here depends on.
 */
export async function driveChatSpawned(
  root: string,
  configPath: string,
  utterance: string = CHAT_ANCHOR_UTTERANCE,
  extraEnv: Readonly<Record<string, string>> = {},
): Promise<SpawnOutcome> {
  const child = spawn(process.execPath, [CLI_ENTRY, '--config', configPath, 'chat'], {
    cwd: root,
    env: { ...hermeticEnv(root), ...extraEnv },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString('utf8')
  })
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8')
  })
  child.stdin.write(`${utterance}\n`)
  child.stdin.end()
  return await new Promise<SpawnOutcome>((settle, fail) => {
    child.once('error', fail)
    child.once('close', (code, signal) => settle({ code, signal, stdout, stderr }))
  })
}

// ---- Driving the shipped dashboard: one spawn recipe for every file that uses it ----

// `dashboard-server` and `dashboard-ui` are guarded too: a stale bundle certifies the wrong one.
export const DASHBOARD_ANCHORED_BUILDS: readonly {
  readonly pkg: string
  readonly artifact: string
}[] = Object.freeze([
  ...ANCHORED_BUILDS,
  Object.freeze({ pkg: 'dashboard-server', artifact: join('dist', 'index.js') }),
  Object.freeze({ pkg: 'dashboard-ui', artifact: join('dist', 'index.html') }),
])

// Beside the freshness list, so the guarded and the served bundle directory are one spelling.
export function dashboardUiDist(): string {
  return join(PACKAGES_ROOT, 'dashboard-ui', 'dist')
}

/**
 * A project the SPAWNED dashboard can open, which is a strictly larger recipe than the chat one.
 *
 * THE THREE EMPTY FILES ARE NOT DECORATION. `agent-qa dashboard` resolves its workspace with
 * `requireExistingFiles: true`, so a project whose `hooksFile`, `envFile` or `secretsFile` is
 * merely DECLARED makes the command exit 2 before it binds a port — which a cell would read as
 * "the dashboard did not start" with no idea why. `agent-qa chat` does not take that path, which
 * is why `fixtureProject` above does not write them and why this is a second recipe rather than
 * an edit to that one.
 *
 * NOTHING SECRET IS PLANTED, on `fixtureProject`'s own argument: `.env` and `.env.secrets.local`
 * are written EMPTY. A value that does not exist cannot be printed by a diagnostic nobody
 * anticipated, and the door these cells drive is model-unbound for the same reason.
 *
 * The knowledge root is declared so a cell that wants a real entity can publish a bundle into it;
 * a cell that does not simply lists an empty store.
 */
export function dashboardFixtureProject(label: string): {
  root: string
  configPath: string
  knowledgeRoot: string
} {
  const root = trackTempRoot(mkdtempSync(join(tmpdir(), `agent-qa-knowledge-chat-${label}-`)))
  const configPath = join(root, 'agent-qa.config.yaml')
  writeFileSync(
    configPath,
    `${JSON.stringify(
      {
        workspace: {
          testMatch: ['tests/**/*.test.yaml'],
          testPathIgnore: [],
          suiteMatch: ['suites/**/*.suite.yaml'],
          hooksFile: 'hooks.yaml',
          envFile: '.env',
          secretsFile: '.env.secrets.local',
        },
        knowledge: { dir: 'agent-qa-knowledge' },
        use: { mobile: { appState: 'preserve' } },
        registry: {
          targets: {
            conformance: { platform: 'web', url: 'https://conformance.invalid' },
          },
        },
      },
      null,
      2,
    )}\n`,
    'utf8',
  )
  writeFileSync(join(root, 'hooks.yaml'), 'hooks: {}\n', 'utf8')
  writeFileSync(join(root, '.env'), '', 'utf8')
  writeFileSync(join(root, '.env.secrets.local'), '', 'utf8')
  mkdirSync(join(root, '.agent-qa'), { recursive: true })
  const knowledgeRoot = join(root, 'agent-qa-knowledge')
  mkdirSync(knowledgeRoot, { recursive: true })
  return { root, configPath, knowledgeRoot }
}

/**
 * A port nothing is listening on, learned by binding one and letting it go.
 *
 * `--port 0` is NOT usable here even though the server accepts it: `startServer` reports the port
 * it was ASKED for rather than the one it bound, so a `0` would leave both this process and the
 * child's own `services.dashboard.baseUrl` overlay naming `http://localhost:0`. Reserving a real
 * port and handing it over keeps one number true on both sides. (The residual race — somebody else
 * taking the port between the close and the child's listen — announces itself as a child that
 * exited with an EADDRINUSE on its stderr, which every caller below quotes.)
 */
export async function reserveEphemeralPort(): Promise<number> {
  const { createServer } = await import('node:http')
  return await new Promise<number>((settle, fail) => {
    const probe = createServer()
    probe.once('error', fail)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      if (address === null || typeof address === 'string') {
        probe.close(() => { fail(new TypeError('the probe bound no port')) })
        return
      }
      const { port } = address
      probe.close(() => { settle(port) })
    })
  })
}

/** A spawned dashboard, as the cells that drive it consume it. */
export interface SpawnedDashboard {
  /** The origin a browser is pointed at. */
  readonly origin: string
  readonly port: number
  /** Everything the child has printed so far — quoted verbatim in every failure message. */
  stdout(): string
  stderr(): string
  /** Idempotent: safe to call from a cell body and from an `afterAll`. */
  stop(): Promise<void>
}

/** The line `startServer` prints once it is listening — the child's own readiness statement. */
export function dashboardReadyLine(port: number): string {
  return `Dashboard running at http://localhost:${String(port)}`
}

/**
 * Start the SHIPPED `agent-qa dashboard` command and wait for it to say it is listening.
 *
 * READINESS IS THE CHILD'S OWN SENTENCE, not a poll of the port and not a sleep. A poll would go
 * green against any process that happened to hold the port; a sleep would be a number somebody
 * guessed, and the failure it produces (an empty page) reads like a product defect.
 *
 * IT RETURNS DATA AND NEVER ASSERTS, on this module's own law — `startedAt` is `undefined` when
 * the child died or the budget ran out, and the caller decides what that means with its own
 * message and its own quoted streams.
 */
export async function spawnDashboard(
  root: string,
  configPath: string,
  port: number,
  budgetMs = 60_000,
  // A parameter, not a second spawn helper; empty by default, so a caller's child stays hermetic.
  extraEnv: Readonly<Record<string, string>> = {},
): Promise<SpawnedDashboard & { readonly ready: boolean }> {
  const child = spawn(
    process.execPath,
    [CLI_ENTRY, '--config', configPath, 'dashboard', '--port', String(port)],
    {
      cwd: root,
      env: { ...hermeticEnv(root), ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  let stdout = ''
  let stderr = ''
  let exited = false
  child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8') })
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
  child.once('close', () => { exited = true })

  const readyLine = dashboardReadyLine(port)
  const deadline = Date.now() + budgetMs
  while (!stdout.includes(readyLine) && !exited && Date.now() < deadline) {
    await new Promise<void>((tick) => setTimeout(tick, 50))
  }

  let stopped: Promise<void> | undefined
  const stop = async (): Promise<void> => {
    stopped ??= new Promise<void>((settled) => {
      if (exited) { settled(); return }
      child.once('close', () => { settled() })
      // SIGTERM first, because the command installs a handler that closes the server and the
      // database. The kill below is the backstop for a child that ignored it.
      child.kill('SIGTERM')
      const hard = setTimeout(() => { child.kill('SIGKILL') }, 5_000)
      hard.unref?.()
    })
    await stopped
  }

  return {
    origin: `http://127.0.0.1:${String(port)}`,
    port,
    ready: stdout.includes(readyLine),
    stdout: () => stdout,
    stderr: () => stderr,
    stop,
  }
}

// ---- The run service fixture: one project on disk, mounted in process or spawned ----

// Adds `runner` and `core`, which the spawned dashboard resolves through their built dists.
export const RUN_SERVICE_ANCHORED_BUILDS: readonly {
  readonly pkg: string
  readonly artifact: string
}[] = Object.freeze([
  ...DASHBOARD_ANCHORED_BUILDS,
  Object.freeze({ pkg: 'core', artifact: join('dist', 'index.js') }),
  Object.freeze({ pkg: 'runner', artifact: join('dist', 'index.js') }),
])

// The run is expected to fail: every claim here is about wire shape, not a passing run.
export function runServiceFixtureProject(label: string): {
  root: string
  configPath: string
} {
  const root = trackTempRoot(mkdtempSync(join(tmpdir(), `agent-qa-run-service-${label}-`)))
  const configPath = join(root, 'agent-qa.config.yaml')
  writeFileSync(
    configPath,
    `${JSON.stringify(
      {
        workspace: {
          testMatch: ['tests/**/*.test.yaml'],
          testPathIgnore: [],
          suiteMatch: ['suites/**/*.suite.yaml'],
          hooksFile: 'hooks.yaml',
          envFile: '.env',
          secretsFile: '.env.secrets.local',
        },
        use: { mobile: { appState: 'preserve' } },
        registry: {
          targets: {
            conformance: {
              platform: 'web',
              url: 'https://conformance.invalid',
              environment: 'local',
            },
          },
        },
      },
      null,
      2,
    )}\n`,
    'utf8',
  )
  // The three files `requireExistingFiles: true` refuses a project without — `dashboardFixtureProject`
  // states the reasoning; both frames take that path, the spawned one through the shipped command
  // and the in-process one through the same workspace resolution.
  // `hooks: []` AND NOT `hooks: {}`, and the difference is measured rather than copied.
  // `dashboardFixtureProject` above writes the mapping form and is correct for what it does — its
  // cells list capabilities and never start a run. A run VALIDATES the hooks document, and the
  // mapping form fails that validation with `CliRunInputError: Hooks configuration errors:`, which
  // this door then flattens into a `500 run_start_failed` carrying no diagnosis at all (correctly —
  // a crash message is composed from the host's own state and the caller is remote). A first draft
  // of this fixture copied the mapping form and every route probe read as "the door did not answer".
  writeFileSync(join(root, 'hooks.yaml'), 'hooks: []\n', 'utf8')
  writeFileSync(join(root, '.env'), '', 'utf8')
  writeFileSync(join(root, '.env.secrets.local'), '', 'utf8')
  mkdirSync(join(root, '.agent-qa'), { recursive: true })
  mkdirSync(join(root, 'tests'), { recursive: true })
  writeFileSync(
    join(root, 'tests', 'probe.test.yaml'),
    'name: The run service conformance probe\n'
    // MINTED rather than hand-written: canonical ids come from the ID helpers by house rule, and a
    // literal here would be an id this repository does not own.
    + `test-id: ${generateTestId()}\n`
    + 'target: conformance\n'
    + 'steps:\n'
    + '  - Do nothing this run will ever reach\n',
    'utf8',
  )
  return { root, configPath }
}

// Run through a suite with an unauthenticated model declared, so the run reaches its tail.

/** The name the declared model entry carries. One spelling, referenced by the config it writes. */
export const DRAINABLE_MODEL_NAME = 'conformance-model'

/**
 * The address the declared model points at: a port nothing is listening on.
 *
 * PORT 1 IS RESERVED AND UNSERVED, so a reach for this model is an immediate connection refusal
 * rather than a timeout somebody would read as a slow test. The deterministic analysis floor never
 * calls it; a build that started calling it would announce itself in seconds.
 */
export const DRAINABLE_MODEL_BASE_URL = 'http://127.0.0.1:1/v1'

/** The suite file a drainable run is triggered against, relative to the project root. */
export const DRAINABLE_SUITE_PATH = 'suites/probe.suite.yaml'

/**
 * A project whose dashboard-triggered SUITE run reaches a verdict, a `runFinished` and a real tail.
 *
 * Returns data and asserts nothing, on this module's own law.
 */
export function drainableSuiteFixtureProject(label: string): {
  root: string
  configPath: string
  suitePath: string
} {
  const project = runServiceFixtureProject(label)

  // The suite addresses the test by the id that file MINTED. Read back rather than re-minted: two
  // ids would be a suite entry naming a test this project does not contain, which the suite parser
  // refuses with a message about ids rather than about the fixture.
  const planted = readFileSync(join(project.root, 'tests', 'probe.test.yaml'), 'utf8')
  const testId = /^test-id: (.+)$/mu.exec(planted)?.[1]
  if (testId === undefined) {
    throw new Error('the run-service fixture no longer writes a `test-id:` line for the suite to address')
  }
  // ONE MEMBER, AND NOT BECAUSE MORE WOULD BE HARDER. A twenty-member suite was written and
  // measured first, to widen the post-verdict window a browser has to open a page in: it does not.
  // The member's throw poisons the suite's fail-fast group, every remaining member is SKIPPED, and
  // the chain still folds exactly one verdict — the window is identical and the run is slower. The
  // cells that need a longer window solve it on their own side.
  const entries: string[] = [`  - test: tests/probe.test.yaml\n    id: ${testId}\n`]
  mkdirSync(join(project.root, 'suites'), { recursive: true })
  writeFileSync(
    join(project.root, DRAINABLE_SUITE_PATH),
    'name: The post-processing conformance suite\n'
    + `suite-id: ${generateSuiteId()}\n`
    + 'target: conformance\n'
    + 'tests:\n'
    + entries.join(''),
    'utf8',
  )

  // The declared model, folded into the recipe above rather than written as a fifth config: the
  // three frames that share `runServiceFixtureProject` must keep the zero-declaration posture,
  // because "a project that declares nothing is refused" is itself a measured fact one of them
  // depends on.
  const config = JSON.parse(readFileSync(project.configPath, 'utf8')) as Record<string, unknown>
  const registry = (config.registry ?? {}) as Record<string, unknown>
  config.registry = {
    ...registry,
    llms: [
      {
        name: DRAINABLE_MODEL_NAME,
        provider: 'openai-compatible',
        model: 'stub-model',
        baseURL: DRAINABLE_MODEL_BASE_URL,
      },
    ],
  }
  config.use = { ...((config.use ?? {}) as Record<string, unknown>), llm: DRAINABLE_MODEL_NAME }
  writeFileSync(project.configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8')

  // The knowledge root, created rather than left to the first writer. A real `agent-qa daemon`
  // acquires its writer lease over this directory before it serves anything, and a daemon that had
  // to create it would be racing the run whose lease decision this fixture is about.
  mkdirSync(join(project.root, 'agent-qa-knowledge'), { recursive: true })

  return { ...project, suitePath: DRAINABLE_SUITE_PATH }
}
