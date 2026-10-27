// The spawned-binary instrument: ONE copy, shared by every cell that drives what a person installs
// (extracted 2026-08-20, Phase 399.1 plan 01).
//
// WHY THIS FILE EXISTS RATHER THAN A SECOND COPY. `parity-anchors.test.ts` states the law this
// extraction obeys, in its own words about the chat driver: "A second spawn helper would be a
// second answer to 'what did the child inherit', which is the one property every cell here depends
// on." Phase 399.1's render differential needs the same instrument — the same hermetic environment,
// the same freshness guard, the same fixture project — and copying it into a sibling test file
// would have created exactly the second answer that law forbids. So the instrument moved HERE and
// both files import it; neither owns a private copy of any of it.
//
// NOTHING IN THIS MODULE ASSERTS. Every function returns data — a freshness READING, a spawn
// OUTCOME, a fixture's paths — so each cell asserts with its own message and a refusal names the
// question that cell was asking. A helper that threw would report every caller's failure in one
// voice.
//
// THE FRESHNESS GUARD IS PART OF EACH CELL'S CONTRACT, NOT A PRECONDITION SOMEBODY SATISFIED ONCE.
// A stale `dist` is worse than an absent one: an anchor spawned against yesterday's build passes,
// reads as proof of today's source, and certifies the wrong artifact. So the guard refuses on two
// separate conditions — a MISSING built artifact and a built artifact OLDER than the newest
// non-test source file of the package it was built from — and names the offending file in both
// cases. It is an mtime comparison, which catches the failure it exists for (a person, or an agent,
// forgetting to rebuild before measuring) and does not pretend to survive somebody deliberately
// touching a build output.
//
// TEST SOURCES ARE EXCLUDED FROM THE FRESHNESS SCAN ON PURPOSE. tsup's entries are `src/index.ts`,
// `src/cli.ts` and `src/cli-main.ts`; nothing under `__tests__` is bundled into anything. Counting a test file's
// mtime would make every edit to a test look like an unbuilt change to the product, which is the
// kind of false alarm that gets a guard deleted. THIS FILE lives under `__tests__` for that exact
// reason: it is instrument, not product, and it must not make the guard cry wolf on itself.
//
// HERMETIC, AND WITHOUT A CREDENTIAL ANYWHERE (T-397-17, 396 D-17). Each spawned cell gets its own
// `mkdtemp` project whose configuration is planted throwaway workspace globs and nothing else — no
// token entry, no key, no LLM block — and the child is handed a constructed environment rather than
// the test process's, so no ambient provider credential can reach it and no provider can be spent
// against. The chat session a cell drives is therefore model-unbound by construction and takes the
// deterministic resolver route, which is the route that never touches a model at all.

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
    // 2026-10-18 (444-14, D-47): the bin entry only loads this bundle, which holds the CLI.
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

/**
 * A real project on disk, produced rather than a literal path handed to a child.
 *
 * 2026-10-01 (432-22, D-12): no `stdio.grantConfigWrite`. It was the one non-default setting, and
 * it made the MCP anchor like-for-like while stdio hid the configuration tools from callers without
 * the opt-in; since 432-21 every caller lists every tool, and 432-22 deletes the key. The fixture
 * declares an empty `services.mcp` block, which is what it declared besides the switch.
 *
 * NOTHING SECRET IS PLANTED HERE. There is no token entry, no key and no LLM block: the fixture
 * declares workspace globs. That is stronger than planting a throwaway credential, because a value
 * that does not exist cannot be printed by a diagnostic nobody anticipated.
 */
