// The shipped bin loads nothing of the error reporter while reporting is off, and keeps every exit
// code and every printed byte while it is on. Reporting is switched on only by a test preload that
// swaps the analytics dist's blank DSN for one on a loopback sink, so nothing leaves the machine.

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { createServer as createNetServer, type AddressInfo, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { gunzipSync } from 'node:zlib'

import { DEFAULT_ANALYTICS_SHUTDOWN_TIMEOUT_MS } from '@vostride/agent-qa-analytics'
import { afterEach, describe, expect, it } from 'vitest'

import {
  CLI_ENTRY,
  CLI_PACKAGE_ROOT,
  REBUILD_INSTRUCTION,
  buildFreshness,
  cleanupTempRoots,
  hermeticEnv,
  spawnCollecting,
  trackTempRoot,
  type SpawnOutcome,
} from './spawned-chat.js'

const CELL_BUDGET_MS = 60_000
// A long-lived command still running at this point is killed, and its cell fails.
const RUN_BUDGET_MS = 30_000
const REFUSED_INIT = ['init', '--setup', 'deps']
const INIT_REFUSAL =
  '--setup picks what a re-run of init sets up, and this folder is not set up yet. Run npx '
  + 'agent-qa init without --setup.'
const BLANK_DSN = 'const AGENT_QA_SENTRY_DSN = "";'

// Appends every specifier containing @sentry/ that the child resolves.
const SENTRY_RESOLVE_RECORDER = `import { appendFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.includes('@sentry/')) appendFileSync(__RECORD_FILE__, specifier + '\\n')
    return nextResolve(specifier, context)
  },
})
`

// Swaps the blank DSN constant in the analytics package's built entry, and fails the child loudly
// when that constant is no longer there to swap.
const DSN_SWAP = `import { registerHooks } from 'node:module'
registerHooks({
  load(url, context, nextLoad) {
    const loaded = nextLoad(url, context)
    if (!url.endsWith('/analytics/dist/index.js')) return loaded
    const source = String(loaded.source)
    if (!source.includes(__BLANK__)) throw new Error('the analytics dist holds no blank DSN')
    return { ...loaded, source: source.replace(__BLANK__, __SWAPPED__) }
  },
})
`

// Fires once agent-qa's uncaughtException listener is installed, or from a timer after a fixed
// delay when no listener will ever be. Queued as that listener is added, it runs with both of
// agent-qa's handlers on and before the command prints a line of its own.
const TRIGGER = `import { spawn } from 'node:child_process'
const fire = () => {
  if (__MODE__ === 'throw') throw new Error(__MESSAGE__)
  if (__MODE__ === 'reject') {
    void Promise.reject(new Error(__MESSAGE__))
    return
  }
  spawn(__MISSING_BINARY__)
}
if (__WAIT_FOR_LISTENER__) {
  const waiting = (event) => {
    if (event !== 'uncaughtException') return
    process.off('newListener', waiting)
    queueMicrotask(fire)
  }
  process.on('newListener', waiting)
} else {
  setTimeout(fire, 1000)
}
`

// Each placeholder becomes its value written as a JavaScript literal.
function filled(text: string, values: Readonly<Record<string, unknown>>): string {
  return Object.entries(values).reduce(
    (filling, [name, value]) => filling.replaceAll(`__${name}__`, JSON.stringify(value)),
    text,
  )
}

type TriggerMode = 'throw' | 'reject' | 'spawn'

const MISSING_BINARY = 'agent-qa-binary-that-does-not-exist'

afterEach(() => {
  cleanupTempRoots()
})

function expectFresh(): void {
  const freshness = buildFreshness()
  expect(
    { missing: freshness.missing, stale: freshness.stale },
    `these cells drive the built CLI: ${REBUILD_INSTRUCTION}`,
  ).toEqual({ missing: [], stale: [] })
}

function tempFolder(label: string): string {
  return trackTempRoot(mkdtempSync(join(tmpdir(), `agent-qa-reporting-${label}-`)))
}

function seen(outcome: SpawnOutcome): string {
  return JSON.stringify({ code: outcome.code, stdout: outcome.stdout, stderr: outcome.stderr })
}

function preload(name: string, text: string): string[] {
  const path = join(tempFolder('preload'), name)
  writeFileSync(path, text, 'utf8')
  return ['--import', pathToFileURL(path).href]
}

interface ResolveRecord {
  readonly args: string[]
  resolved(): string[]
}

function sentryResolveRecorder(): ResolveRecord {
  const file = join(tempFolder('resolved'), 'resolved.txt')
  return {
    args: preload(
      'sentry-resolve-recorder.mjs',
      filled(SENTRY_RESOLVE_RECORDER, { RECORD_FILE: file }),
    ),
    resolved: () =>
      existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean) : [],
  }
}

