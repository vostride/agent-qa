// A long-lived host that fails at its top level reports the error once, and the same failure with
// analytics.privacy true prints the same lines and ends with the same exit code. Each host hands
// the analytics it composed to the settle step, which drains it beside the reporter's flush.

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'

import { Command } from 'commander'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { defaultCliFailureDeps, runCli } from '../cli-error-handler.js'
import { createChatCommand } from '../commands/chat.js'
import type { ChatCommandDeps } from '../commands/chat.js'
import { createDaemonCommand } from '../commands/daemon.js'
import type { DaemonCommandDeps } from '../commands/daemon.js'
import {
  createDashboardCommand,
  createServeCommand,
  exitAfterSettling,
} from '../commands/dashboard.js'
import { createInitCommand } from '../commands/init.js'
import { MCP_HTTP_BIND_HOST, createMcpCommand } from '../commands/mcp.js'
import * as analyticsHost from '../composition/analytics-host.js'
import * as errorReporting from '../composition/error-reporting.js'
import { closeErrorReporting, startErrorReporting } from '../composition/error-reporting.js'
import * as config from '../config.js'
import {
  canaryError,
  canaryLine,
  canaryProject,
  expectNoCanary,
  expectUsefulReport,
  removeCanaryProjects,
  startCanaryReporting,
} from './error-report-canaries.js'
import {
  projectWithPrivacy,
  recordingReportTransport,
  removeReportProjects,
  serializedEnvelopes,
} from './error-report-recorder.js'
import type {
  RecordedEnvelope,
  RecordingReportTransport,
  ReportProject,
} from './error-report-recorder.js'
import { fakeRunner } from './project-fixtures.js'

const INVENTED_DSN = 'http://key@127.0.0.1:9/1'
const START_FAILURE = 'fixture start failure'

// A host's own drain, then the settle runCli makes once the host has returned.
const DRAINED = ['settle with analytics', 'analytics shutdown', 'analytics shut down', 'settled']
const SETTLED = ['settle', 'settled']

// Settles, analytics shutdowns and exits, in the order a host reached them.
const steps: string[] = []
// The analytics each settle was handed, and each analytics host a command composed.
const handedOver: unknown[] = []
const composed: unknown[] = []
const scratch: string[] = []
let exitCodeBefore: typeof process.exitCode

beforeEach(() => {
  // No cell reads the auth store in the real home folder.
  const authDir = mkdtempSync(join(tmpdir(), 'agent-qa-host-failures-auth-'))
  scratch.push(authDir)
  vi.stubEnv('XDG_DATA_HOME', authDir)
  exitCodeBefore = process.exitCode
  steps.length = 0
  handedOver.length = 0
  composed.length = 0
  observeSettles()
})

afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  await closeErrorReporting()
  removeReportProjects()
  removeCanaryProjects()
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true })
  process.exitCode = exitCodeBefore
})

function observeSettles(): void {
  const settle = errorReporting.settleReporting
  vi.spyOn(errorReporting, 'settleReporting').mockImplementation(async (input) => {
    if (input?.analytics !== undefined) handedOver.push(input.analytics)
    steps.push(input?.analytics === undefined ? 'settle' : 'settle with analytics')
    await settle(input)
    steps.push('settled')
  })
  const compose = analyticsHost.composeAnalyticsHost
  vi.spyOn(analyticsHost, 'composeAnalyticsHost').mockImplementation(async (input) => {
    const host = await compose(input)
    composed.push(host)
    const shutdown = host.shutdown.bind(host)
    vi.spyOn(host, 'shutdown').mockImplementation(async () => {
      steps.push('analytics shutdown')
      await shutdown()
      steps.push('analytics shut down')
    })
    return host
  })
}

function plain(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, '')
}

// Each arm runs in a folder of its own, so a line that names it names <project>.
function withoutFolder(lines: readonly string[], dir: string): string[] {
  const spellings = [realpathSync(dir), dir]
  return lines.map((line) =>
    spellings.reduce((text, spelling) => text.split(spelling).join('<project>'), line),
  )
}

interface Host {
  readonly command: Command
  readonly args: readonly string[]
  // Runs once the command has started, as a person at the prompt or a stop signal would.
  readonly meanwhile?: () => Promise<void> | void
}

