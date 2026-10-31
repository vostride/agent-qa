// A global install runs a bin symlink with no `node_modules` above it, so these cells spawn one.

import { type ChildProcess, spawn } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { LOCAL_DAEMON_CAPABILITIES } from '@vostride/agent-qa-agent-local'
import { afterEach, describe, expect, it } from 'vitest'

import { DAEMON_SOCKET_PATH_BUDGET_BYTES } from '../daemon/server.js'

const TESTS_DIR = dirname(fileURLToPath(import.meta.url))
/** `packages/cli`. */
const CLI_PACKAGE_ROOT = resolve(TESTS_DIR, '..', '..')
/** `packages`. */
const PACKAGES_ROOT = resolve(CLI_PACKAGE_ROOT, '..')
const CLI_ENTRY = join(CLI_PACKAGE_ROOT, 'dist', 'cli.js')
const AGENT_LOCAL_ENTRY = join(PACKAGES_ROOT, 'agent-local', 'dist', 'index.js')

/** How long a cell waits for a child to say something conclusive before failing by name. */
const CHILD_VERDICT_TIMEOUT_MS = 60_000
/** How long a child gets to honour SIGTERM before it is killed outright. */
const CHILD_TERM_GRACE_MS = 3_000

const REBUILD_INSTRUCTION =
  'the built artifacts these cells execute are missing or older than their sources; run `pnpm '
  + 'build --force` at the repository root before running this file. A spawn against a stale build '
  + 'certifies the PREVIOUS revision while reading as proof of this one.'

/** The daemon's own success marker (`daemon/host.ts`). */
const DAEMON_STARTED = /agent-qa daemon started \(pid \d+, epoch \d+\)/u
/** The regression this file was written for, verbatim from the rehearsal terminal. */
const AGENT_LOCAL_UNRESOLVABLE = /Cannot find module '@vostride\/agent-qa-agent-local'/u
const KNOWLEDGE_LOCAL_UNRESOLVABLE = /Cannot find module '@vostride\/agent-qa-knowledge-local'/u

// ---- The stale-dist guard ----------------------------------------------------------------------

/**
 * The built artifacts these cells actually execute.
 *
 * `cli` is bundled from its own source; `agent-local` and `knowledge-local` arrive as their own
 * dists because tsdown leaves workspace dependencies external, and both are on the resolution path
 * this file is about. A guard watching only the entry point would be green while the module whose
 * anchor is the subject was a revision behind.
 */
const ANCHORED_BUILDS: readonly { readonly pkg: string; readonly artifact: string }[] = Object.freeze(
  [
    Object.freeze({ pkg: 'agent-local', artifact: join('dist', 'index.js') }),
    Object.freeze({ pkg: 'knowledge-local', artifact: join('dist', 'index.js') }),
    Object.freeze({ pkg: 'cli', artifact: join('dist', 'cli.js') }),
  ],
)

export interface BuildFreshness {
  /** Packages whose built artifact does not exist at all. */
  readonly missing: readonly string[]
  /** Packages whose newest product source is newer than the artifact built from it. */
  readonly stale: readonly string[]
}

/** The newest PRODUCT source under a directory. Test sources never enter a bundle, so they are skipped. */
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
      if (!/\.(?:ts|tsx|mts|cts|js|mjs|cjs|json)$/u.test(entry.name)) continue
      if (/\.test(?:-d)?\.[cm]?tsx?$/u.test(entry.name)) continue
      const { mtimeMs } = statSync(full)
      if (newest === undefined || mtimeMs > newest.mtimeMs) newest = { path: full, mtimeMs }
    }
  }
  walk(dir)
  return newest
}