function dsnSwap(sink: { readonly dsn: string }): string[] {
  const swapped = `const AGENT_QA_SENTRY_DSN = ${JSON.stringify(sink.dsn)};`
  return preload('dsn-swap.mjs', filled(DSN_SWAP, { BLANK: BLANK_DSN, SWAPPED: swapped }))
}

function trigger(mode: TriggerMode, message: string, waitForListener: boolean): string[] {
  return preload(
    'trigger.mjs',
    filled(TRIGGER, {
      MODE: mode,
      MESSAGE: message,
      MISSING_BINARY,
      WAIT_FOR_LISTENER: waitForListener,
    }),
  )
}

interface Sink {
  readonly dsn: string
  // Each request's body, decoded.
  readonly bodies: string[]
  close(): Promise<void>
}

// Modelled on the analytics package's wire sink: it keeps what arrives and answers 200.
async function startSink(): Promise<Sink> {
  const bodies: string[] = []
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      const raw = Buffer.concat(chunks)
      const gzipped = raw.length >= 2 && raw[0] === 0x1f && raw[1] === 0x8b
      bodies.push((gzipped ? gunzipSync(raw) : raw).toString('utf8'))
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end('{}')
    })
  })
  await new Promise<void>((listening) => server.listen(0, '127.0.0.1', () => listening()))
  const { port } = server.address() as AddressInfo
  return {
    dsn: `http://key@127.0.0.1:${String(port)}/1`,
    bodies,
    close: () => new Promise<void>((closed) => server.close(() => closed())),
  }
}

async function withSink(use: (sink: Sink) => Promise<void>): Promise<void> {
  const sink = await startSink()
  try {
    await use(sink)
  } finally {
    await sink.close()
  }
}

// Accepts every connection on loopback and never answers, as a proxy or an ingest.
async function withSilentServer(use: (port: number) => Promise<void>): Promise<void> {
  const open = new Set<Socket>()
  const server = createNetServer((socket) => {
    open.add(socket)
    socket.on('error', () => {})
    socket.on('close', () => open.delete(socket))
  })
  await new Promise<void>((listening) => server.listen(0, '127.0.0.1', () => listening()))
  const { port } = server.address() as AddressInfo
  try {
    await use(port)
  } finally {
    for (const socket of open) socket.destroy()
    await new Promise<void>((closed) => server.close(() => closed()))
  }
}

// A folder of its own with a home of its own, so init refuses the folder and not the home.
async function spawnInFolder(label: string, args: readonly string[]): Promise<SpawnOutcome> {
  const folder = tempFolder(label)
  mkdirSync(join(folder, '.agent-qa'))
  const home = tempFolder(`${label}-home`)
  return await spawnCollecting(folder, args, { HOME: home, USERPROFILE: home })
}

function writeProject(privacy: boolean): string {
  const folder = tempFolder(privacy ? 'private' : 'open')
  mkdirSync(join(folder, '.agent-qa'))
  writeFileSync(
    join(folder, 'agent-qa.config.yaml'),
    `${JSON.stringify({
      workspace: {
        testMatch: ['tests/**/*.test.yaml'],
        suiteMatch: ['suites/**/*.suite.yaml'],
        hooksFile: 'hooks.yaml',
        envFile: '.env',
        secretsFile: '.env.secrets.local',
      },
      use: { mobile: { appState: 'reset' } },
      ...(privacy ? { analytics: { privacy: true } } : {}),
    })}\n`,
    'utf8',
  )
  writeFileSync(join(folder, '.env.secrets.local'), '', 'utf8')
  return folder
}