// Every exit the host makes goes through the exit it is handed, so no real one reaches the worker.
type HostFactory = (exit: (code: number) => void) => Host

interface HostRun {
  // The project folder the arm ran in.
  readonly dir: string
  // The console lines up to the first exit.
  readonly printed: readonly string[]
  readonly exitCode: typeof process.exitCode
  readonly exits: readonly number[]
  readonly steps: readonly string[]
  readonly handedOver: readonly unknown[]
  readonly composed: readonly unknown[]
  // What the reporter had sent at the first exit, or once runCli returned.
  readonly sent: readonly RecordedEnvelope[]
}

// Reporting is decided from the host's own project, as the CLI decides it before the action, and
// the command span stands in for the one opened then. The host runs under runCli.
async function runHost(
  reporting: 'on' | 'off',
  recorder: RecordingReportTransport,
  factory: HostFactory,
  arrange?: (project: ReportProject) => void,
): Promise<HostRun> {
  const project = projectWithPrivacy(reporting === 'off' ? { privacy: true } : {})
  arrange?.(project)
  steps.length = 0
  handedOver.length = 0
  composed.length = 0
  const before = recorder.envelopes.length
  const printed: string[] = []
  const exits: number[] = []
  let sent: RecordedEnvelope[] | undefined
  const exit = (code: number): void => {
    if (exits.length === 0) sent = recorder.envelopes.slice(before)
    exits.push(code)
    steps.push(`exit ${String(code)}`)
  }
  const host = factory(exit)
  const reporter = await startErrorReporting({
    configPath: project.configPath,
    dsn: INVENTED_DSN,
    transport: recorder.transport,
  })
  expect(reporter !== undefined, `reporting ${reporting}`).toBe(reporting === 'on')
  reporter?.beginCommandSpan(host.command.name(), [])
  const keep = (...parts: unknown[]): void => {
    if (exits.length === 0) printed.push(...plain(parts.map(String).join(' ')).split('\n'))
  }
  const spies = [
    vi.spyOn(console, 'log').mockImplementation(keep),
    vi.spyOn(console, 'warn').mockImplementation(keep),
    vi.spyOn(console, 'error').mockImplementation(keep),
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      exit(code ?? 0)
    }) as typeof process.exit),
  ]
  process.exitCode = undefined
  let exitCode: typeof process.exitCode
  try {
    const program = new Command().name('agent-qa').option('--config <path>').exitOverride()
    program.addCommand(host.command)
    const running = runCli(
      program,
      ['node', 'agent-qa', '--config', project.configPath, ...host.args],
      { ...defaultCliFailureDeps(program), exit },
    )
    await host.meanwhile?.()
    await running
    exitCode = process.exitCode
  } finally {
    process.exitCode = exitCodeBefore
    for (const spy of spies) spy.mockRestore()
  }
  sent ??= recorder.envelopes.slice(before)
  await closeErrorReporting()
  return {
    dir: project.dir,
    printed: withoutFolder(printed, project.dir),
    exitCode,
    exits,
    steps: [...steps],
    handedOver: [...handedOver],
    composed: [...composed],
    sent,
  }
}

interface Arms {
  readonly on: HostRun
  readonly off: HostRun
}

// Both arms send through one recorder, so a recorder off the send path cannot pass the off arm.
async function onAndOff(
  factory: HostFactory,
  arrange?: (project: ReportProject) => void,
): Promise<Arms> {
  const recorder = recordingReportTransport()
  const on = await runHost('on', recorder, factory, arrange)
  const off = await runHost('off', recorder, factory, arrange)
  return { on, off }
}

type EnvelopeItems = Array<[unknown, Array<[{ readonly type?: string }, unknown]>]>

function itemsOf(envelopes: readonly RecordedEnvelope[], type: string): unknown[] {
  return (JSON.parse(serializedEnvelopes(envelopes)) as EnvelopeItems)
    .flatMap(([, items]) => items)
    .filter(([header]) => header.type === type)
    .map(([, payload]) => payload)
}

interface ReportedError {
  readonly exception?: { readonly values?: ReadonlyArray<{ readonly value?: string }> }
}

