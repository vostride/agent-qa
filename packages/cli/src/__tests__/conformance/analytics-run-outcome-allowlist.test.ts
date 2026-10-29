// Run outcomes from every door that composes analytics are allowlisted and never change a verdict.

import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import { invokeFunction } from '@vostride/agent-qa-agent'
import {
  ANALYTICS_EVENT_SCHEMA_BY_NAME,
  createPosthogTransport,
} from '@vostride/agent-qa-analytics'
import type { AnalyticsCapturePayload, AnalyticsEventName } from '@vostride/agent-qa-analytics'
import { DashboardDatabase } from '@vostride/agent-qa-dashboard'
import type { RunStartAcknowledgement } from '@vostride/agent-qa-schema'

import { analyticsEvent, composeAnalyticsHost } from '../../composition/analytics-host.js'
import type { CliAnalyticsHost, CliAnalyticsSurface } from '../../composition/analytics-host.js'
import { CLI_FUNCTION_CALLER, composeCliLocalAgent } from '../../composition/local-agent-host.js'
import {
  CountingTarget,
  createInProcessFixture,
  removeInProcessFixtures,
} from '../../composition/__tests__/in-process-run-fixture.js'
import { pinProcessTmpdir, removeTempRoots } from '../temp-roots.js'
import type { PinnedTmpdir } from '../temp-roots.js'

let pinnedTmpdir: PinnedTmpdir | undefined
beforeAll(() => { pinnedTmpdir = pinProcessTmpdir() })
afterAll(() => {
  pinnedTmpdir?.restore()
  if (pinnedTmpdir !== undefined) removeTempRoots([pinnedTmpdir.root])
})

type Fixture = ReturnType<typeof createInProcessFixture>

const TERMINAL = ['passed', 'failed', 'cancelled', 'skipped']
const RUN_BUDGET_MS = 180_000
const CANARY = 'C447-CANARY-STEP'
const SINK_IDENTITY = 'u_alpha-bravo-charlie-delta-echo-foxtrot-golf-hotel-india-juliet'

const target = new CountingTarget()
const priorBrowsersPath = process.env.PLAYWRIGHT_BROWSERS_PATH
const opened: Array<() => Promise<void> | void> = []

beforeAll(async () => { await target.listen() })
afterAll(async () => {
  await target.close()
  if (priorBrowsersPath === undefined) delete process.env.PLAYWRIGHT_BROWSERS_PATH
  else process.env.PLAYWRIGHT_BROWSERS_PATH = priorBrowsersPath
  removeInProcessFixtures()
})
afterEach(async () => {
  for (const close of opened.splice(0).reverse()) await close()
})

function fixture(input: { readonly stepText?: string } = {}): Fixture {
  const created = createInProcessFixture({ origin: target.origin, environment: 'local', ...input })
  const browsersRoot = join(created.project, 'no-browsers')
  mkdirSync(browsersRoot, { recursive: true })
  process.env.PLAYWRIGHT_BROWSERS_PATH = browsersRoot
  return created
}

async function recordingHost(surface: CliAnalyticsSurface): Promise<{
  readonly analytics: CliAnalyticsHost
  readonly sent: AnalyticsCapturePayload[]
}> {
  const sent: AnalyticsCapturePayload[] = []
  const analytics = await composeAnalyticsHost({
    surface,
    env: {},
    transportOverride: {
      capture: (payload) => { sent.push(payload) },
      flush: () => {},
      shutdown: () => {},
    },
    resolveIdentity: async () => ({ distinctId: 'u_door-cell', runtimeContext: 'user' }),
  })
  return { analytics, sent }
}

async function startRun(
  project: Fixture,
  input: { readonly analytics?: CliAnalyticsHost; readonly runTrigger?: 'mcp' },
): Promise<RunStartAcknowledgement> {
  const host = composeCliLocalAgent({
    agentQaRoot: project.agentQaRoot,
    configPath: project.configPath,
    ...input,
  })
  opened.push(() => host.close())
  return await invokeFunction(
    host.registry,
    'runs.start',
    { patterns: [project.testPattern] },
    CLI_FUNCTION_CALLER,
  ) as RunStartAcknowledgement
}

function runOutcomes(sent: readonly AnalyticsCapturePayload[]): Record<string, unknown>[] {
  return sent
    .filter((payload) => payload.event.name === 'agent-qa.test_run.completed')
    .map((payload) => payload.event.properties as Record<string, unknown>)
}

describe('run outcome analytics from the host doors', () => {
  it('a run started through the MCP and chat host compositions emits its run outcome', async () => {
    const mcp = await recordingHost('mcp')
    const viaMcp = await startRun(fixture(), { analytics: mcp.analytics, runTrigger: 'mcp' })
    expect(runOutcomes(mcp.sent), 'the MCP run outcome').toEqual([
      expect.objectContaining({ run_id: viaMcp.runId, surface: 'mcp', trigger_source: 'mcp' }),
    ])

    const chat = await recordingHost('chat')
    const viaChat = await startRun(fixture(), { analytics: chat.analytics })
    expect(runOutcomes(chat.sent), 'the chat run outcome').toEqual([
      expect.objectContaining({ run_id: viaChat.runId, surface: 'chat', trigger_source: 'cli' }),
    ])
  }, RUN_BUDGET_MS * 2)
})

async function waitFor(predicate: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + RUN_BUDGET_MS
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(message)
    await new Promise((tick) => setTimeout(tick, 50))
  }
}

async function statusOf(project: Fixture, runId: string): Promise<string | undefined> {
  const db = new DashboardDatabase({ dbPath: join(project.project, '.agent-qa', 'runs.db') })
  try {
    await waitFor(() => TERMINAL.includes(db.getRun(runId)?.status ?? ''), `run ${runId} never finished`)
    return db.getRun(runId)?.status
  } finally {
    db.close()
  }
}

