// The daemon dispatches runs through the ONE in-process core (Phase 401 plan 06, INVK-02).
//
// WHAT THESE CELLS ARE ABOUT. The daemon used to answer `runs.start` by spawning a piped
// `agent-qa run` child, tee-ing its stdout/stderr into two files beside the run and recording the
// child's exit code. Three facts change with that retirement and each one needs saying out loud:
//
//   1. THE POSTURE IS CARRIED, NOT SNIFFED (D-07). The daemon hands the drive an EXPLICIT
//      `local-headless` and no confirm port, so ask-tier work with no credential fails closed BY
//      CONSTRUCTION. (Nothing asks now: the carried posture is what the ack reports, and a run
//      starts whatever environment its target declares.) The old wire decided in the CHILD, whose context came from the child's own
//      ambient — which is why the retired cell asserted `executionContext: 'ci'` when
//      `GITHUB_ACTIONS` was set. So the cell below VARIES the ambient and requires the injected
//      value to win. A cell that passed because the ambient default happened to be
//      `local-headless` would prove nothing: this process pins exactly that at daemon startup.
//   2. THE BUS EVENT LOG IS THE RECORD (D-04). No `run-child.stdout.log`, no
//      `run-child.stderr.log`, ever again. The ABSENCE is asserted by listing the run directory,
//      not by trusting the code path that stopped writing them.
//   3. THE JOB-OUTCOME ANALYTICS SURVIVES THE MOVE. Same event name, same closed key set, same
//      `job_kind`, same two-valued `outcome` — now read off the run's own completion instead of a
//      child's exit code. The pre-change reading these are differenced against was taken on the
//      old wire before a line moved and is pasted in `401-06-SUMMARY.md`.
//
// DRIVEN THROUGH THE PRODUCTION FRAMES. Every cell starts a REAL `runDaemonHost`, dispatches
// through the REAL socket with `invokeViaDaemon`, and composes the REAL production run execution —
// nothing here injects a `runExecution`. The 399/400 scar is a fixture that mounted the unit
// without its production frames and proved a process-level truth on a bare router; the truths above
// are all about what a daemon PROCESS does, so a bare port in a fixture could not carry them.
//
// EVERY RUN BELOW IS A REAL RUN. The fixture's model points at an unbindable port and
// `PLAYWRIGHT_BROWSERS_PATH` is an empty directory, so a member fails fast — but it fails DOWNSTREAM
// of `startRun`, which is the point: the artifacts a started run leaves are what these cells read.

import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { ConfigReaderPort, JobModelCapability } from '@vostride/agent-qa-agent'
import type { AnalyticsAgentProduct } from '@vostride/agent-qa-analytics'
import { DashboardDatabase, resolveRunOwnerHost } from '@vostride/agent-qa-dashboard'
import {
  getActiveExecutionContext,
  setActiveExecutionContextResolver,
} from '@vostride/agent-qa-safety'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { composeAnalyticsHost } from '../../composition/analytics-host.js'
import {
  CountingTarget,
  auditRows,
  buildOrdinalsExist,
  createInProcessFixture,
  eventTypes,
  runDirs,
  removeInProcessFixtures,
} from '../../composition/__tests__/in-process-run-fixture.js'
import type { InProcessFixture } from '../../composition/__tests__/in-process-run-fixture.js'
import { UNINSTALLED_AUTH_PLUGIN_PACKAGE } from '../../composition/__tests__/in-process-run-fixture.js'
import { invokeViaDaemon } from '../client.js'
import { INVOKE_ENVELOPE_SCHEMA_VERSION, invokeEnvelopeSchema } from '../server.js'
import { DAEMON_EVENTS_FILE } from '../events.js'
import { runDaemonHost } from '../host.js'
import type { DaemonHostOperations } from '../host.js'
import { closeTestRunRecords, testRunRecord } from '../../composition/__tests__/in-process-run-fixture.js'
import { pinProcessTmpdir, removeTempRoots } from '../../__tests__/temp-roots.js'
import type { PinnedTmpdir } from '../../__tests__/temp-roots.js'
import { MASKED_RESOLVED_CONFIG_SCHEMA_VERSION } from '@vostride/agent-qa-schema'

let pinnedTmpdir: PinnedTmpdir | undefined
beforeAll(() => { pinnedTmpdir = pinProcessTmpdir() })
afterAll(() => {
  pinnedTmpdir?.restore()
  if (pinnedTmpdir !== undefined) removeTempRoots([pinnedTmpdir.root])
})

// 2026-10-17 (443-08, D-22): every drive call carries a record; each cell closes the ones it opened.
afterEach(() => { closeTestRunRecords() })

/**
 * The capture files that retired with the child (D-04).
 *
 * Spelled here rather than imported, and that is the point: nothing in the daemon's own closure
 * names them any more, so there is no constant left to import.
 */
const RETIRED_CAPTURE_FILES = ['run-child.stdout.log', 'run-child.stderr.log'] as const