interface ReportedSpan {
  readonly attributes?: Readonly<Record<string, { readonly value?: unknown }>>
}

// The message each error event reports, one entry per event.
function reportedErrors(envelopes: readonly RecordedEnvelope[]): string[] {
  return (itemsOf(envelopes, 'event') as ReportedError[]).map((event) =>
    (event.exception?.values ?? []).map((value) => value.value ?? '').join('\n'),
  )
}

function commandSpans(envelopes: readonly RecordedEnvelope[]): ReportedSpan[] {
  return (itemsOf(envelopes, 'span') as Array<{ readonly items?: ReportedSpan[] }>)
    .flatMap((payload) => payload.items ?? [])
    .filter((span) => span.attributes?.['sentry.op']?.value === 'agent_qa.command')
}

function untilTheFirstExit(log: readonly string[]): string[] {
  return log.slice(0, log.findIndex((entry) => entry.startsWith('exit ')) + 1)
}

function expectReportingOffChangesNothingElse(arms: Arms): void {
  expect(commandSpans(arms.on.sent), 'the on arm sent its command span').toHaveLength(1)
  expect(arms.off.sent).toEqual([])
  expect(arms.off.exitCode).toEqual(arms.on.exitCode)
  expect(arms.off.exits).toEqual(arms.on.exits)
  expect(arms.off.steps).toEqual(arms.on.steps)
  expect(arms.on.printed.join('\n').trim(), 'the host printed nothing').not.toBe('')
  expect(arms.off.printed).toEqual(arms.on.printed)
}

// The one analytics host the command composed is handed to the settle step, and shut down once.
function expectAnalyticsHandedOverOnce(run: HostRun): void {
  expect(run.composed).toHaveLength(1)
  expect(run.handedOver).toHaveLength(1)
  expect(run.handedOver[0]).toBe(run.composed[0])
  expect(run.steps.filter((step) => step === 'analytics shutdown')).toHaveLength(1)
}

// Calls the stop-signal listeners the server added once it says it is listening, as a Ctrl-C would.
function stopOnceListening(): void {
  const before = new Set<unknown>(process.listeners('SIGINT'))
  const write = vi.spyOn(process.stderr, 'write')
  write.mockImplementation(((chunk: unknown, ...rest: unknown[]) => {
    for (const part of rest) if (typeof part === 'function') part()
    if (String(chunk).includes('MCP server listening on')) {
      write.mockRestore()
      for (const listener of process.listeners('SIGINT')) {
        if (!before.has(listener)) listener('SIGINT')
      }
    }
    return true
  }) as typeof process.stderr.write)
}

describe('agent-qa mcp', () => {
  const failingCompose: typeof analyticsHost.composeAnalyticsHost = async () => {
    throw new Error(START_FAILURE)
  }

  it.each([
    { transport: 'stdio', flags: [] as string[] },
    { transport: 'HTTP', flags: ['--http', '0'] },
  ])(
    'reports a start that throws over $transport, and prints and exits as before',
    async ({ flags }) => {
      const arms = await onAndOff((exit) => ({
        command: createMcpCommand({ composeAnalytics: failingCompose, exit }),
        args: ['mcp', ...flags],
      }))

      expect(arms.on.exitCode).toBe(1)
      expect(arms.on.printed).toContain(`Failed to start MCP server: ${START_FAILURE}`)
      expect(reportedErrors(arms.on.sent)).toEqual([START_FAILURE])
      expect(arms.on.steps).toEqual(SETTLED)
      expectReportingOffChangesNothingElse(arms)
    },
  )

  it('reports a port it cannot bind after its analytics went through the settle step', async () => {
    const held = createServer()
    await new Promise<void>((listening) => held.listen(0, MCP_HTTP_BIND_HOST, () => listening()))
    const address = held.address()
    const port = typeof address === 'object' && address !== null ? address.port : 0
    try {
      const arms = await onAndOff((exit) => ({
        command: createMcpCommand({ exit }),
        args: ['mcp', '--http', String(port)],
      }))

      const refused = `listen EADDRINUSE: address already in use ${MCP_HTTP_BIND_HOST}:${port}`
      expect(arms.on.exitCode).toBe(1)
      expect(arms.on.printed).toContain(`Failed to start MCP server: ${refused}`)
      expect(reportedErrors(arms.on.sent)).toEqual([refused])
      for (const run of [arms.on, arms.off]) {
        expect(run.steps).toEqual([...DRAINED, ...SETTLED])
        expectAnalyticsHandedOverOnce(run)
      }
      expectReportingOffChangesNothingElse(arms)
    } finally {
      await new Promise<void>((closed) => held.close(() => closed()))
    }
  })

  it('settles before the exit 0 that follows a stop signal, and reports nothing', async () => {
    const arms = await onAndOff((exit) => ({
      command: createMcpCommand({ exit }),
      args: ['mcp', '--http', '0'],
      meanwhile: stopOnceListening,
    }))

    for (const run of [arms.on, arms.off]) {
      expect(run.exits[0]).toBe(0)
      expect(untilTheFirstExit(run.steps)).toEqual([...DRAINED, ...SETTLED, 'exit 0'])
      expectAnalyticsHandedOverOnce(run)
    }
    expect(commandSpans(arms.on.sent), 'sent before the exit').toHaveLength(1)
    expect(reportedErrors(arms.on.sent)).toEqual([])
    expect(arms.off.sent).toEqual([])
  })
})