async function decodeBody(body: unknown): Promise<string> {
  if (typeof body === 'string') return body
  const bytes = body instanceof Blob
    ? Buffer.from(await body.arrayBuffer())
    : Buffer.from(body as Uint8Array)
  return bytes[0] === 0x1f && bytes[1] === 0x8b
    ? gunzipSync(bytes).toString('utf8')
    : bytes.toString('utf8')
}

interface BatchItem {
  readonly event: AnalyticsEventName
  readonly distinct_id: string
  readonly properties: Record<string, unknown>
}

describe('the analytics sink allowlist', () => {
  it('every captured event carries only its member allowlisted metadata and the capture is not empty', async () => {
    const bodies: string[] = []
    const analytics = await composeAnalyticsHost({
      surface: 'mcp',
      env: {},
      projectKey: 'phc_sink_cell',
      posthogTransportFactory: (options) => createPosthogTransport({
        ...options,
        fetch: async (_url: string, init: { body?: unknown }) => {
          bodies.push(await decodeBody(init.body))
          return new Response(JSON.stringify({ status: 1 }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }) as never
        },
      }),
      resolveIdentity: async () => ({
        distinctId: SINK_IDENTITY,
        runtimeContext: 'user',
        isInternal: true,
      }),
    })
    const project = fixture({ stepText: `Verify the page says "${CANARY}"` })
    const ack = await startRun(project, { analytics, runTrigger: 'mcp' })

    analytics.port.capture(analyticsEvent(analytics, 'agent-qa.mcp.server.lifecycle', {
      mcp_server_state: 'started',
      mcp_transport: 'stdio',
    }))
    analytics.port.capture(analyticsEvent(analytics, 'agent-qa.init.completed', {
      init_mode: 'scaffold',
      outcome: 'created',
      created_file_count: 3,
      duration_ms: 12,
    }))
    analytics.port.capture(analyticsEvent(analytics, 'agent-qa.chat.session.completed', {
      duration_ms: 40,
      turn_count: 1,
      function_call_count: 1,
      end_reason: 'exit',
    }))
    analytics.port.capture(analyticsEvent(analytics, 'agent-qa.chat.turn.completed', {
      duration_ms: 20,
      tool_call_count: 1,
      errored: false,
    }))
    analytics.port.capture(analyticsEvent(analytics, 'agent-qa.explain.answered', {}))
    analytics.port.capture(analyticsEvent(analytics, 'agent-qa.explain.abstained', {
      suggested_row_count: 0,
      catalog_empty: false,
    }))
    analytics.port.capture(analyticsEvent(analytics, 'agent-qa.daemon.job.completed', {
      job_kind: 'run',
      outcome: 'failed',
      run_id: ack.runId,
    }))
    await analytics.shutdown()

    const items = bodies.flatMap((body) => (JSON.parse(body) as { batch: BatchItem[] }).batch)
    expect(items.length, 'the sink captured nothing').toBeGreaterThan(0)
    expect(new Set(items.map((item) => item.event)), 'the captured members').toEqual(new Set([
      'agent-qa.test_run.completed',
      'agent-qa.mcp.server.lifecycle',
      'agent-qa.init.completed',
      'agent-qa.chat.session.completed',
      'agent-qa.chat.turn.completed',
      'agent-qa.explain.answered',
      'agent-qa.explain.abstained',
      'agent-qa.daemon.job.completed',
    ]))
    expect(
      items.find((item) => item.event === 'agent-qa.test_run.completed')?.properties['run_id'],
      'the door run outcome',
    ).toBe(ack.runId)
    for (const item of items) {
      const { $lib: _lib, $lib_version: _libVersion, ...properties } = item.properties
      const parsed = ANALYTICS_EVENT_SCHEMA_BY_NAME[item.event].safeParse({ name: item.event, properties })
      expect(parsed.success, `${item.event}: ${JSON.stringify(parsed.error?.issues)}`).toBe(true)
      expect(item.distinct_id, `${item.event} distinct id`).toMatch(/^(u_|ci_)/)
      expect(item.properties['is_internal'], `${item.event} is_internal`).toBe(true)
    }
    for (const body of bodies) {
      expect(body, 'a body carries the step canary').not.toContain(CANARY)
      expect(body, 'a body carries the project path').not.toContain(project.project)
      expect(body, 'a body carries the browsers directory').not.toContain('no-browsers')
    }
  }, RUN_BUDGET_MS)
})

describe('analytics never changes a run\'s verdict', () => {
  it('a stalled transport and a failing sink at the MCP host leave the run ack and its recorded verdict equal to the control', async () => {
    const controlProject = fixture()
    const control = await startRun(controlProject, { runTrigger: 'mcp' })

    const never = new Promise<void>(() => {})
    const stalled = await composeAnalyticsHost({
      surface: 'mcp',
      env: {},
      transportOverride: {
        capture: () => { throw new Error('the sink refused the event') },
        flush: () => never,
        shutdown: () => never,
      },
      resolveIdentity: async () => ({ distinctId: 'u_door-cell', runtimeContext: 'user' }),
    })
    const stalledProject = fixture()
    const viaStalled = await startRun(stalledProject, { analytics: stalled, runTrigger: 'mcp' })

    expect(viaStalled.runId, 'the stalled-sink ack').toMatch(/^r_/)
    expect(viaStalled.testCount, 'the ack test count').toBe(control.testCount)
    const controlStatus = await statusOf(controlProject, control.runId)
    expect(controlStatus, 'the control recorded no verdict').toBeDefined()
    expect(await statusOf(stalledProject, viaStalled.runId), 'the recorded verdict').toBe(controlStatus)
  }, RUN_BUDGET_MS * 2)
})