interface LongRun extends SpawnOutcome {
  readonly killedAtBudget: boolean
  readonly elapsedMs: number
}

// The environment is hermeticEnv's, as for every spawned cell, with `env` over it; the kill at the
// budget is added. With no folder given, it runs in a new one.
async function spawnLongLived(
  args: readonly string[],
  options: { readonly cwd?: string; readonly env?: Readonly<Record<string, string>> } = {},
): Promise<LongRun> {
  const folder = options.cwd ?? tempFolder('long-lived')
  if (options.cwd === undefined) mkdirSync(join(folder, '.agent-qa'))
  const home = tempFolder('long-lived-home')
  const startedAt = performance.now()
  const child = spawn(process.execPath, [...args], {
    cwd: folder,
    env: { ...hermeticEnv(folder), HOME: home, USERPROFILE: home, ...options.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  let killedAtBudget = false
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString('utf8')
  })
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8')
  })
  const budget = setTimeout(() => {
    killedAtBudget = true
    child.kill('SIGKILL')
  }, RUN_BUDGET_MS)
  try {
    return await new Promise<LongRun>((settle, fail) => {
      child.once('error', fail)
      child.once('close', (code, signal) =>
        settle({
          code,
          signal,
          stdout,
          stderr,
          killedAtBudget,
          elapsedMs: performance.now() - startedAt,
        }),
      )
    })
  } finally {
    clearTimeout(budget)
  }
}

const LONG_LIVED = [CLI_ENTRY, 'mcp', '--http', '0']

describe('reporting off on the shipped bin', () => {
  it(
    'a refused init exits 2 with its line, resolves no @sentry/ module and sends nothing',
    async () => {
      expectFresh()
      await withSink(async (sink) => {
        const recorder = sentryResolveRecorder()

        const refused = await spawnInFolder('off', [...recorder.args, CLI_ENTRY, ...REFUSED_INIT])

        expect(refused.code, seen(refused)).toBe(2)
        expect(refused.stderr, seen(refused)).toBe(`${INIT_REFUSAL}\n`)
        expect(refused.stdout, seen(refused)).toBe('')
        expect(recorder.resolved()).toEqual([])
        expect(sink.bodies).toEqual([])
      })
    },
    CELL_BUDGET_MS,
  )

  it(
    'an exception thrown from a timer in a long-lived command still ends the process with exit 1',
    async () => {
      expectFresh()
      await withSink(async (sink) => {
        const message = 'a canary thrown while reporting is off'

        const crashed = await spawnLongLived([...trigger('throw', message, false), ...LONG_LIVED])

        expect(crashed.killedAtBudget, seen(crashed)).toBe(false)
        expect(crashed.code, seen(crashed)).toBe(1)
        expect(crashed.stderr, seen(crashed)).toContain(message)
        expect(crashed.stderr, seen(crashed)).not.toContain('Unexpected error: ')
        expect(sink.bodies).toEqual([])
      })
    },
    CELL_BUDGET_MS,
  )
})

