// Each error that ends agent-qa run reaches the error reporter through a recording transport, and
// the same run with reporting off prints the same lines and exits the same way. Every exit of the
// run action but a forced one settles the reporter and analytics first.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { generateRunId } from '@vostride/agent-qa-ids'
import { pluginMaskName } from '@vostride/agent-qa-runner'
import { RUNS_SUBDIR, slugBranch } from '@vostride/agent-qa-runner-local'
import { WebPlatformAdapter } from '@vostride/agent-qa-web'
import { Command } from 'commander'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { createRunCommand } from '../commands/run.js'
import * as analyticsHost from '../composition/analytics-host.js'
import * as errorReporting from '../composition/error-reporting.js'
import {
  closeErrorReporting,
  settleReporting,
  startErrorReporting,
} from '../composition/error-reporting.js'
import * as drive from '../composition/in-process-run-execution.js'
import {
  CountingTarget,
  createInProcessFixture,
  freshUpdateCheckHome,
  PLANTED_SECRET_NAME,
  removeInProcessFixtures,
} from '../composition/__tests__/in-process-run-fixture.js'
import type {
  InProcessFixture,
  InProcessFixtureInput,
} from '../composition/__tests__/in-process-run-fixture.js'
import { startRemoteBrowserEndpoint } from '../composition/__tests__/remote-browser-endpoint.js'
import {
  canaryError,
  canaryLine,
  canaryProject,
  expectNoCanary,
  expectUsefulReport,
  pluginAnswerCanary,
  removeCanaryProjects,
  startCanaryReporting,
} from './error-report-canaries.js'
import {
  projectWithPrivacy,
  recordingReportTransport,
  removeReportProjects,
  serializedEnvelopes,
} from './error-report-recorder.js'
import type { RecordedEnvelope, RecordingReportTransport } from './error-report-recorder.js'
import { pinProcessTmpdir, removeTempRoots } from './temp-roots.js'
import type { PinnedTmpdir } from './temp-roots.js'

const RUN_BUDGET_MS = 180_000
const INVENTED_DSN = 'http://key@127.0.0.1:9/1'
const EXIT_MARKER = 'fixture command exit'
const RUN_SECRET = 'Hunter-42-zz-run-secret'
const NEVER_SENT_HEADER = ['authorization', 'Bearer never-sent'] as const

let pinnedTmpdir: PinnedTmpdir | undefined
const authDirs: string[] = []
let exitCodeBefore: typeof process.exitCode
// Exits, settles and analytics shutdowns, in the order the run action reached them.
const order: string[] = []

beforeAll(() => {
  pinnedTmpdir = pinProcessTmpdir()
})
// No cell reads the auth store in the real home folder.
beforeEach(() => {
  const authDir = mkdtempSync(join(tmpdir(), 'agent-qa-run-errors-auth-'))
  authDirs.push(authDir)
  vi.stubEnv('XDG_DATA_HOME', authDir)
  exitCodeBefore = process.exitCode
  order.length = 0
})
afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  await closeErrorReporting()
  removeReportProjects()
  removeCanaryProjects()
  for (const dir of authDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  // A first stop signal sets the exit code of the process the cells run in.
  process.exitCode = exitCodeBefore
})
afterAll(() => {
  removeInProcessFixtures()
  pinnedTmpdir?.restore()
  if (pinnedTmpdir !== undefined) removeTempRoots([pinnedTmpdir.root])
})

function plain(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, '')
}

interface ProjectOptions {
  readonly knobs?: Partial<InProcessFixtureInput>
  // The config picks a remote that answers every connect 401, as its header is never sent.
  readonly refusingRemote?: boolean
}

interface Scene {
  readonly project: InProcessFixture
  readonly remoteUrl?: string
}