function daemonDeps(runHost: DaemonCommandDeps['runHost']): DaemonCommandDeps {
  const unused = (name: string) => () => {
    throw new Error(`daemon dep ${name} must not be reached by the bare daemon action`)
  }
  return {
    runHost,
    resolvePaths: unused('resolvePaths'),
    resolveAgentQaRoot: unused('resolveAgentQaRoot'),
    readRegistration: unused('readRegistration'),
    processIsAlive: unused('processIsAlive'),
    readIdentity: unused('readIdentity'),
    readWriterLease: unused('readWriterLease'),
    countPendingCurationJobs: unused('countPendingCurationJobs'),
    signalProcess: unused('signalProcess'),
    now: () => 1_700_000_000_000,
  }
}

function daemonHost(runHost: DaemonCommandDeps['runHost']): HostFactory {
  return () => ({ command: createDaemonCommand(daemonDeps(runHost)), args: ['daemon'] })
}

describe('agent-qa daemon', () => {
  it('reports a host that throws, prints and exits as before, and drains analytics once', async () => {
    const arms = await onAndOff(
      daemonHost(async () => {
        throw new Error('fixture daemon failure')
      }),
    )

    expect(arms.on.exitCode).toBe(1)
    expect(arms.on.printed).toContain('Daemon error: fixture daemon failure')
    expect(reportedErrors(arms.on.sent)).toEqual(['fixture daemon failure'])
    for (const run of [arms.on, arms.off]) {
      expect(run.steps).toEqual([...DRAINED, ...SETTLED])
      expectAnalyticsHandedOverOnce(run)
    }
    expectReportingOffChangesNothingElse(arms)
  })

  it('ends with the code its host returns, reports nothing and drains analytics once', async () => {
    const arms = await onAndOff(daemonHost(async () => 3))

    for (const run of [arms.on, arms.off]) {
      expect(run.exitCode).toBe(3)
      expect(run.steps).toEqual([...DRAINED, ...SETTLED])
      expectAnalyticsHandedOverOnce(run)
    }
    expect(commandSpans(arms.on.sent)).toHaveLength(1)
    expect(reportedErrors(arms.on.sent)).toEqual([])
    expect(arms.off.sent).toEqual([])
  })
})

function chatHost(deps: ChatCommandDeps, typed: readonly string[] = []): HostFactory {
  return (exit) => {
    const input = new PassThrough()
    const output = new PassThrough()
    output.resume()
    return {
      command: createChatCommand({ input, output, onInterruptHandler: () => {}, exit, ...deps }),
      args: ['chat'],
      meanwhile: async () => {
        // A tick first, so no line reaches a readline that does not exist yet.
        await Promise.resolve()
        for (const line of typed) input.write(`${line}\n`)
        input.end()
      },
    }
  }
}