describe('reporting on, with a loopback DSN swapped into the shipped bin', () => {
  it(
    'a refused init exits 2 with byte-identical output and sends its refusal to the sink',
    async () => {
      expectFresh()
      await withSink(async (sink) => {
        const off = await spawnInFolder('init-off', [CLI_ENTRY, ...REFUSED_INIT])
        const on = await spawnInFolder('init-on', [...dsnSwap(sink), CLI_ENTRY, ...REFUSED_INIT])

        expect(off.code, seen(off)).toBe(2)
        expect(on.code, seen(on)).toBe(2)
        expect(on.stdout, seen(on)).toBe(off.stdout)
        expect(on.stderr, seen(on)).toBe(off.stderr)
        expect(on.stderr, seen(on)).toBe(`${INIT_REFUSAL}\n`)
        const refusal = JSON.stringify(INIT_REFUSAL).slice(1, -1)
        expect(sink.bodies.some((body) => body.includes(refusal)), sink.bodies.join('\n')).toBe(
          true,
        )
      })
    },
    CELL_BUDGET_MS,
  )

  it(
    'every release a report names is agent-qa@ the version --version prints',
    async () => {
      expectFresh()
      await withSink(async (sink) => {
        const shown = await spawnInFolder('version', [CLI_ENTRY, '--version'])
        const version = shown.stdout.trim()
        expect(version, seen(shown)).toMatch(/^\d+\.\d+\.\d+/u)

        const refused = await spawnInFolder('release', [
          ...dsnSwap(sink),
          CLI_ENTRY,
          ...REFUSED_INIT,
        ])

        expect(refused.code, seen(refused)).toBe(2)
        const releases = sink.bodies.flatMap((body) =>
          [...body.matchAll(/"release":"([^"]*)"/gu)].map((match) => match[1]),
        )
        expect(releases.length, sink.bodies.join('\n')).toBeGreaterThan(0)
        expect([...new Set(releases)]).toEqual([`agent-qa@${version}`])
      })
    },
    CELL_BUDGET_MS,
  )

  it(
    'a refused run in a project with analytics.privacy true loads no @sentry/ module and sends nothing, while its twin sends',
    async () => {
      expectFresh()
      await withSink(async (sink) => {
        const outcomes: Array<{ readonly resolved: number; readonly sent: number }> = []
        for (const privacy of [false, true]) {
          const project = writeProject(privacy)
          const recorder = sentryResolveRecorder()
          const sent = sink.bodies.length
          const refused = await spawnCollecting(project, [
            ...recorder.args,
            ...dsnSwap(sink),
            CLI_ENTRY,
            'run',
            'tests/missing.test.yaml',
          ])
          expect(refused.code, seen(refused)).toBe(1)
          expect(refused.stderr, seen(refused)).toContain('Env file not found')
          outcomes.push({ resolved: recorder.resolved().length, sent: sink.bodies.length - sent })
        }

        const [open, optedOut] = outcomes
        expect(open?.resolved, 'the twin without privacy loads the SDK').toBeGreaterThan(0)
        expect(open?.sent, 'the twin without privacy sends').toBeGreaterThan(0)
        expect(optedOut).toEqual({ resolved: 0, sent: 0 })
      })
    },
    CELL_BUDGET_MS,
  )

  it(
    '--help and --version resolve no @sentry/ module and make no request',
    async () => {
      expectFresh()
      await withSink(async (sink) => {
        for (const flag of ['--help', '--version']) {
          const recorder = sentryResolveRecorder()

          const shown = await spawnInFolder('flag', [
            ...recorder.args,
            ...dsnSwap(sink),
            CLI_ENTRY,
            flag,
          ])

          expect(shown.code, seen(shown)).toBe(0)
          expect(recorder.resolved(), flag).toEqual([])
        }
        expect(sink.bodies).toEqual([])
      })
    },
    CELL_BUDGET_MS,
  )
})