async function onProject(
  options: ProjectOptions,
  use: (scene: Scene) => Promise<void>,
): Promise<void> {
  const target = new CountingTarget()
  await target.listen()
  try {
    const endpoint =
      options.refusingRemote === true
        ? await startRemoteBrowserEndpoint({ requireHeader: NEVER_SENT_HEADER })
        : undefined
    try {
      const remote =
        endpoint === undefined
          ? undefined
          : { name: 'grid', protocol: 'playwright' as const, url: endpoint.wsEndpoint }
      const project = createInProcessFixture({
        origin: target.origin,
        environment: 'local',
        ...(remote === undefined ? {} : { remote }),
        ...options.knobs,
      })
      vi.stubEnv('HOME', freshUpdateCheckHome())
      await use({ project, ...(endpoint === undefined ? {} : { remoteUrl: endpoint.wsEndpoint }) })
    } finally {
      await endpoint?.close()
    }
  } finally {
    await target.close()
  }
}

interface Invocation {
  readonly exits: readonly unknown[]
  // Every console line up to the first exit, which a real exit would end the process at.
  readonly printed: readonly string[]
  // What the reporter had sent when the first exit ran.
  readonly sentAtExit: readonly RecordedEnvelope[]
}

// The mocked exit throws, so the action stops where a real exit would end the process. A throw
// from inside the action's try lands in its catch, which a real exit never reaches, so a cell reads
// what happened before the first exit.
async function invokeRun(
  project: InProcessFixture,
  args: readonly string[],
  recorder: RecordingReportTransport,
): Promise<Invocation> {
  const exits: unknown[] = []
  const printed: string[] = []
  const before = recorder.envelopes.length
  let sentAtExit: RecordedEnvelope[] = []
  const keep = (...parts: unknown[]): void => {
    if (exits.length === 0) printed.push(...plain(parts.map(String).join(' ')).split('\n'))
  }
  const spies = [
    vi.spyOn(console, 'log').mockImplementation(keep),
    vi.spyOn(console, 'warn').mockImplementation(keep),
    vi.spyOn(console, 'error').mockImplementation(keep),
    vi.spyOn(process, 'exit').mockImplementation((code) => {
      if (exits.length === 0) sentAtExit = recorder.envelopes.slice(before)
      exits.push(code)
      order.push(`exit ${String(code)}`)
      throw new Error(EXIT_MARKER)
    }),
  ]
  try {
    const program = new Command().option('--config <path>').addCommand(createRunCommand())
    await expect(
      program.parseAsync(['--config', project.configPath, 'run', ...args], { from: 'user' }),
    ).rejects.toThrow(EXIT_MARKER)
  } finally {
    for (const spy of spies) spy.mockRestore()
  }
  return { exits, printed, sentAtExit }
}

interface Arm extends Invocation {
  readonly envelopes: readonly RecordedEnvelope[]
}

// Reporting is decided from a project of its own, so only the run itself can mask the run's
// secrets. The command span stands in for the one the CLI's starter opens before the action.
async function runWithReporting(
  reporting: 'on' | 'off',
  recorder: RecordingReportTransport,
  project: InProcessFixture,
  args: readonly string[],
): Promise<Arm> {
  const before = recorder.envelopes.length
  const reporter = await startErrorReporting({
    configPath: projectWithPrivacy(reporting === 'off' ? { privacy: true } : {}).configPath,
    dsn: INVENTED_DSN,
    transport: recorder.transport,
  })
  expect(reporter !== undefined, `reporting ${reporting}`).toBe(reporting === 'on')
  reporter?.beginCommandSpan('run', [])
  const invocation = await invokeRun(project, args, recorder)
  await settleReporting()
  await closeErrorReporting()
  return { ...invocation, envelopes: recorder.envelopes.slice(before) }
}

// Both arms send through one recorder, so a recorder off the send path cannot pass the off arm.
async function onAndOff(
  project: InProcessFixture,
  args: readonly string[],
): Promise<{ readonly on: Arm; readonly off: Arm }> {
  const recorder = recordingReportTransport()
  const on = await runWithReporting('on', recorder, project, args)
  const off = await runWithReporting('off', recorder, project, args)
  return { on, off }
}

