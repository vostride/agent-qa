// Each error that ends agent-qa run reaches the error reporter through a recording transport, and
// the same run with reporting off prints the same lines and exits the same way.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { generateRunId } from '@vostride/agent-qa-ids'
import { RUNS_SUBDIR, slugBranch } from '@vostride/agent-qa-runner-local'
import { WebPlatformAdapter } from '@vostride/agent-qa-web'
import { Command } from 'commander'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { createRunCommand } from '../commands/run.js'
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

beforeAll(() => {
  pinnedTmpdir = pinProcessTmpdir()
})
// No cell reads the auth store in the real home folder.
beforeEach(() => {
  const authDir = mkdtempSync(join(tmpdir(), 'agent-qa-run-errors-auth-'))
  authDirs.push(authDir)
  vi.stubEnv('XDG_DATA_HOME', authDir)
  exitCodeBefore = process.exitCode
})
afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  await closeErrorReporting()
  removeReportProjects()
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
}

// The mocked exit throws, so the action stops where a real exit would end the process.
async function invokeRun(project: InProcessFixture, args: readonly string[]): Promise<Invocation> {
  const exits: unknown[] = []
  const printed: string[] = []
  const keep = (...parts: unknown[]): void => {
    if (exits.length === 0) printed.push(...plain(parts.map(String).join(' ')).split('\n'))
  }
  const spies = [
    vi.spyOn(console, 'log').mockImplementation(keep),
    vi.spyOn(console, 'warn').mockImplementation(keep),
    vi.spyOn(console, 'error').mockImplementation(keep),
    vi.spyOn(process, 'exit').mockImplementation((code) => {
      exits.push(code)
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
  return { exits, printed }
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
  const invocation = await invokeRun(project, args)
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

// The run's own handlers, called the way a first Ctrl-C reaches them, before the run's session
// exists, so a refusal that follows reaches the catch as the refusal of a cancelled run.
function stopEachRunBeforeItStarts(): void {
  const before = new Set(process.listeners('SIGINT'))
  const actual = drive.runInProcessCliRun
  vi.spyOn(drive, 'runInProcessCliRun').mockImplementation(async (input, request) => {
    for (const handler of process.listeners('SIGINT')) {
      if (!before.has(handler)) handler('SIGINT')
    }
    return await actual(input, request)
  })
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