const TEST_MODEL: JobModelCapability = {
  modelId: 'test:daemon-run-execution',
  generate: () => Promise.resolve({ text: 'unused' }),
}

function testConfig(configPath: string): ConfigReaderPort {
  return {
    getMasked: () => Promise.resolve({ schemaVersion: MASKED_RESOLVED_CONFIG_SCHEMA_VERSION, configPath, entries: [] }),
  }
}

const temporaryRoots: string[] = []

/** The process-global resolver is exactly that; a leaked pin poisons every sibling cell. */
const shippedExecutionContextResolver = getActiveExecutionContext
let restoreResolver: (() => void) | undefined

/**
 * Vary the ambient AFTER the daemon has started, which is what makes the D-07 claim measurable.
 *
 * `runDaemonHost`'s first effect is `pinLocalHeadlessExecutionContext()`, so an ambient read taken
 * at any point during a dispatched run would answer `local-headless` for free. Re-pinning here
 * DEFEATS that startup pin, so a run that still gates as `local-headless` can only be doing it
 * because the daemon CARRIED the value into the invocation.
 *
 * BOTH AMBIENT CHANNELS ARE TURNED, not one. The resolver is what an in-process reader would
 * consult; `GITHUB_ACTIONS` is what a SPAWNED reader would have consulted, and it is set here as
 * well so this cell reds against the retired child wire too (measured: the pre-change daemon's
 * child recorded `executionContext: 'ci'` under exactly this env). One channel would have left the
 * other as a way for an ambient read to survive the cell.
 */
function varyAmbientExecutionContext(value: 'ci' | 'local-interactive'): void {
  const savedGithubActions = process.env.GITHUB_ACTIONS
  process.env.GITHUB_ACTIONS = '1'
  setActiveExecutionContextResolver(() => value as never)
  restoreResolver = () => {
    setActiveExecutionContextResolver(() => shippedExecutionContextResolver())
    if (savedGithubActions === undefined) delete process.env.GITHUB_ACTIONS
    else process.env.GITHUB_ACTIONS = savedGithubActions
  }
}

afterEach(() => {
  restoreResolver?.()
  restoreResolver = undefined
  removeTempRoots(temporaryRoots.splice(0))
})
afterAll(() => { removeInProcessFixtures() })

interface DaemonProject {
  readonly fixture: InProcessFixture
  readonly knowledgeRoot: string
}

/** A run project the daemon will serve from, plus the empty browsers root the member fails on. */
function daemonProject(input: {
  origin: string
  environment: 'local' | 'shared'
  declareUninstalledAuthPlugin?: boolean
}): DaemonProject {
  const fixture = createInProcessFixture({
    origin: input.origin,
    environment: input.environment,
    ...(input.declareUninstalledAuthPlugin === true ? { declareUninstalledAuthPlugin: true } : {}),
  })
  temporaryRoots.push(fixture.project)
  const browsersRoot = join(fixture.project, 'no-browsers')
  if (!existsSync(browsersRoot)) mkdirSync(browsersRoot, { recursive: true })
  process.env.PLAYWRIGHT_BROWSERS_PATH = browsersRoot
  const knowledgeRoot = join(fixture.project, 'agent-qa-knowledge')
  return { fixture, knowledgeRoot }
}

function signalHarness(): {
  readonly operations: Partial<DaemonHostOperations>
  signal(signal: NodeJS.Signals): void
} {
  const listeners = new Map<NodeJS.Signals, () => void>()
  return {
    operations: {
      setInterval: (_callback, intervalMs) => (
        intervalMs as unknown as ReturnType<typeof setInterval>
      ),
      clearInterval: () => undefined,
      onSignal: (signal, listener) => listeners.set(signal, listener),
      offSignal: (signal, listener) => {
        if (listeners.get(signal) === listener) listeners.delete(signal)
      },
      hardExit: (code) => {
        throw new Error(`unexpected daemon hard exit ${code}`)
      },
    },
    signal(signal) {
      const listener = listeners.get(signal)
      if (listener === undefined) throw new Error(`${signal} listener was not installed`)
      listener()
    },
  }
}

async function waitUntil(
  predicate: () => boolean,
  message: string,
  timeoutMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message)
    await new Promise((settle) => setTimeout(settle, 10))
  }
}