interface ReportedError {
  readonly exception?: {
    readonly values?: ReadonlyArray<{ readonly type?: string; readonly value?: string }>
  }
}

interface ReportedSpan {
  readonly attributes?: Readonly<Record<string, { readonly value?: unknown }>>
}

type EnvelopeItems = Array<[unknown, Array<[{ readonly type?: string }, unknown]>]>

function itemsOf(envelopes: readonly RecordedEnvelope[], type: string): unknown[] {
  return (JSON.parse(serializedEnvelopes(envelopes)) as EnvelopeItems)
    .flatMap(([, items]) => items)
    .filter(([header]) => header.type === type)
    .map(([, payload]) => payload)
}

function reportedErrors(envelopes: readonly RecordedEnvelope[]): ReportedError[] {
  return itemsOf(envelopes, 'event') as ReportedError[]
}

function commandSpans(envelopes: readonly RecordedEnvelope[]): ReportedSpan[] {
  return (itemsOf(envelopes, 'span') as Array<{ readonly items?: ReportedSpan[] }>)
    .flatMap((payload) => payload.items ?? [])
    .filter((span) => span.attributes?.['sentry.op']?.value === 'agent_qa.command')
}

function messagesOf(error: ReportedError | undefined): string {
  return (error?.exception?.values ?? []).map((value) => value.value ?? '').join('\n')
}

// Each run mints its own id, so two runs print the same lines apart from it.
function withoutRunIds(lines: readonly string[]): string[] {
  return lines.map((line) => line.replace(/\br_[a-z0-9-]+/g, 'r_<id>'))
}

function expectReportingOffChangesNothingElse(arms: { readonly on: Arm; readonly off: Arm }): void {
  expect(commandSpans(arms.on.envelopes), 'the on arm sent its command span').toHaveLength(1)
  expect(arms.off.envelopes).toEqual([])
  expect(arms.off.exits).toEqual(arms.on.exits)
  expect(arms.on.printed.join('\n').trim(), 'the run printed nothing').not.toBe('')
  expect(withoutRunIds(arms.off.printed)).toEqual(withoutRunIds(arms.on.printed))
}

function failEveryLaunchWith(error: Error): void {
  vi.spyOn(WebPlatformAdapter.prototype, 'setup').mockRejectedValue(error)
}

// Calls the handlers the run added the way a Ctrl-C reaches them.
function signalTheRun(before: ReadonlySet<unknown>): void {
  for (const handler of process.listeners('SIGINT')) {
    if (!before.has(handler)) handler('SIGINT')
  }
}

// Stop signals that land before the run's session exists. After one, a refusal that follows
// reaches the catch as the refusal of a cancelled run; a second forces the exit.
function stopEachRunBeforeItStarts(signals: 1 | 2 = 1): void {
  const before = new Set<unknown>(process.listeners('SIGINT'))
  const actual = drive.runInProcessCliRun
  vi.spyOn(drive, 'runInProcessCliRun').mockImplementation(async (input, request) => {
    for (let sent = 0; sent < signals; sent += 1) signalTheRun(before)
    return await actual(input, request)
  })
}

// A stop signal that lands as the test's browser starts, so the run's session is cancelled.
function stopEachRunAsItsBrowserStarts(): void {
  const before = new Set<unknown>(process.listeners('SIGINT'))
  vi.spyOn(WebPlatformAdapter.prototype, 'setup').mockImplementation(async () => {
    signalTheRun(before)
    throw new Error('the browser start was stopped')
  })
}

// The settle step and the analytics shutdown, logged beside the exits as they start and end.
function observeSettles(): void {
  const settle = errorReporting.settleReporting
  vi.spyOn(errorReporting, 'settleReporting').mockImplementation(async (input) => {
    order.push(input?.analytics === undefined ? 'settle' : 'settle with analytics')
    await settle(input)
    order.push('settled')
  })
  const compose = analyticsHost.composeAnalyticsHost
  vi.spyOn(analyticsHost, 'composeAnalyticsHost').mockImplementation(async (input) => {
    const host = await compose(input)
    const shutdown = host.shutdown.bind(host)
    vi.spyOn(host, 'shutdown').mockImplementation(async () => {
      order.push('analytics shutdown')
      await shutdown()
      order.push('analytics shut down')
    })
    return host
  })
}