// A file where the sessions folder belongs, so a turn cannot open its session.
function sessionsFolderIsAFile(project: ReportProject): void {
  mkdirSync(join(project.dir, '.agent-qa'), { recursive: true })
  writeFileSync(join(project.dir, '.agent-qa', 'sessions'), 'not a folder\n', 'utf8')
}

describe('agent-qa chat', () => {
  it('reports a session that fails at the top level, and prints and exits as before', async () => {
    const arms = await onAndOff(
      chatHost({
        chatCapabilities: async () => {
          throw new Error('fixture chat failure')
        },
      }),
    )

    expect(arms.on.exitCode).toBe(1)
    expect(arms.on.printed).toContain('Chat error [Error]: fixture chat failure')
    expect(reportedErrors(arms.on.sent)).toEqual(['fixture chat failure'])
    for (const run of [arms.on, arms.off]) {
      expect(run.steps).toEqual([...DRAINED, ...SETTLED])
      expectAnalyticsHandedOverOnce(run)
    }
    expectReportingOffChangesNothingElse(arms)
  })

  it('reports nothing for a turn that fails inside a session, which goes on', async () => {
    const arms = await onAndOff(
      chatHost({ chatCapabilities: async () => undefined }, ['list the runs']),
      sessionsFolderIsAFile,
    )

    expect(arms.on.exitCode).toBeUndefined()
    expect(arms.on.printed.some((line) => line.startsWith('Chat error ['))).toBe(true)
    expect(reportedErrors(arms.on.sent)).toEqual([])
    for (const run of [arms.on, arms.off]) {
      expect(run.steps).toEqual([...DRAINED, ...SETTLED])
      expectAnalyticsHandedOverOnce(run)
    }
    expectReportingOffChangesNothingElse(arms)
  })

  it('reports nothing for Ctrl-C at the prompt, which exits 130', async () => {
    const arms = await onAndOff(
      chatHost({ terminal: true, chatCapabilities: async () => undefined }, ['\x03']),
    )

    expect(arms.on.exitCode).toBe(130)
    expect(arms.on.printed).toContain('Cancelled.')
    expect(reportedErrors(arms.on.sent)).toEqual([])
    for (const run of [arms.on, arms.off]) {
      expect(run.steps).toEqual([...DRAINED, ...SETTLED])
      expectAnalyticsHandedOverOnce(run)
    }
    expectReportingOffChangesNothingElse(arms)
  })
})

describe('agent-qa init', () => {
  it('hands the analytics host it composed to the settle step once', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-qa-host-failures-init-'))
    const home = mkdtempSync(join(tmpdir(), 'agent-qa-host-failures-home-'))
    scratch.push(dir, home)
    mkdirSync(join(dir, '.git'))
    const quiet = [
      vi.spyOn(console, 'log').mockImplementation(() => {}),
      vi.spyOn(console, 'error').mockImplementation(() => {}),
    ]
    process.exitCode = undefined
    try {
      const program = new Command().option('--config <path>').exitOverride()
      program.addCommand(
        createInitCommand({
          cwd: dir,
          chromium: () => ({ found: true, path: '/fake/chromium' }),
          latestVersion: async () => ({ source: 'none' }),
          host: { homedir: home, env: {}, run: fakeRunner() },
        }),
      )
      await program.parseAsync(['node', 'agent-qa', 'init', '--platform', 'web', '--pm', 'none'])
      expect(process.exitCode ?? 0).toBe(0)
    } finally {
      for (const spy of quiet) spy.mockRestore()
    }

    expect(steps).toEqual(DRAINED)
    expect(handedOver).toHaveLength(1)
    expect(handedOver[0]).toBe(composed[0])
  })
})

describe('agent-qa dashboard and agent-qa serve', () => {
  // The project names a hooks file it never wrote, which the server refuses before it starts.
  const missingHooks =
    'Configured workspace file not found: workspace.hooksFile -> <project>/hooks.yaml'

  it.each([
    { label: 'Dashboard', create: () => createDashboardCommand() },
    { label: 'Serve', create: () => createServeCommand() },
  ])('report a $label start that fails, and exit 2 only after the settle step', async (host) => {
    const arms = await onAndOff(() => {
      const command = host.create()
      return { command, args: [command.name()] }
    })

    expect(arms.on.exits).toEqual([2])
    expect(arms.on.printed).toContain(`${host.label} error: ${missingHooks}`)
    expect(withoutFolder(reportedErrors(arms.on.sent), arms.on.dir)).toEqual([missingHooks])
    expect(untilTheFirstExit(arms.on.steps)).toEqual([...SETTLED, 'exit 2'])
    expectReportingOffChangesNothingElse(arms)
  })
})