export function fixtureProject(
  label: string,
  /**
   * A LEGACY `services.mcp.tokens` block — names, never values (398-08; retired by 432-22).
   *
   * Empty for every 397 anchor. The 398-08 refs-only cell passes entries to plant a pre-432 file:
   * since 432-22 the key is deleted, so such a file fails strict validation with the normal
   * unrecognized-key error (D-22) and the value it names still travels only in a constructed child
   * environment.
   */
  tokens: readonly { name: string; tokenEnvVar: string; scopes: readonly string[] }[] = [],
): { root: string; configPath: string } {
  const root = trackTempRoot(mkdtempSync(join(tmpdir(), `agent-qa-397-07-${label}-`)))
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
  // 2026-10-14 (441-06, E3): ask and chat refuse a project whose secrets file is missing.
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

/**
 * Run a program to completion with a CONSTRUCTED environment, collecting both streams.
 *
 * Factored out of the chat driver rather than written twice: the 398-08 anchors need the same
 * hermetic spawn with an extra declared variable, and a second copy of this plumbing would be a
 * second answer to "what did the child inherit" — which is the one property these cells depend on.
 */
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

/**
 * The utterance both halves type: the deterministic resolver route, which reaches no model.
 * 432-13: the bare `proposals` alias is gone (C432-CHAT-DIRECT). 432-17 deleted `proposals.list`
 * itself, so the passthrough now reaches `quarantine.list`, another read-only empty-input listing.
 */
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

// ---- Driving the shipped DASHBOARD (400-09) ----------------------------------------------------
//
// WHY THE DASHBOARD SPAWN LIVES HERE AND NOT IN THE TWO FILES THAT USE IT. `dashboard-anchors` and
// `dashboard-dom` both drive the same child — the built `agent-qa dashboard` command, in the same
// hermetic environment, against the same freshness reading. This module's own law ("a second spawn
// helper would be a second answer to 'what did the child inherit'") applies to that child exactly
// as it applies to the chat one, so there is one recipe and both files import it.

/**
 * The built artifacts a spawned DASHBOARD executes.
 *
 * The chat list plus the two the fourth door adds. `dashboard-server` is the process that serves
 * the routes and `dashboard-ui` is the bundle a browser is handed — and BOTH belong in the guard
 * for the reason the header gives about `cli`: a DOM cell run against yesterday's `dashboard-ui`
 * bundle passes, reads as proof of today's `.tsx`, and certifies the wrong artifact. `dashboard-ui`
 * is anchored on `dist/index.html` rather than a hashed asset name, because the asset names change
 * every build and a guard that had to know them would be a second copy of the manifest.
 *
 * `dashboard-server` IS LOAD-BEARING AND NOT DECORATIVE, said here so nobody narrows this list back
 * to the chat five (400-16). `dashboard-process-survival.test.ts` asks whether one unauthenticated
 * request ends the SHIPPED process, and its whole subject is `server.ts`'s request listener —
 * which the spawned `agent-qa dashboard` resolves through THIS artifact, because tsup leaves the
 * workspace dependency external. A survival cell run against a stale `dashboard-server/dist` would
 * spawn the pre-fix listener, die exactly as it used to, and report a fix that was never loaded.
 * The refusal that prevents that names the file: `dashboard-server/src/server/server.ts is newer
 * than dashboard-server/dist/index.js`.
 *
 * WHAT THIS LIST STILL DOES NOT COVER, so the next reader does not over-trust it: the workspace
 * packages `dashboard-server` itself imports externally (`core`, `runner`, `schema`'s siblings, …)
 * are not all enumerated, so a stale dist of one of THOSE is invisible here. Every cell that has
 * needed this guard so far is asking about `cli`, `dashboard-server` or `dashboard-ui` source, and
 * widening it further is a change that should arrive with a cell that needs it.
 */
export const DASHBOARD_ANCHORED_BUILDS: readonly {
  readonly pkg: string
  readonly artifact: string
}[] = Object.freeze([
  ...ANCHORED_BUILDS,
  Object.freeze({ pkg: 'dashboard-server', artifact: join('dist', 'index.js') }),
  Object.freeze({ pkg: 'dashboard-ui', artifact: join('dist', 'index.html') }),
])

/**
 * The built dashboard UI a served `uiDir` points at — the bundle a browser is handed (403-06).
 *
 * IT LIVES BESIDE THE FRESHNESS LIST, deliberately: the guard one line up anchors
 * `dashboard-ui/dist/index.html`, and the directory that guard is about is the directory
 * `startServer({ uiDir })` serves. Two spellings of it would be two answers to "which bundle did
 * this cell certify", and the whole point of the guard is that there is one.
 */
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
  const root = trackTempRoot(mkdtempSync(join(tmpdir(), `agent-qa-400-09-${label}-`)))
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
  /**
   * Variables added to the CONSTRUCTED environment, never inherited from this process (402-07).
   *
   * A PARAMETER RATHER THAN A SECOND SPAWN HELPER, on this module's own law: the run-service
   * anchors need a declared credential in the child, and a copy of this function that also set an
   * environment would be a second answer to "what did the child inherit", which is the one
   * property every cell here depends on. `spawnCollecting` already carries the identical parameter
   * for the identical reason.
   *
   * Empty by default, so every pre-402 caller's child is hermetic byte for byte.
   */
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

// ---- The RUN SERVICE fixture and its build list (402-07) ---------------------------------------
//
// WHY THIS RECIPE LIVES HERE AND NOT IN EITHER FILE THAT USES IT. Two cells drive the authed run
// service and they drive it through DIFFERENT frames on purpose: the conformance adapter composes
// it in this process (`startServer`, real TCP, ephemeral port) and the wire anchors spawn the built
// `agent-qa dashboard` and reach it over a socket. What both need is the same PROJECT on disk — the
// same declared credential entry, the same locally-classified target, the same planted test — and
// this module's own law is that a second recipe would be a second answer to "what did the door
// open". So the project is written once and the two frames differ only in how they mount it, which
// is the only axis those cells mean to compare.
//
// NO VALUE IS EVER WRITTEN INTO THE PROJECT. `RunServiceTokenEntrySchema` has no member a value
// could occupy: the config declares a variable NAME, and the value travels only in a constructed
// child environment or an explicit `env` map. `fixtureProject`'s own argument applies unchanged —
// what a file does not contain cannot be printed by a diagnostic nobody anticipated.

// 2026-10-01 (432-21, D-12): `RUN_SERVICE_FIXTURE_TOKEN_VAR`, `RUN_SERVICE_FIXTURE_TOKEN` and
// `RUN_SERVICE_FIXTURE_ENTRY_NAME` are deleted with the run-service tokens. The run service is
// tokenless and always mounted, so the fixture declares no credential and the frames present none.

/**
 * The built artifacts a RUN SERVICE cell executes — the dashboard list plus the run path's two.
 *
 * WIDENED DELIBERATELY, and the header of {@link DASHBOARD_ANCHORED_BUILDS} asks for exactly this:
 * "widening it further is a change that should arrive with a cell that needs it." These cells need
 * it. A run started through this door executes in-process through `@vostride/agent-qa-runner`, and
 * the run gate, the scope resolution and the config schema it consults live in
 * `@vostride/agent-qa-core` — both of which the spawned `agent-qa dashboard` resolves through their
 * BUILT dists, because tsup leaves workspace dependencies external (WINDOWS #240). A wire anchor run
 * against a stale `runner/dist` would drive the previous revision of the very execution path whose
 * RPC shape it certifies, and would read as proof of this one.
 */
export const RUN_SERVICE_ANCHORED_BUILDS: readonly {
  readonly pkg: string
  readonly artifact: string
}[] = Object.freeze([
  ...DASHBOARD_ANCHORED_BUILDS,
  Object.freeze({ pkg: 'core', artifact: join('dist', 'index.js') }),
  Object.freeze({ pkg: 'runner', artifact: join('dist', 'index.js') }),
])

/**
 * A project whose dashboard mounts the authed run service, with one test a run can address.
 *
 * `environment: 'local'` ON THE TARGET IS LOAD-BEARING, and 402-01's e2e states why in full: the
 * run gate folds the most restrictive declared target class, and only an invocation whose every
 * target is declared local is decided `mutating-local` — the tier ratified as allowed in every
 * execution context. An undeclared or shared target classifies the run `mutating-shared`, which in
 * this door's fail-closed `local-headless` context is a DENIAL; a denied run never starts, never
 * acks and never streams, so a cell about DELIVERY would observe a refusal instead. That denial is
 * a real and correct behaviour of the product and 402-06 owns its cells.
 *
 * THE RUN IS EXPECTED TO FAIL, and that is fine. The planted test names steps no browser will ever
 * be launched for, so the run fails fast. Every claim these two frames make is about WIRE SHAPE —
 * an ack off the durable record, envelopes in the frozen frame, bytes that are pure JSON — and a
 * cell that needed a passing run would need a browser and would be measuring Playwright.
 */
export function runServiceFixtureProject(label: string): {
  root: string
  configPath: string
} {
  const root = trackTempRoot(mkdtempSync(join(tmpdir(), `agent-qa-402-07-${label}-`)))
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
        // 2026-10-01 (432-21, D-12): no `services.dashboard.runServiceTokens` declaration. Until
        // then this fixture had a token-declaring arm and a zero-token arm, and the zero-token arm
        // (the default posture) was the one a composition could silently drop; with the tokens
        // deleted there is one posture, and every frame spawns it.
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

// ---- The DRAINABLE fixture: a project whose dashboard-started run reaches a real verdict (404-08)
//
// WHY A FOURTH RECIPE RATHER THAN A FLAG ON THE THIRD. `runServiceFixtureProject` above states, in
// its own words, that "THE RUN IS EXPECTED TO FAIL, and that is fine" — every claim its two frames
// make is about WIRE SHAPE, and a run that reaches no verdict is adequate for all of them. This
// recipe's whole purpose is the opposite property, so it is built ON that one rather than beside
// it: same workspace, same locally-classified target, same empty secret files, same minted test.
// What it adds is exactly the two facts that turn "the run refuses" into "the run is drained".
//
// FACT 1 — THE MEMBER IS ADDRESSED THROUGH A SUITE. The direct-test producer wraps its member
// executor in a catch that records a FRAMEWORK error and cancels the session, and
// `in-process-run-execution.ts` re-throws that error four statements ABOVE the line that starts
// the detached post-run tail. So on a machine with no Playwright browser a DIRECT run can never
// reach its own tail — the structural fact 404-04 D-6 and 404-05 D-6 each recorded one door apart,
// and the reason `post-processing-anchors.test.ts` gave up its terminal arm. The SUITE producer
// carries no such wrapper (its `takeFrameworkError` answers undefined by construction), so the
// member's throw arrives at the shell as a member ERROR: a `runWarning`, a failed member, a real
// `verdict`, a real `runFinished` — and the tail runs. The browser is still absent; what changed
// is that its absence is now a test failure instead of a framework error.
//
// FACT 2 — A MODEL IS DECLARED AND NOTHING IS AUTHENTICATED. The suite path resolves the LLM auth
// before it prepares anything, and the default provider has an auth plugin, so a project that
// declares no model at all is REFUSED before the run starts ("requires an auth plugin") — measured,
// and it is why this recipe exists rather than a one-line suite file. A compatible provider with no
// saved credential resolves `unauthenticated` and OPTIONAL instead, which is the shipped
// zero-token posture: the run proceeds, the analysis floor is projected deterministically, and no
// token is stored anywhere. The base URL points at a port nothing serves, so a composition that
// silently reached for a model would fail loudly rather than quietly succeed.
//
// NOTHING SECRET IS PLANTED, on `fixtureProject`'s argument, unchanged: the config declares a
// provider name and a dead address, and no credential exists for either.

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