function untilTheFirstExit(log: readonly string[]): string[] {
  return log.slice(0, log.findIndex((entry) => entry.startsWith('exit ')) + 1)
}

interface ExitCase {
  readonly options?: ProjectOptions
  readonly arrange?: (scene: Scene) => void
  readonly args: (project: InProcessFixture) => readonly string[]
  readonly code: number
  // Whether the exit reports the error that ended the run.
  readonly reports: boolean
  // Whether the run composed analytics before it ended, so there is a shutdown to settle.
  readonly analytics: boolean
}

// Both arms settle once, wholly, before the exit; with reporting on, the report and the command
// span have been sent by then, and with it off nothing is.
async function expectOneSettleBeforeTheExit(exitCase: ExitCase): Promise<void> {
  await onProject(exitCase.options ?? {}, async (scene) => {
    exitCase.arrange?.(scene)
    observeSettles()
    const recorder = recordingReportTransport()
    const settled = exitCase.analytics
      ? ['settle with analytics', 'analytics shutdown', 'analytics shut down', 'settled']
      : ['settle', 'settled']
    for (const reporting of ['on', 'off'] as const) {
      order.length = 0
      const args = exitCase.args(scene.project)
      const run = await runWithReporting(reporting, recorder, scene.project, args)

      expect(run.exits[0], `reporting ${reporting}`).toBe(exitCase.code)
      expect(untilTheFirstExit(order), `reporting ${reporting}`).toEqual([
        ...settled,
        `exit ${exitCase.code}`,
      ])
      if (reporting === 'on') {
        expect(commandSpans(run.sentAtExit), 'sent before the exit').toHaveLength(1)
        expect(reportedErrors(run.sentAtExit)).toHaveLength(exitCase.reports ? 1 : 0)
      } else {
        expect(run.sentAtExit).toEqual([])
      }
    }
  })
}

function writeAnUnparsableTest({ project }: Scene): void {
  writeFileSync(join(project.project, project.testPattern), 'name: [an unclosed list\nsteps:\n')
}

function refusalSentence(scene: Scene): string {
  const { port } = new URL(scene.remoteUrl ?? 'ws://127.0.0.1')
  return `Remote grid (playwright ws://127.0.0.1:${port}) refused the credentials.`
}