describe('exitAfterSettling', () => {
  it('exits once with its code, and only once the settle step has finished', async () => {
    let finish: () => void = () => {}
    vi.mocked(errorReporting.settleReporting).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
        }),
    )
    const exits: number[] = []

    const exiting = exitAfterSettling(2, (code) => {
      exits.push(code)
    })
    await new Promise((resolve) => setImmediate(resolve))
    expect(exits).toEqual([])
    finish()
    await exiting

    expect(exits).toEqual([2])
  })

  it('still exits once with its code when the settle step rejects', async () => {
    vi.mocked(errorReporting.settleReporting).mockRejectedValueOnce(new Error('settle failed'))
    const exits: number[] = []

    await exitAfterSettling(2, (code) => {
      exits.push(code)
    }).catch(() => undefined)

    expect(exits).toEqual([2])
  })
})

interface CanaryHost {
  readonly name: string
  // The host, failing at its top level with the error it is handed.
  readonly failingWith: (error: Error) => HostFactory
}

const CANARY_HOSTS: readonly CanaryHost[] = [
  {
    name: 'agent-qa mcp',
    failingWith: (error) => (exit) => ({
      command: createMcpCommand({
        composeAnalytics: async () => {
          throw error
        },
        exit,
      }),
      args: ['mcp'],
    }),
  },
  {
    name: 'agent-qa daemon',
    failingWith: (error) =>
      daemonHost(async () => {
        throw error
      }),
  },
  {
    name: 'agent-qa chat',
    failingWith: (error) =>
      chatHost({
        chatCapabilities: async () => {
          throw error
        },
      }),
  },
  {
    name: 'agent-qa dashboard',
    failingWith: (error) => () => {
      vi.spyOn(config, 'resolveConfig').mockRejectedValueOnce(error)
      return { command: createDashboardCommand(), args: ['dashboard'] }
    },
  },
]

interface HostReport {
  readonly command: string
  readonly envelopes: readonly RecordedEnvelope[]
}

// The host fails with the canary error under runCli while the reporter decides from the canary
// project, its home and its environment, and a line quoting the canaries is printed just before
// the host starts.
async function reportFromHost(host: CanaryHost): Promise<HostReport> {
  const project = canaryProject()
  const recorder = recordingReportTransport()
  const exit = (): void => {}
  const { command, args, meanwhile } = host.failingWith(canaryError(project))(exit)
  await startCanaryReporting(project, recorder, command.name())
  console.error(canaryLine(project))
  const quiet = [
    vi.spyOn(console, 'log').mockImplementation(() => {}),
    vi.spyOn(console, 'warn').mockImplementation(() => {}),
    vi.spyOn(console, 'error').mockImplementation(() => {}),
    vi.spyOn(process, 'exit').mockImplementation((() => {}) as typeof process.exit),
  ]
  try {
    const program = new Command().name('agent-qa').option('--config <path>').exitOverride()
    program.addCommand(command)
    const argv = ['node', 'agent-qa', '--config', project.configPath, ...args]
    const running = runCli(program, argv, { ...defaultCliFailureDeps(program), exit })
    await meanwhile?.()
    await running
  } finally {
    for (const spy of quiet) spy.mockRestore()
  }
  await closeErrorReporting()
  return { command: command.name(), envelopes: recorder.envelopes }
}

describe('what a report of a host failure leaves out and keeps', () => {
  it.each(CANARY_HOSTS)(
    '$name sends no secret, Basic value, env value, hostname or home folder name',
    async (host) => {
      expectNoCanary((await reportFromHost(host)).envelopes)
    },
  )

  it.each(CANARY_HOSTS)(
    '$name still sends the message, both stacks, the line printed before and the command',
    async (host) => {
      const report = await reportFromHost(host)
      expectUsefulReport(report.envelopes, report.command)
    },
  )
})