/**
 * Whether every artifact these cells execute exists and post-dates the source it was built from.
 *
 * RETURNED AS DATA, and both the root and the build list are ARGUMENTS — which is what makes the
 * guard's own refusing branches drivable from a synthetic tree rather than only by breaking a real
 * one.
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
      stale.push(`${relative(packagesRoot, newest.path)} is newer than ${relative(packagesRoot, artifact)}`)
    }
  }
  return { missing, stale }
}

function assertBuildIsFresh(): void {
  const freshness = buildFreshness()
  expect(freshness.missing, `missing built artifacts — ${REBUILD_INSTRUCTION}`).toEqual([])
  expect(freshness.stale, `stale built artifacts — ${REBUILD_INSTRUCTION}`).toEqual([])
}

// ---- Fixtures ----------------------------------------------------------------------------------

const roots: string[] = []
const children: ChildProcess[] = []

afterEach(() => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/**
 * The shallowest writable temp base this platform offers.
 *
 * WHY DEPTH IS A CORRECTNESS CONCERN HERE AND NOWHERE ELSE. A daemon binds a UNIX domain socket,
 * whose address the kernel caps near 104 bytes, so the host refuses a project whose socket path
 * would exceed its budget. macOS's per-user `os.tmpdir()` is already 49 bytes deep, and a fixture
 * nested inside it pushes the address past the cap — at which point the REAL-PATH arm dies of a
 * PATH-LENGTH refusal that looks, from outside, exactly like the resolver defect this file is
 * measuring. Two different failures wearing one face is the thing a differential must never have.
 */
function shortestTempBase(): string {
  if (process.platform === 'win32') return tmpdir()
  for (const candidate of ['/tmp', tmpdir()]) {
    try {
      if (statSync(candidate).isDirectory()) return candidate
    } catch {
      continue
    }
  }
  return tmpdir()
}

const TEMP_BASE = shortestTempBase()

function temporaryRoot(label: string): string {
  const root = mkdtempSync(join(TEMP_BASE, `aq-${label}-`))
  roots.push(root)
  return root
}

/**
 * The socket address the daemon would bind for a project at `root`.
 *
 * Reproduced rather than imported because `daemonSocketPath` needs an instance UUID it mints per
 * generation; the shape (`<agentQaRoot>/daemon-<12 hex>.sock`) is what decides the budget.
 */
function wouldBeSocketPath(root: string): string {
  return join(root, '.agent-qa', `daemon-${'0'.repeat(12)}.sock`)
}

/**
 * The minimum project `agent-qa daemon` will actually start in, determined empirically rather than
 * copied from a template — the daemon refuses a config that omits any of these, and a refusal is
 * indistinguishable at the outside from the defect this file measures.
 *
 * NOTHING SECRET IS PLANTED. The one LLM entry names a compatible provider pointed at a dead
 * loopback port and carries no key, no token and no environment variable holding one. The daemon's
 * model and author bindings are lazy thunks that nothing on the boot path calls, so the process
 * reaches its banner without any provider being contacted or any credential being needed.
 */