describe('an error that ends agent-qa run is reported once, and reporting off changes nothing else', () => {
  it("reports an input refusal with its lines, and exits with the refusal's own code", async () => {
    await onProject({ knobs: { omitEnvFile: true } }, async ({ project }) => {
      const arms = await onAndOff(project, [project.testPattern])

      expect(arms.on.exits).toEqual([1])
      const errors = reportedErrors(arms.on.envelopes)
      expect(errors).toHaveLength(1)
      expect(messagesOf(errors[0])).toContain(
        `Error: Env file not found: ${join(project.project, '.env')}`,
      )
      expectReportingOffChangesNothingElse(arms)
    })
  }, RUN_BUDGET_MS)

  it('reports a run id agent-qa did not mint, and exits 2', async () => {
    await onProject({}, async ({ project }) => {
      vi.stubEnv('AGENT_QA_RUN_ID', 'not-a-minted-id')

      const arms = await onAndOff(project, [project.testPattern])

      expect(arms.on.exits).toEqual([2])
      const errors = reportedErrors(arms.on.envelopes)
      expect(errors).toHaveLength(1)
      expect(messagesOf(errors[0])).toContain('cannot start a run under "not-a-minted-id"')
      expectReportingOffChangesNothingElse(arms)
    })
  }, RUN_BUDGET_MS)

  it('reports a run id that already names a run, and exits 2', async () => {
    await onProject({}, async ({ project }) => {
      const runId = generateRunId()
      mkdirSync(join(project.agentQaRoot, RUNS_SUBDIR, slugBranch(runId)), { recursive: true })
      vi.stubEnv('AGENT_QA_RUN_ID', runId)

      const arms = await onAndOff(project, [project.testPattern])

      expect(arms.on.exits).toEqual([2])
      const errors = reportedErrors(arms.on.envelopes)
      expect(errors).toHaveLength(1)
      expect(messagesOf(errors[0])).toContain('that id already names a run in this project')
      expectReportingOffChangesNothingElse(arms)
    })
  }, RUN_BUDGET_MS)

  it('reports a runs database it cannot open, and exits 2', async () => {
    await onProject({}, async ({ project }) => {
      const dbPath = join(project.agentQaRoot, 'runs.db')
      mkdirSync(project.agentQaRoot, { recursive: true })
      const notADatabase = 'this is not a database, it is a sentence that fills a page\n'
      writeFileSync(dbPath, notADatabase.repeat(20))

      const arms = await onAndOff(project, [project.testPattern])

      expect(arms.on.exits).toEqual([2])
      const errors = reportedErrors(arms.on.envelopes)
      expect(errors).toHaveLength(1)
      expect(messagesOf(errors[0])).toContain(
        `agent-qa could not open the runs database at ${dbPath}, so the run was not started`,
      )
      expectReportingOffChangesNothingElse(arms)
    })
  }, RUN_BUDGET_MS)

  it('reports a remote that refuses before its test starts, and exits 2', async () => {
    await onProject({ refusingRemote: true }, async (scene) => {
      const { project } = scene
      const arms = await onAndOff(project, [project.testPattern])

      expect(arms.on.exits).toEqual([2])
      const errors = reportedErrors(arms.on.envelopes)
      expect(errors).toHaveLength(1)
      expect(messagesOf(errors[0])).toContain(refusalSentence(scene))
      expectReportingOffChangesNothingElse(arms)
    })
  }, RUN_BUDGET_MS)

  it('reports any other error that ends the run with its message, and exits 2', async () => {
    await onProject({}, async ({ project }) => {
      failEveryLaunchWith(new Error('fixture launch failure'))

      const arms = await onAndOff(project, [project.testPattern])

      expect(arms.on.exits).toEqual([2])
      const errors = reportedErrors(arms.on.envelopes)
      expect(errors).toHaveLength(1)
      expect(messagesOf(errors[0])).toBe('fixture launch failure')
      expectReportingOffChangesNothingElse(arms)
    })
  }, RUN_BUDGET_MS)

  it('reports nothing for a remote refusal that follows a stop signal, and exits 130', async () => {
    await onProject({ refusingRemote: true }, async ({ project }) => {
      vi.stubEnv('AGENT_QA_CANCEL_GRACE_MS', '600000')
      stopEachRunBeforeItStarts()

      const arms = await onAndOff(project, [project.testPattern])

      expect(arms.on.exits).toEqual([130])
      expect(reportedErrors(arms.on.envelopes)).toEqual([])
      expectReportingOffChangesNothingElse(arms)
    })
  }, RUN_BUDGET_MS)

  it('masks a secret the run loaded where the error it reports quotes it', async () => {
    await onProject({ knobs: { plantedSecret: RUN_SECRET } }, async ({ project }) => {
      failEveryLaunchWith(new Error(`the browser would not start with ${RUN_SECRET}`))

      const on = await runWithReporting('on', recordingReportTransport(), project, [
        project.testPattern,
      ])

      expect(on.exits).toEqual([2])
      const errors = reportedErrors(on.envelopes)
      expect(errors).toHaveLength(1)
      expect(messagesOf(errors[0])).toBe(
        `the browser would not start with [secret:${PLANTED_SECRET_NAME}]`,
      )
      expect(serializedEnvelopes(on.envelopes)).not.toContain(RUN_SECRET)
    })
  }, RUN_BUDGET_MS)
})

const testPattern = (project: InProcessFixture): readonly string[] => [project.testPattern]