describe("agent-qa's own global handlers on the shipped bin, with reporting on", () => {
  it.each([
    { name: 'an uncaught exception', mode: 'throw' as const },
    { name: 'an unhandled rejection', mode: 'reject' as const },
  ])(
    '$name ends a long-lived command with exit 1 after the Unexpected error block, and is sent',
    async ({ mode }) => {
      expectFresh()
      await withSink(async (sink) => {
        const message = `a canary for the ${mode} handler`

        const crashed = await spawnLongLived([
          ...dsnSwap(sink),
          ...trigger(mode, message, true),
          ...LONG_LIVED,
        ])

        expect(crashed.killedAtBudget, seen(crashed)).toBe(false)
        expect(crashed.code, seen(crashed)).toBe(1)
        expect(crashed.stderr.split('\n')[0], seen(crashed)).toBe(`Unexpected error: ${message}`)
        expect(sink.bodies.some((body) => body.includes(message)), sink.bodies.join('\n')).toBe(
          true,
        )
      })
    },
    CELL_BUDGET_MS,
  )

  it(
    'a child process that fails to spawn with no error listener still ends the process with exit 1',
    async () => {
      expectFresh()
      await withSink(async (sink) => {
        const crashed = await spawnLongLived([
          ...dsnSwap(sink),
          ...trigger('spawn', 'unused', true),
          ...LONG_LIVED,
        ])

        expect(crashed.killedAtBudget, seen(crashed)).toBe(false)
        expect(crashed.code, seen(crashed)).toBe(1)
        expect(crashed.stderr.split('\n')[0], seen(crashed)).toMatch(
          /^Unexpected error: spawn agent-qa-binary-that-does-not-exist ENOENT/u,
        )
      })
    },
    CELL_BUDGET_MS,
  )
})

// The settle budget, the CLI's start and the command itself, with room for a loaded runner; a
// command a report holds open is killed at the run budget instead.
const EXIT_BOUND_MS = DEFAULT_ANALYTICS_SHUTDOWN_TIMEOUT_MS + 8_000

describe('report requests behind a proxy on the shipped bin, with reporting on', () => {
  it.each([{ variable: 'http_proxy' }, { variable: 'https_proxy' }, { variable: 'HTTPS_PROXY' }])(
    'with $variable naming a proxy that never answers, a command that ends on its own and one that calls process.exit each exit with their own code inside the bound',
    async ({ variable }) => {
      expectFresh()
      await withSilentServer(async (port) => {
        const valid = writeProject(false)
        writeFileSync(join(valid, '.env'), '', 'utf8')
        writeFileSync(join(valid, 'hooks.yaml'), '{"hooks":[]}\n', 'utf8')
        const swap = dsnSwap({ dsn: `https://key@127.0.0.1:${String(port)}/1` })
        const env = { [variable]: `http://127.0.0.1:${String(port)}` }

        const validated = await spawnLongLived([...swap, CLI_ENTRY, 'validate'], {
          cwd: valid,
          env,
        })
        const refused = await spawnLongLived(
          [...swap, CLI_ENTRY, 'run', 'tests/missing.test.yaml'],
          { cwd: writeProject(false), env },
        )

        expect(validated.killedAtBudget, seen(validated)).toBe(false)
        expect(validated.code, seen(validated)).toBe(0)
        expect(validated.elapsedMs, seen(validated)).toBeLessThan(EXIT_BOUND_MS)
        expect(refused.killedAtBudget, seen(refused)).toBe(false)
        expect(refused.code, seen(refused)).toBe(1)
        expect(refused.stderr, seen(refused)).toContain('Env file not found')
        expect(refused.elapsedMs, seen(refused)).toBeLessThan(EXIT_BOUND_MS)
      })
    },
    CELL_BUDGET_MS,
  )
})

describe('the built CLI entries', () => {
  const STATIC_IMPORT = /^\s*import\s+(?:[\w$*{}\s,]+?\s+from\s+)?["']@sentry\//mu
  const STATIC_EXPORT = /^\s*export\s+[\w$*{}\s,]+?\s+from\s+["']@sentry\//mu
  const REQUIRE = /\brequire\(\s*["']@sentry\//u
  const DYNAMIC_IMPORT = /\bimport\(\s*["']@sentry\/node["']\s*\)/u

  it('cli-main.js and index.js load the SDK through no static import or require, and cli-main.js holds the dynamic import', () => {
    expectFresh()
    const built = (name: string) => readFileSync(join(CLI_PACKAGE_ROOT, 'dist', name), 'utf8')
    for (const name of ['cli-main.js', 'index.js']) {
      const text = built(name)
      expect([STATIC_IMPORT, STATIC_EXPORT, REQUIRE].map((form) => form.test(text)), name).toEqual([
        false,
        false,
        false,
      ])
    }
    expect(built('cli-main.js')).toMatch(DYNAMIC_IMPORT)
  })
})