function readDaemonEvents(agentQaRoot: string): Array<Record<string, unknown>> {
  const path = join(agentQaRoot, DAEMON_EVENTS_FILE)
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

/** Every file the invocation left in every run directory — the list the D-04 absence reads. */
function runDirFiles(fixture: InProcessFixture): string[] {
  return runDirs(fixture as never).flatMap((dir) => readdirSync(dir))
}

interface CapturedEvent {
  readonly name: string
  readonly properties: Record<string, unknown>
  readonly distinctId?: string
}

/**
 * Drive one real daemon over one real dispatch, with the SHIPPED analytics composition and only the
 * transport replaced — the opt-out decision, the identity gate and the closed union are the real
 * ones. Nothing here injects a `runExecution`: what is measured is the production binding.
 */
async function dispatchThroughDaemon(input: {
  readonly project: DaemonProject
  readonly patterns: readonly string[]
  readonly varyAmbient?: 'ci' | 'local-interactive'
  /** Extra `runs.start` fields, so a cell can send one the seam must refuse. */
  readonly extraRequestFields?: Readonly<Record<string, unknown>>
  /** The agent product the daemon's own analytics host resolved at startup. */
  readonly daemonAgentProduct?: AnalyticsAgentProduct
  /** The submitter's environment while it calls `invokeViaDaemon`; `undefined` deletes a name. */
  readonly submitterEnv?: Readonly<Record<string, string | undefined>>
}): Promise<{
  /** The ack, when the dispatch succeeded. */
  acknowledged: unknown
  /**
   * What the CALLER got instead, when it did not.
   *
   * `invokeViaDaemon` rehydrates a function-layer failure into a thrown `Error` rather than
   * returning an envelope, so a refusal arrives here — and this is the surface a person sees.
   */
  refusal: unknown
  analyticsEvents: CapturedEvent[]
  hostErrors: string[]
  /** Whether anything reached this process's stdout while the daemon served the dispatch. */
  stdoutWrites: number
}> {
  const { fixture, knowledgeRoot } = input.project
  const signals = signalHarness()
  const sent: CapturedEvent[] = []
  const hostErrors: string[] = []
  let started = false
  let writesToStdout = 0

  const analytics = await composeAnalyticsHost({
    surface: 'daemon',
    env: {},
    transportOverride: {
      capture: (payload) => {
        sent.push({ ...(payload.event as CapturedEvent), distinctId: payload.distinctId })
      },
      flush: () => {},
      shutdown: () => {},
    },
    resolveIdentity: async () => ({
      distinctId: 'u_daemon-cell',
      runtimeContext: 'user',
      ...(input.daemonAgentProduct === undefined ? {} : { agentProduct: input.daemonAgentProduct }),
    }),
  })

  const running = runDaemonHost({
    agentQaRoot: fixture.agentQaRoot,
    knowledgeRoot,
    configPath: fixture.configPath,
    config: testConfig(fixture.configPath),
    model: () => TEST_MODEL,
    operations: signals.operations,
    analytics,
    logger: {
      info: () => { started = true },
      error: (message) => hostErrors.push(message),
    },
  })
  await waitUntil(() => started, 'daemon did not finish starting')

  // AFTER startup, so the startup pin is the thing being defeated rather than the thing relied on.
  if (input.varyAmbient !== undefined) varyAmbientExecutionContext(input.varyAmbient)

  // CARRIED FORWARD from the retired child cell: a daemon serving a dispatch writes nothing to this
  // process's stdout. It mattered when the run was a piped child whose streams could leak; it
  // matters MORE now that the run happens in this process and a reporter attached by mistake would
  // print the run's console output into the daemon's own terminal.
  const stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

  let acknowledged: unknown
  let refusal: unknown
  try {
    for (const [name, value] of Object.entries(input.submitterEnv ?? {})) vi.stubEnv(name, value)
    acknowledged = await invokeViaDaemon({
      agentQaRoot: fixture.agentQaRoot,
      functionId: 'runs.start',
      input: { patterns: [...input.patterns], ...(input.extraRequestFields ?? {}) },
    })
  } catch (error) {
    refusal = error
  } finally {
    if (input.submitterEnv !== undefined) vi.unstubAllEnvs()
    const stdoutWrites = stdoutWrite.mock.calls.length
    stdoutWrite.mockRestore()
    writesToStdout = stdoutWrites
    await analytics.flush()
    signals.signal('SIGTERM')
    await running
  }

  return { acknowledged, refusal, analyticsEvents: sent, hostErrors, stdoutWrites: writesToStdout }
}

describe('the daemon dispatches runs through the in-process core (401-06, INVK-02)', () => {
  it(
    'PARITY — the dispatched run happens in process: job analytics, a run-completed daemon event, and NO capture files',
    async () => {
      const target = new CountingTarget()
      await target.listen()
      try {
        const project = daemonProject({ origin: target.origin, environment: 'local' })
        const { fixture } = project
        const { acknowledged, refusal, analyticsEvents, stdoutWrites } =
          await dispatchThroughDaemon({ project, patterns: [fixture.suitePattern] })

        // THE RUN HAPPENED, and the ack came off the durable record the composition read back.
        expect(refusal, `runs.start refused: ${String(refusal)}`).toBeUndefined()
        const runId = (acknowledged as { runId?: string }).runId
        expect(runId, `runs.start did not acknowledge a run: ${JSON.stringify(acknowledged)}`)
          .toMatch(/^r_/)
        // THE ACK LAW, carried forward from the retired child cell: every field is read off the
        // completed-run record, so an ack that is richer than the evidence cannot be produced. The
        // `executionContext` here is D-07 arriving on the CALLER's surface — the ack a person or a
        // dashboard reads says which posture the run was taken in.
        expect(acknowledged).toMatchObject({
          runId,
          executionContext: 'local-headless',
          testCount: 1,
        })
        // A daemon serving a dispatch prints nothing: no reporters (D-04), no console tee.
        expect(stdoutWrites).toBe(0)
        const events = eventTypes(fixture as never)
        expect(events).toContain('runStarted')
        // THE MEMBER RAN. Without this a dispatch that assembled zero members would pass on
        // `runStarted` alone — which is the suite half's own failure mode.
        expect(events).toContain('testStarted')
        // The run started, so the run-start baseline probe knocked.
        expect(target.hits).toEqual(['/in-process-thing'])
        expect(buildOrdinalsExist(fixture as never)).toBe(true)

        // RE-SPELLED 2026-09-30 (432-13): the D-07 allow arm read the gate row's context. No row is
        // written now; the carried context is the ack's `executionContext`, asserted above.
        expect(auditRows(fixture as never)).toEqual([])

        // D-04: THE ABSENCE, read off the directory listing rather than off the code path.
        const files = runDirFiles(fixture)
        expect(files).toContain('events.jsonl')
        expect(files).toContain('handoff.json')
        for (const retired of RETIRED_CAPTURE_FILES) {
          expect(files, `${retired} is still being written`).not.toContain(retired)
        }

        // The durable daemon event: the honest successor of `run-child-exit` (there is no child).
        const completions = readDaemonEvents(fixture.agentQaRoot)
          .filter((event) => event.kind === 'run-completed')
        expect(completions).toHaveLength(1)
        expect(completions[0]).toEqual({
          ts: expect.any(String),
          kind: 'run-completed',
          runId,
          outcome: 'failed',
        })
        expect(readDaemonEvents(fixture.agentQaRoot).map((event) => event.kind))
          .not.toContain('run-child-exit')

        // THE ANALYTICS PARITY DIFFERENTIAL. Same event, same closed key set, same `job_kind` — and
        // an `outcome` READ BACK off the run's own handoff rather than typed into this cell, so a
        // daemon that emitted a constant reds here instead of agreeing with itself.
        const jobEvents = analyticsEvents
          .filter((event) => event.name === 'agent-qa.daemon.job.completed')
        expect(jobEvents).toHaveLength(1)
        const handoffPath = runDirs(fixture as never)
          .map((dir) => join(dir, 'handoff.json'))
          .find((path) => existsSync(path))
        const aggregateVerdict = (
          JSON.parse(readFileSync(handoffPath!, 'utf8')) as { aggregateVerdict: string }
        ).aggregateVerdict
        // Non-vacuity: the read-back is only a discriminator while the two arms can differ.
        expect(aggregateVerdict).toBe('failed')
        expect(jobEvents[0]?.properties).toMatchObject({
          job_kind: 'run',
          outcome: aggregateVerdict === 'passed' ? 'completed' : 'failed',
          run_id: runId,
          surface: 'daemon',
        })
        // The OLD wire's key set (measured pre-change; see SUMMARY), plus 447-09's agent_product.
        expect(Object.keys(jobEvents[0]?.properties ?? {}).sort()).toEqual([
          '$process_person_profile',
          'agent_product',
          'agent_qa_version',
          'job_kind',
          'outcome',
          'run_id',
          'runtime_context',
          'surface',
        ])
      } finally {
        await target.close()
      }
    },
    180_000,
  )

  // With no gate there is nothing for the context to change: a shared run started at the drive
  // under local-interactive starts like any other.
  it(
    'THE CROSSING IS GONE — under local-interactive a shared run starts',
    async () => {
      const target = new CountingTarget()
      await target.listen()
      try {
        const { runInProcessCliRun } = await import('../../composition/in-process-run-execution.js')
        const drive = async (environment: 'shared'): Promise<{ fixture: ReturnType<typeof daemonProject>['fixture'] }> => {
          const { fixture } = daemonProject({ origin: target.origin, environment })
          try {
            await runInProcessCliRun(
              {
                runRecord: testRunRecord(),
                configPath: fixture.configPath,
                agentQaRoot: fixture.agentQaRoot,
                executionContext: 'local-interactive',
              },
              { patterns: [fixture.suitePattern] },
            )
          } catch { /* the member's framework error; the run still happened */ }
          return { fixture }
        }

        const shared = await drive('shared')
        expect(eventTypes(shared.fixture as never)).toContain('runStarted')
        expect(auditRows(shared.fixture as never)).toEqual([])
      } finally {
        await target.close()
      }
    },
    180_000,
  )
})

// 432-13 (D-01/D-14): the worker carries its detected posture and asks nobody. A dispatched run
// against a shared target starts under the carried `local-headless`, whatever the ambient says.
describe('C432-DAEMON-DIRECT — the worker starts a non-production run with no approval (432-13)', () => {
  it(
    'C432-DAEMON-DIRECT: a shared-target run dispatched to the daemon starts under the carried local-headless context',
    async () => {
      const target = new CountingTarget()
      await target.listen()
      try {
        const project = daemonProject({ origin: target.origin, environment: 'shared' })
        const { fixture } = project
        const { acknowledged, refusal, stdoutWrites } = await dispatchThroughDaemon({
          project,
          patterns: [fixture.suitePattern],
          varyAmbient: 'local-interactive',
        })

        expect(refusal, `runs.start refused: ${String(refusal)}`).toBeUndefined()
        expect(acknowledged).toMatchObject({ executionContext: 'local-headless', testCount: 1 })
        expect(stdoutWrites).toBe(0)
        const events = eventTypes(fixture as never)
        expect(events).toContain('runStarted')
        expect(events).toContain('testStarted')
        expect(target.hits).toEqual(['/in-process-thing'])
        expect(buildOrdinalsExist(fixture as never)).toBe(true)
        // No run-start decision was taken, so no row records one.
        expect(auditRows(fixture as never).filter((row) => row.action === 'run:start')).toEqual([])
      } finally {
        await target.close()
      }
    },
    180_000,
  )
})

/** What a caller actually holds: the rehydrated error's class name and its message, as one string. */
function callerSurface(refusal: unknown): string {
  const error = refusal as Error | undefined
  return `${error?.name ?? ''}: ${error?.message ?? String(refusal)}`
}

describe('the daemon refuses an unhonourable request field BEFORE it reads anything (401-10)', () => {
  it('THE ORDERING — `scope` is refused with no auth plugin loaded, and nothing is dispatched', async () => {
    // ASSIGNED TO 401-10 by the orchestrator, from 401-05's finding at the fn door and filed in
    // `deferred-items.md`. `composeDaemonRunExecution` read its own preflight — which is right, and
    // is what keeps `config.safety.trustMode` reaching this gate — and THEN called the drive, whose
    // step (0) is the refusal. So a `runs.start` naming a field the seam was always going to refuse
    // still resolved the project's config first, and `resolveRunInvocationInputs` LOADS AUTH
    // PLUGINS: third-party code executed on behalf of a refused request.
    //
    // A DOOR THAT READS ITS OWN PREFLIGHT MUST MAKE THE REFUSAL ITSELF; the drive's check is too
    // late for it. Same shape as `__tests__/fn-command.test.ts`'s "no longer refuses runs.start by
    // binding", and deliberately so — one contract, one assertion shape, two doors.
    const target = new CountingTarget()
    await target.listen()
    try {
      // THE FIXTURE IS THE MEASUREMENT. Its config declares an auth plugin that is not installed,
      // so a refusal arriving after config resolution reports `PluginNotInstalledError` and a
      // refusal arriving before it reports `RunRequestFieldRefusedError`. Without the plugin the
      // two orderings produce identical output and this cell would be green at rest.
      const project = daemonProject({
        origin: target.origin,
        environment: 'local',
        declareUninstalledAuthPlugin: true,
      })
      const { fixture } = project

      const { acknowledged, refusal } = await dispatchThroughDaemon({
        project,
        patterns: [fixture.testPattern],
        extraRequestFields: { scope: { tier: 'product', key: 'shop' } },
      })

      expect(acknowledged).toBeUndefined()
      // The NAME and the message together — `invokeViaDaemon` rehydrates both, and the pair is
      // what a caller sees. Read as one string so a refusal that changed which half carries the
      // class cannot slip past.
      const surface = callerSurface(refusal)
      expect(surface).toContain('RunRequestFieldRefusedError')
      expect(surface).toContain('scope')
      // THE HALF THE NAME ALONE CANNOT CARRY: nothing was read on the way to the refusal.
      expect(surface).not.toContain('PluginNotInstalledError')
      expect(surface).not.toContain(UNINSTALLED_AUTH_PLUGIN_PACKAGE)

      // …and a refused request left nothing behind, which is the core's own stated property and
      // the reason the ordering matters at all beyond the plugin load.
      expect(eventTypes(fixture as never)).toEqual([])
      expect(buildOrdinalsExist(fixture as never)).toBe(false)
      expect(target.hits).toEqual([])
      expect(runDirFiles(fixture)).toEqual([])
    } finally {
      await target.close()
    }
  }, 120_000)

  it('THE ALLOW CONTROL — the SAME fixture without that one field dispatches a real run', async () => {
    // One field different. Without this arm the cell above would pass for a daemon that refused
    // every request — including for a daemon that could not read this fixture's config at all,
    // which is precisely the failure mode the uninstalled plugin introduces.
    const target = new CountingTarget()
    await target.listen()
    try {
      const project = daemonProject({
        origin: target.origin,
        environment: 'local',
        declareUninstalledAuthPlugin: true,
      })
      const { fixture } = project

      const { acknowledged, refusal } = await dispatchThroughDaemon({
        project,
        patterns: [fixture.testPattern],
      })

      // The plugin IS loaded on this arm — the request is honourable, so the preflight runs — and
      // the fixture's declaration is therefore what a real project would hit. The run is refused by
      // the plugin loader, NOT by the field check, and the two refusals are distinguishable.
      const surface = callerSurface(refusal)
      expect(acknowledged, `unexpected ack: ${JSON.stringify(acknowledged)}`).toBeUndefined()
      expect(surface).toContain('PluginNotInstalledError')
      expect(surface).not.toContain('RunRequestFieldRefusedError')
    } finally {
      await target.close()
    }
  }, 120_000)
})

// ==============================================================================================
// TRUTH 2 AS A COMPLETE-SET CENSUS — the daemon has NO capture-file writer and NO piped-child
// consumer, anywhere it can reach.
//
// WHY A CENSUS AND NOT A READING. "The capture files are gone" is a claim about the files nobody
// opened. The parity cell above proves that ONE dispatch left none behind; it cannot say that no
// other daemon path writes one, and `daemon/` is not the boundary of what a daemon runs — the
// dispatch reaches `commands/run.ts` and its whole member-production graph.
//
// AND IT IS CLOSED TRANSITIVELY, which is 401-11's scar spelled out: that plan's own census found
// two functions that terminated the host TWO CALLS from the in-process entry, while a scan of the
// pinned exported bodies reported clean. A closure that stopped at `daemon/**` would report this
// daemon clean while a capture write sat one import away.
//
// THE DISCOVERY PREDICATE SELF-CHECKS, both directions:
//   (i)  every acquisition form is planted in synthetic source and must be SEEN — the raw filename,
//        a static import of the launcher, a destructured dynamic import, a namespace member call and
//        a bare call. Not one remembered spelling;
//   (ii) a DECLARATION of the launcher must NOT be seen, and neither must a prose mention. While
//        `composition/local-agent-host.ts` still declared `createPipedLaunchChild`, that was the
//        case the package actually presented, and a converse witness asserted the declaration was
//        there so "zero consumers" could not be read as "zero occurrences". 401-10 DELETED the
//        declaration, so the witness went with it; the planted-declaration case below is what still
//        keeps a census that cannot tell a declaration from a call from passing;
//  (iii) the closure is pinned to its own known members and floored, so a walk with a wrong root or
//        an over-eager filter cannot return a small set and sweep it clean.
// ==============================================================================================

/** `packages/cli/src/daemon/__tests__` → two levels up is the package's shipped source tree. */
const CLI_SRC = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

/**
 * Drop block and line comments so a name that appears only in prose is never read as code.
 *
 * The `[^:]` guard keeps a protocol-relative URL from being mistaken for a line comment, which is
 * how this kind of stripper usually eats a file. One stripper idiom for the phase, so a reader
 * compares this census like with `run-door-invocation-census.test.ts`.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
}

/** Does this source WRITE a run-child capture file? The filename literal is the whole surface. */
function writesCaptureFile(source: string): boolean {
  const code = stripComments(source)
  return RETIRED_CAPTURE_FILES.some((name) => code.includes(name))
}

/**
 * Does this source CONSUME the piped-child launcher?
 *
 * A call, an import or a namespace member — but never the declaration, which is what the file that
 * still owns the function has. `function`/`const`/`let`/`class` immediately before the name is the
 * declaration form; everything else that names it in code is a consumer.
 */
function consumesPipedLauncher(source: string): boolean {
  const code = stripComments(source)
  const mentions = [...code.matchAll(/(?:^|[^A-Za-z0-9_$.])(\w+\.)?createPipedLaunchChild\b/g)]
  return mentions.some((match) => {
    const before = code.slice(Math.max(0, match.index - 40), match.index + match[0].length)
    return !/\b(?:function|const|let|var|class)\s+createPipedLaunchChild\b/.test(before)
  })
}

/**
 * Every first-party module the daemon host can reach, transitively.
 *
 * Static imports, `export … from` re-exports and DYNAMIC imports all count: this file's own three
 * production seams are `await import('…')`, so a walker that read only static edges would miss the
 * run execution entirely — and the run execution is the subject.
 */
function daemonReachableModules(entry: string): { modules: string[]; unresolved: string[] } {
  const seen = new Set<string>()
  const unresolved: string[] = []
  const queue = [entry]
  while (queue.length > 0) {
    const current = queue.pop()!
    if (seen.has(current)) continue
    seen.add(current)
    const source = readFileSync(current, 'utf8')
    const specifiers = [
      ...[...stripComments(source).matchAll(/from\s+'(\.[^']+)'/g)].map((m) => m[1]!),
      ...[...stripComments(source).matchAll(/import\(\s*'(\.[^']+)'\s*\)/g)].map((m) => m[1]!),
    ]
    for (const specifier of specifiers) {
      const resolved = join(dirname(current), specifier.replace(/\.js$/, '.ts'))
      if (existsSync(resolved)) queue.push(resolved)
      else unresolved.push(`${current} -> ${specifier}`)
    }
  }
  return { modules: [...seen].sort(), unresolved }
}

describe('the daemon has no capture-file writer and no piped-child consumer (401-06, D-01/D-04)', () => {
  const DAEMON_ENTRY = join(CLI_SRC, 'daemon', 'host.ts')

  /** Named here rather than read off the scan: a walker that stops reaching these must FAIL. */
  const REQUIRED_CLOSURE_MEMBERS = [
    'daemon/host.ts',
    'daemon/events.ts',
    'composition/in-process-run-execution.ts',
    'composition/local-agent-host.ts',
    'composition/run-assembly.ts',
    'commands/run.ts',
  ] as const

  it('(i) the scanner sees what it forbids — before any verdict about any module', () => {
    // Every acquisition form, planted. Not one remembered spelling.
    expect(writesCaptureFile("await writeFile(join(dir, 'run-child.stdout.log'), out)")).toBe(true)
    expect(writesCaptureFile("const p = `${dir}/run-child.stderr.log`")).toBe(true)
    expect(consumesPipedLauncher("import { createPipedLaunchChild } from './x.js'")).toBe(true)
    expect(consumesPipedLauncher("const { createPipedLaunchChild } = await import('./x.js')")).toBe(true)
    expect(consumesPipedLauncher('launchChild: createPipedLaunchChild(entry, onClose)')).toBe(true)
    expect(consumesPipedLauncher('host.createPipedLaunchChild(entry, onClose)')).toBe(true)
  })

  it('(ii) …and does NOT see a declaration, or a mention in prose', () => {
    // Synthetic since 401-10: no file declares it any more. The distinction still has to hold, or
    // a future re-mint that only DECLARED the launcher would read as a consumer and mask the real
    // question — and, in the other direction, prose naming the retirement would read as a wire.
    expect(consumesPipedLauncher('export function createPipedLaunchChild(\n  entry: string,\n) {}'))
      .toBe(false)
    expect(consumesPipedLauncher('// the daemon used to call createPipedLaunchChild here'))
      .toBe(false)
    expect(writesCaptureFile('// run-child.stdout.log retired with the child (D-04)')).toBe(false)
    // The stripper must not eat code it should keep (the protocol-relative-URL trap).
    expect(stripComments("const u = 'https://example.test/x'").trim())
      .toBe("const u = 'https://example.test/x'")
  })

  it('(iii) the closure ranges what the claim is about — the discovery self-check', () => {
    const { modules, unresolved } = daemonReachableModules(DAEMON_ENTRY)
    const relative = modules.map((path) => path.slice(CLI_SRC.length + 1))
    // A floor, so an empty or near-empty walk cannot read as a clean daemon.
    expect(relative.length).toBeGreaterThan(40)
    // …and the named members, which is the assertion a floor cannot make.
    for (const member of REQUIRED_CLOSURE_MEMBERS) {
      expect(relative, `the census is not ranging ${member}`).toContain(member)
    }
    // A specifier the walk could not resolve is a silently truncated closure, not a clean one.
    expect(unresolved).toEqual([])
  })

  it('THE COMPLETE SET IS EMPTY — nothing the daemon reaches writes a capture file', () => {
    const { modules } = daemonReachableModules(DAEMON_ENTRY)
    const offenders = modules
      .filter((path) => writesCaptureFile(readFileSync(path, 'utf8')))
      .map((path) => path.slice(CLI_SRC.length + 1))
    expect(offenders, 'a module the daemon reaches still writes a run-child capture file')
      .toEqual([])
  })

  it('THE COMPLETE SET IS EMPTY — nothing the daemon reaches consumes the piped-child launcher', () => {
    const { modules } = daemonReachableModules(DAEMON_ENTRY)
    const offenders = modules
      .filter((path) => consumesPipedLauncher(readFileSync(path, 'utf8')))
      .map((path) => path.slice(CLI_SRC.length + 1))
    expect(offenders, 'a module the daemon reaches still launches a piped run child').toEqual([])
  })
})

// 2026-10-17 (443-06, D-02): the daemon's runs reach runs.db through the same record as every door.
describe('C443-DAEMON-RECORD', () => {
  it('a run the daemon dispatches writes its row, stamped with the daemon, trigger cli', async () => {
    const target = new CountingTarget()
    await target.listen()
    try {
      const project = daemonProject({ origin: target.origin, environment: 'local' })
      const { fixture } = project
      const { acknowledged, refusal, hostErrors } =
        await dispatchThroughDaemon({ project, patterns: [fixture.suitePattern] })

      expect(refusal, `runs.start refused: ${String(refusal)}`).toBeUndefined()
      const runId = (acknowledged as { runId?: string }).runId
      expect(runId, 'runs.start acknowledged no run').toMatch(/^r_/)
      const dbPath = join(fixture.project, '.agent-qa', 'runs.db')
      expect(existsSync(dbPath), 'the daemon left no runs.db').toBe(true)
      const db = new DashboardDatabase({ dbPath })
      try {
        const rows = db.getRuns({})
        expect(rows.map((row) => row.id).join(','), 'runs.db rows').toBe(runId)
        expect(rows[0]!.attributes?.['agent-qa.trigger'], 'the row trigger').toBe('cli')
        const owner = db.readRunOwner(runId!)
        expect(owner?.pid, 'the row owner pid').toBe(process.pid)
        expect(owner?.host, 'the row owner host').toBe(resolveRunOwnerHost())
      } finally {
        db.close()
      }
      expect(hostErrors.filter((line) => line.includes('dashboard record is incomplete'))).toEqual([])
    } finally {
      await target.close()
    }
  }, 180_000)
})

// 2026-10-21 (447-08, D-16): a dispatched run reports its outcome beside the job event, printing nothing.
describe('C447-DAEMON-OUTCOME', () => {
  it('a daemon-dispatched run emits its run outcome beside the job event', async () => {
    const target = new CountingTarget()
    await target.listen()
    try {
      const project = daemonProject({ origin: target.origin, environment: 'local' })
      const { fixture } = project
      const { acknowledged, refusal, analyticsEvents, stdoutWrites } =
        await dispatchThroughDaemon({ project, patterns: [fixture.testPattern] })

      expect(refusal, `runs.start refused: ${String(refusal)}`).toBeUndefined()
      const runId = (acknowledged as { runId?: string }).runId
      expect(runId, 'runs.start acknowledged no run').toMatch(/^r_/)
      expect(stdoutWrites, 'the daemon wrote to stdout').toBe(0)
      expect(
        analyticsEvents.filter((event) => event.name === 'agent-qa.daemon.job.completed'),
        'the job events',
      ).toHaveLength(1)
      const outcomes = analyticsEvents.filter((event) => event.name === 'agent-qa.test_run.completed')
      expect(outcomes.map((event) => event.properties), 'the run outcomes').toEqual([
        expect.objectContaining({ run_id: runId, trigger_source: 'daemon', surface: 'daemon' }),
      ])
    } finally {
      await target.close()
    }
  }, 180_000)
})

const AGENT_MARKERS = [
  'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT',
  'CURSOR_AGENT',
  'GEMINI_CLI',
  'AUGMENT_AGENT',
  'GOOSE_TERMINAL',
  'OPENCODE_CLIENT',
  'CODEX_SANDBOX',
  'CLINE_ACTIVE',
  'AGENT',
] as const

// 2026-10-21 (447-09, D-14): a job is attributed to its submitter, never to the daemon's launcher.
describe('C447-DAEMON-CONTEXT', () => {
  it('a daemon job reports its submitter agent product, and unknown when none was carried', async () => {
    const target = new CountingTarget()
    await target.listen()
    try {
      const noAgent = Object.fromEntries(AGENT_MARKERS.map((name) => [name, undefined]))
      const arms = [
        { submitterEnv: { ...noAgent, CLAUDECODE: '1' }, expected: 'claude_code' },
        { submitterEnv: noAgent, expected: 'unknown' },
      ]
      for (const arm of arms) {
        const project = daemonProject({ origin: target.origin, environment: 'local' })
        const { acknowledged, refusal, analyticsEvents } = await dispatchThroughDaemon({
          project,
          patterns: [project.fixture.testPattern],
          daemonAgentProduct: 'cursor',
          submitterEnv: arm.submitterEnv,
        })

        expect(refusal, `runs.start refused: ${String(refusal)}`).toBeUndefined()
        const runId = (acknowledged as { runId?: string }).runId
        expect(runId, 'runs.start acknowledged no run').toMatch(/^r_/)
        const jobEvents = analyticsEvents.filter(
          (event) =>
            event.name === 'agent-qa.test_run.completed' ||
            event.name === 'agent-qa.daemon.job.completed',
        )
        expect(jobEvents.map((event) => event.name).sort(), 'the job events').toEqual([
          'agent-qa.daemon.job.completed',
          'agent-qa.test_run.completed',
        ])
        for (const event of jobEvents) {
          expect(event.properties.agent_product, `${event.name} agent_product`).toBe(arm.expected)
          expect(event.distinctId, `${event.name} distinct id`).toBe('u_daemon-cell')
        }
      }

      const envelope = {
        schemaVersion: INVOKE_ENVELOPE_SCHEMA_VERSION,
        functionId: 'runs.start',
        input: {},
      }
      const carried = invokeEnvelopeSchema.safeParse({ ...envelope, agentProduct: 'claude_code' })
      expect(carried.success, 'the envelope refused agentProduct').toBe(true)
      expect(invokeEnvelopeSchema.safeParse({ ...envelope, ciId: 'ci_x' }).success).toBe(false)
    } finally {
      await target.close()
    }
  }, 360_000)
})