const EXIT_CASES: ReadonlyArray<ExitCase & { readonly name: string }> = [
  {
    name: 'an input refusal, exit 1',
    options: { knobs: { omitEnvFile: true } },
    args: testPattern,
    code: 1,
    reports: true,
    analytics: false,
  },
  {
    name: 'a run id agent-qa did not mint, exit 2',
    arrange: () => vi.stubEnv('AGENT_QA_RUN_ID', 'not-a-minted-id'),
    args: testPattern,
    code: 2,
    reports: true,
    analytics: true,
  },
  {
    name: 'a run id that already names a run, exit 2',
    arrange: ({ project }) => {
      const runId = generateRunId()
      mkdirSync(join(project.agentQaRoot, RUNS_SUBDIR, slugBranch(runId)), { recursive: true })
      vi.stubEnv('AGENT_QA_RUN_ID', runId)
    },
    args: testPattern,
    code: 2,
    reports: true,
    analytics: true,
  },
  {
    name: 'a runs database it cannot open, exit 2',
    arrange: ({ project }) => {
      mkdirSync(project.agentQaRoot, { recursive: true })
      writeFileSync(join(project.agentQaRoot, 'runs.db'), 'not a database\n'.repeat(80))
    },
    args: testPattern,
    code: 2,
    reports: true,
    analytics: true,
  },
  {
    name: 'a remote refusal, exit 2',
    options: { refusingRemote: true },
    args: testPattern,
    code: 2,
    reports: true,
    analytics: true,
  },
  {
    name: 'a remote refusal after a stop signal, exit 130',
    options: { refusingRemote: true },
    arrange: () => {
      vi.stubEnv('AGENT_QA_CANCEL_GRACE_MS', '600000')
      stopEachRunBeforeItStarts()
    },
    args: testPattern,
    code: 130,
    reports: false,
    analytics: true,
  },
  {
    name: 'any other error, exit 2',
    arrange: () => failEveryLaunchWith(new Error('fixture launch failure')),
    args: testPattern,
    code: 2,
    reports: true,
    analytics: true,
  },
  {
    name: 'a suite run alone, exit 2 for its refused remote',
    options: { refusingRemote: true },
    args: (project) => [project.suitePattern],
    code: 2,
    reports: false,
    analytics: true,
  },
  {
    name: '--list-tests, exit 0',
    args: () => ['--list-tests'],
    code: 0,
    reports: false,
    analytics: false,
  },
  {
    name: '--dry-run, exit 0',
    args: (project) => ['--dry-run', project.testPattern],
    code: 0,
    reports: false,
    analytics: false,
  },
  {
    name: 'a test that does not parse, exit 2',
    arrange: writeAnUnparsableTest,
    args: testPattern,
    code: 2,
    reports: false,
    analytics: false,
  },
  {
    name: 'mutually exclusive mode flags, exit 1',
    args: () => ['--test', '--suite'],
    code: 1,
    reports: false,
    analytics: false,
  },
]

describe('agent-qa run settles once before it exits', () => {
  it.each(EXIT_CASES)('for $name', async (exitCase) => {
    await expectOneSettleBeforeTheExit(exitCase)
  }, RUN_BUDGET_MS)
})

describe('a failed test and a cancelled run are not errors', () => {
  it('a run whose test fails exits 1 having sent its spans, and reports nothing', async () => {
    await expectOneSettleBeforeTheExit({
      // The model is unreachable, so the test fails at planning; --detach skips the curation tail.
      args: (project) => [project.testPattern, '--detach'],
      code: 1,
      reports: false,
      analytics: true,
    })
  }, RUN_BUDGET_MS)

  it('a run cancelled by a stop signal exits 130 having sent its spans, and reports nothing', async () => {
    await expectOneSettleBeforeTheExit({
      arrange: () => {
        vi.stubEnv('AGENT_QA_CANCEL_GRACE_MS', '600000')
        stopEachRunAsItsBrowserStarts()
      },
      args: testPattern,
      code: 130,
      reports: false,
      analytics: true,
    })
  }, RUN_BUDGET_MS)
})