function fixtureProject(label: string): string {
  const root = temporaryRoot(label)
  const socketPath = wouldBeSocketPath(root)
  expect(
    Buffer.byteLength(socketPath),
    `this machine's temp base (${TEMP_BASE}) is too deep for a daemon socket: ${socketPath}. That `
      + 'is a fixture defect, not the resolver defect these cells measure — point TMPDIR at a '
      + 'shallower directory and re-run.',
  ).toBeLessThanOrEqual(DAEMON_SOCKET_PATH_BUDGET_BYTES)
  mkdirSync(join(root, '.agent-qa'), { recursive: true })
  writeFileSync(
    join(root, 'agent-qa.config.yaml'),
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
        registry: {
          llms: [
            {
              name: 'unbound',
              provider: 'openai-compatible',
              model: 'unbound-model',
              baseURL: 'http://127.0.0.1:9/v1',
            },
          ],
        },
        use: { mobile: { appState: 'preserve' }, llm: 'unbound' },
      },
      null,
      2,
    )}\n`,
    'utf8',
  )
  return root
}

/**
 * The child's whole environment, constructed rather than inherited.
 *
 * Inheriting would make the result depend on whose machine it ran on, and would hand a spawned
 * process a provider credential it has no use for and whose stderr could print it.
 */
function hermeticEnv(root: string): Record<string, string> {
  return {
    PATH: process.env.PATH ?? '',
    HOME: root,
    TMPDIR: join(root, '.agent-qa'),
    NODE_ENV: 'test',
  }
}

/** Every ancestor directory of `dir`, `dir` itself included. */
function ancestors(dir: string): string[] {
  const chain: string[] = []
  let current = resolve(dir)
  for (;;) {
    chain.push(current)
    const parent = dirname(current)
    if (parent === current) return chain
    current = parent
  }
}

/**
 * A bin directory holding a symlink to `target`, with no `node_modules` on any ancestor.
 *
 * THIS TOPOLOGY IS THE WHOLE POINT. `/usr/local/bin/agent-qa` on a global install is exactly this:
 * a symlink whose directory has no package tree above it, pointing at an entry that does. Node
 * resolves the symlink when it loads the module, so `import.meta.url` and `__filename` both report
 * the real location and every ordinary import resolves; the only value that still names the bin
 * directory is `process.argv[1]`.
 */
function symlinkedBin(label: string, target: string, name = 'agent-qa'): string {
  const root = temporaryRoot(label)
  const binDir = join(root, 'bin')
  mkdirSync(binDir, { recursive: true })
  const linkPath = join(binDir, name)
  symlinkSync(target, linkPath)
  return linkPath
}

interface ChildVerdict {
  readonly output: string
  readonly matched: boolean
  readonly exited: boolean
}

/**
 * Spawn `node <entry> <args>` and wait until `marker` or `failureMarker` appears, the child exits,
 * or the bound expires — then stop the child.
 *
 * The daemon runs until something stops it, so a cell that merely awaited exit would hang until the
 * suite's own timeout and report nothing about why.
 */
function runUntilVerdict(
  entry: string,
  args: readonly string[],
  cwd: string,
  env: Record<string, string>,
  markers: readonly RegExp[],
): Promise<ChildVerdict> {
  return new Promise<ChildVerdict>((resolveVerdict) => {
    const child = spawn(process.execPath, [entry, ...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
    children.push(child)
    let output = ''
    let settled = false
    const finish = (matched: boolean, exited: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM')
        setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
        }, CHILD_TERM_GRACE_MS).unref()
      }
      resolveVerdict({ output, matched, exited })
    }
    const timer = setTimeout(() => finish(false, false), CHILD_VERDICT_TIMEOUT_MS)
    const absorb = (chunk: Buffer): void => {
      output += chunk.toString('utf8')
      if (markers.some((marker) => marker.test(output))) finish(true, false)
    }
    child.stdout?.on('data', absorb)
    child.stderr?.on('data', absorb)
    child.on('error', (error) => {
      output += `\nspawn error: ${error.message}`
      finish(false, true)
    })
    child.on('exit', () => finish(markers.some((marker) => marker.test(output)), true))
  })
}

// ---- Cells -------------------------------------------------------------------------------------

describe('the daemon from a global install', () => {
  it('refuses a missing or stale build, naming the artifact', () => {
    const synthetic = temporaryRoot('freshness')
    mkdirSync(join(synthetic, 'absent', 'src'), { recursive: true })
    writeFileSync(join(synthetic, 'absent', 'src', 'a.ts'), 'export const a = 1\n', 'utf8')

    const missingOnly = buildFreshness([{ pkg: 'absent', artifact: join('dist', 'index.js') }], synthetic)
    expect(missingOnly.missing).toEqual([join('absent', 'dist', 'index.js')])
    expect(missingOnly.stale).toEqual([])

    mkdirSync(join(synthetic, 'behind', 'src'), { recursive: true })
    mkdirSync(join(synthetic, 'behind', 'dist'), { recursive: true })
    writeFileSync(join(synthetic, 'behind', 'dist', 'index.js'), '// built\n', 'utf8')
    const source = join(synthetic, 'behind', 'src', 'a.ts')
    writeFileSync(source, 'export const a = 1\n', 'utf8')
    const future = new Date(Date.now() + 60_000)
    utimesSync(source, future, future)

    const staleOnly = buildFreshness([{ pkg: 'behind', artifact: join('dist', 'index.js') }], synthetic)
    expect(staleOnly.missing).toEqual([])
    expect(staleOnly.stale).toEqual([
      `${join('behind', 'src', 'a.ts')} is newer than ${join('behind', 'dist', 'index.js')}`,
    ])
  })

  it(
    'starts and prints its banner when the entry is reached at its real path',
    { timeout: CHILD_VERDICT_TIMEOUT_MS + 30_000 },
    async () => {
      assertBuildIsFresh()
      const project = fixtureProject('realpath')
      const verdict = await runUntilVerdict(
        CLI_ENTRY,
        ['daemon'],
        project,
        hermeticEnv(project),
        [DAEMON_STARTED, AGENT_LOCAL_UNRESOLVABLE],
      )
      expect(
        verdict.output,
        'the REAL-PATH arm is the control: if the daemon cannot start from its own build path in a '
          + 'hermetic project, the SYMLINK arm below measures nothing. Child output follows.',
      ).toMatch(DAEMON_STARTED)
      expect(verdict.output).not.toMatch(AGENT_LOCAL_UNRESOLVABLE)
    },
  )

  it(
    'starts and prints its banner when the entry is reached through a symlinked bin with no node_modules above it',
    { timeout: CHILD_VERDICT_TIMEOUT_MS + 30_000 },
    async () => {
      assertBuildIsFresh()
      const linkPath = symlinkedBin('globalbin', CLI_ENTRY)
      const withPackageTree = ancestors(dirname(linkPath)).filter((dir) =>
        existsSync(join(dir, 'node_modules')),
      )
      expect(
        withPackageTree,
        'the symlink must sit where a global install puts it — with no package tree on any '
          + 'ancestor. With one above it the cell would pass for the wrong reason',
      ).toEqual([])

      const project = fixtureProject('globalproj')
      const verdict = await runUntilVerdict(
        linkPath,
        ['daemon'],
        project,
        hermeticEnv(project),
        [DAEMON_STARTED, AGENT_LOCAL_UNRESOLVABLE],
      )
      expect(
        verdict.output,
        `the daemon did not start when invoked as ${linkPath}. Same build, same command, same `
          + 'project as the REAL-PATH arm — the only axis that differs is process.argv[1]. Child '
          + 'output follows.',
      ).toMatch(DAEMON_STARTED)
      expect(
        verdict.output,
        'the agent-local composition edge must resolve from the module\'s own location, never from '
          + 'the directory the invoking symlink happens to sit in',
      ).not.toMatch(AGENT_LOCAL_UNRESOLVABLE)
    },
  )

  it('resolves the embedder worker entry in-process, where argv[1] has a package tree above it', () => {
    assertBuildIsFresh()
    const entryPath = LOCAL_DAEMON_CAPABILITIES.resolveEmbedderWorkerEntryPath()
    expect(entryPath).toMatch(/embedder-worker[/\\]worker-entry\.js$/u)
    expect(existsSync(entryPath), `${entryPath} does not exist`).toBe(true)
  })

  it(
    'resolves the embedder worker entry when argv[1] is a symlink with no node_modules above it',
    { timeout: CHILD_VERDICT_TIMEOUT_MS + 30_000 },
    async () => {
      // The SECOND defective anchor's pair. `resolveEmbedderWorkerEntryPath` is not on the daemon's
      // boot path — it fires when an embedder worker is spawned — so the two daemon cells above
      // cannot reach it, and a fix applied only to the boot-path site would leave this one to fail
      // the first time curation needed an embedding. The probe imports agent-local's BUILT entry by
      // absolute path, so no package tree is needed for the import itself and the only thing that
      // can fail is the anchor under test.
      assertBuildIsFresh()
      const scriptRoot = temporaryRoot('embedder-probe')
      const scriptPath = join(scriptRoot, 'probe.mjs')
      writeFileSync(
        scriptPath,
        [
          `import { LOCAL_DAEMON_CAPABILITIES } from ${JSON.stringify(AGENT_LOCAL_ENTRY)}`,
          'try {',
          '  const entry = LOCAL_DAEMON_CAPABILITIES.resolveEmbedderWorkerEntryPath()',
          '  process.stdout.write(`embedder-worker-entry: ${entry}\\n`)',
          '} catch (error) {',
          '  process.stderr.write(`embedder-probe failed: ${error instanceof Error ? error.message : String(error)}\\n`)',
          '  process.exitCode = 1',
          '}',
        ].join('\n'),
        'utf8',
      )
      const linkPath = symlinkedBin('embedder-bin', scriptPath, 'agent-qa-embedder-probe')
      expect(
        ancestors(dirname(linkPath)).filter((dir) => existsSync(join(dir, 'node_modules'))),
        'the probe symlink must have no package tree on any ancestor',
      ).toEqual([])

      const verdict = await runUntilVerdict(
        linkPath,
        [],
        scriptRoot,
        hermeticEnv(scriptRoot),
        [/embedder-worker-entry: /u, KNOWLEDGE_LOCAL_UNRESOLVABLE],
      )
      expect(
        verdict.output,
        'agent-local\'s embedder-worker resolver must anchor on its own module location. Child '
          + 'output follows.',
      ).toMatch(/embedder-worker-entry: .*embedder-worker[/\\]worker-entry\.js/u)
      expect(verdict.output).not.toMatch(KNOWLEDGE_LOCAL_UNRESOLVABLE)
    },
  )
})