describe('a second stop signal', () => {
  it.each(['test', 'suite'] as const)(
    'ends a %s run at once with exit 130, settling nothing first',
    async (kind) => {
      await onProject({}, async ({ project }) => {
        vi.stubEnv('AGENT_QA_CANCEL_GRACE_MS', '600000')
        observeSettles()
        stopEachRunBeforeItStarts(2)

        const run = await runWithReporting('on', recordingReportTransport(), project, [
          kind === 'test' ? project.testPattern : project.suitePattern,
        ])

        expect(run.exits[0]).toBe(130)
        expect(untilTheFirstExit(order)).toEqual(['exit 130'])
        expect(run.sentAtExit).toEqual([])
      })
    },
    RUN_BUDGET_MS,
  )
})

describe("what a report from run's outer catch leaves out and keeps", () => {
  // The run's browser fails to start with the canary error while the reporter decides from the
  // canary project, its home and its environment, and a line quoting the canaries is printed
  // just before the run.
  async function reportFromRun(): Promise<readonly RecordedEnvelope[]> {
    const canaries = canaryProject()
    const recorder = recordingReportTransport()
    await onProject({}, async ({ project }) => {
      failEveryLaunchWith(canaryError(canaries))
      await startCanaryReporting(canaries, recorder, 'run')
      console.error(canaryLine(canaries))
      const run = await invokeRun(project, [project.testPattern], recorder)
      expect(run.exits).toEqual([2])
      await closeErrorReporting()
    })
    return recorder.envelopes
  }

  it('sends no secret, Basic value, env value, hostname or home folder name', async () => {
    expectNoCanary(await reportFromRun())
  }, RUN_BUDGET_MS)

  it('still sends the message, both stacks, the line printed before and the command', async () => {
    expectUsefulReport(await reportFromRun(), 'run')
  }, RUN_BUDGET_MS)
})

// A run's redactor learns a plugin's answer the way the run's plugin host teaches it, and the run
// binds that redactor on the reporter.
describe('a connection URL a remote plugin answered for a run', () => {
  it('stays out of a report made while the run is bound and of one made just after it ended', async () => {
    const project = canaryProject()
    const recorder = recordingReportTransport()
    const reporter = await startCanaryReporting(project, recorder, 'run')
    const answer = pluginAnswerCanary(project)
    const unbind = reporter.bindMask((text) => answer.redactor.redactString(text))

    reporter.capture(
      new Error(`the session at ${answer.url} closed`, {
        cause: new Error(`no answer came from ${answer.url}`),
      }),
    )
    unbind()
    reporter.capture(new Error(`the next session reused ${answer.url}`))
    await settleReporting()

    const masked = `[secret:${pluginMaskName('lab')}]`
    expect(reportedErrors(recorder.envelopes).map(messagesOf).sort()).toEqual([
      `no answer came from ${masked}\nthe session at ${masked} closed`,
      `the next session reused ${masked}`,
    ])
    expectNoCanary(recorder.envelopes)
  })

  it('stays out of a report made while two runs were bound and sent after both ended', async () => {
    const project = canaryProject()
    const recorder = recordingReportTransport()
    const reporter = await startCanaryReporting(project, recorder, 'mcp')
    const first = pluginAnswerCanary(project, 'lab')
    const second = pluginAnswerCanary(project, 'farm')
    const unbindFirst = reporter.bindMask((text) => first.redactor.redactString(text))
    const unbindSecond = reporter.bindMask((text) => second.redactor.redactString(text))

    reporter.capture(new Error(`two sessions closed: ${first.url} and ${second.url}`))
    unbindFirst()
    unbindSecond()
    await settleReporting()

    const [lab, farm] = ['lab', 'farm'].map((entry) => `[secret:${pluginMaskName(entry)}]`)
    expect(reportedErrors(recorder.envelopes).map(messagesOf)).toEqual([
      `two sessions closed: ${lab} and ${farm}`,
    ])
    expectNoCanary(recorder.envelopes)
  })
})
