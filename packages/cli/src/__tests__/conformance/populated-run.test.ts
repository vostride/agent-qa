// The producer's acceptance on the shipped binary; the at-rest scan runs after the dashboard exits.

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { slugBranch } from '@vostride/agent-qa-schema'
import type { RunEventEnvelope } from '@vostride/agent-qa-schema'
import { chromium } from 'playwright-core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  POPULATED_BUTTON_LABEL,
  POPULATED_DECLARED_SECRET_VALUE,
  POPULATED_EMAIL,
  POPULATED_RUN_ANCHORED_BUILDS,
  POPULATED_SECRET_NAME,
  POPULATED_SECRET_VALUE,
  RUN_BUDGET_MS,
  drivePopulatedRun,
  populatedRunFixtureProject,
  populatedRunSpawnEnv,
  startStubModelServer,
  startTargetPageServer,
} from './populated-run-fixture.js'
import type { FixtureServer, PopulatedRunDrive, StubModelServer } from './populated-run-fixture.js'
import { buildFreshness, cleanupTempRoots, reserveEphemeralPort, spawnDashboard } from './spawned-chat.js'
import type { SpawnedDashboard } from './spawned-chat.js'

// NO PLATFORM SKIP, AND THAT IS THIS FILE'S OWN LAW APPLIED TO ITSELF. Its POSIX-only sibling
// instruments reach for a conditional `describe` on Windows; this file does not, because a
// conditional that exits 0 having measured nothing is the exact outcome the browser law above
// forbids, and a reader cannot tell one green-because-skipped from another. Windows is recorded as
// a drive FAILURE with a sentence naming why, so the cells red and say what was not measured.
const WINDOWS_REFUSAL =
  'the spawned-binary cells in this directory are POSIX-only: the dashboard child is stopped with '
  + 'SIGTERM and the run writes a POSIX runtime root. This file reds rather than skipping on '
  + 'Windows, because a suite that exits 0 having measured nothing is indistinguishable from one '
  + 'that measured everything.'

const REBUILD_INSTRUCTION =
  'these cells drive the BUILT `agent-qa dashboard` and the built packages it resolves as external '
  + 'workspace dependencies: run `pnpm turbo run build --force` from the agent-qa root first. '
  + '`--force` is required — a restored-byte-identical subject is a turbo cache hit, so a plain '
  + 'build reports FULL TURBO and refreshes no dist mtime.'

const BROWSER_INSTALL_INSTRUCTION =
  'this run drives a real Chromium inside the spawned `agent-qa dashboard`: run '
  + '`pnpm exec playwright install chromium` and re-run. THESE CELLS MUST NOT BE SKIPPED WHEN THE '
  + 'BROWSER IS ABSENT — they are the only proof in this repository that the shipped binary '
  + 'produces a populated run at all, and a skipped populated-run suite exits 0 having measured '
  + 'nothing.'

/** How long the detached post-run tail is given before the dashboard is stopped for the scan. */
const TAIL_GRACE_MS = 2_000

/** Everything the one drive measured, or the reason it could not. */
interface Recorded {
  drive?: PopulatedRunDrive
  /** Envelope types in arrival order — what every failure message quotes. */
  envelopeTypes: string[]
  /** `runs/<slug>/events.jsonl` as text, read after the dashboard exited. */
  eventsLog?: string
  /** Every byte of the runtime database and its write-ahead sidecars. */
  dbBytes?: Buffer
  /** The files scanned, named so a clean scan is not a scan of nothing. */
  scannedDbFiles: string[]
  /** The run's blob directory listing, so a missing blob names what WAS there. */
  blobNames: string[]
  /** Whether `playwright-core` can name an installed Chromium at all. */
  browserPresent: boolean
  /** Whatever the child printed, quoted on any failure. */
  dashboardStdout?: string
  dashboardStderr?: string
  stub?: StubModelServer
  runDir?: string
  failure?: string
}

const recorded: Recorded = {
  envelopeTypes: [],
  scannedDbFiles: [],
  blobNames: [],
  browserPresent: false,
}

let targetServer: FixtureServer | undefined
let stubServer: StubModelServer | undefined
let dashboard: (SpawnedDashboard & { readonly ready: boolean }) | undefined

/** Every `subActionRecorded` payload the door served, as loosely-typed records. */
function subActions(envelopes: readonly RunEventEnvelope[]): Record<string, unknown>[] {
  return envelopes
    .filter((envelope) => envelope.type === 'subActionRecorded')
    .map((envelope) => (envelope as unknown as { payload: Record<string, unknown> }).payload)
}

/** Every `stepFinalized` payload the door served. */
function stepsFinalized(envelopes: readonly RunEventEnvelope[]): Record<string, unknown>[] {
  return envelopes
    .filter((envelope) => envelope.type === 'stepFinalized')
    .map((envelope) => (envelope as unknown as { payload: Record<string, unknown> }).payload)
}

/** The context every failure message carries: what the run did, in one block. */
function context(): string {
  const drive = recorded.drive
  const stub = recorded.stub
  return [
    '',
    `envelope types: ${recorded.envelopeTypes.join(', ') || '(none)'}`,
    `finished: ${String(drive?.finished ?? false)}; last type: ${drive?.lastType ?? '(none)'}; `
    + `elapsed: ${String(drive?.elapsedMs ?? 0)}ms`,
    `stub requests: ${
      (stub?.requests ?? [])
        .map((request) => `${request.kind}/${String(request.status)}${request.grounding ? `(${request.grounding})` : ''}`)
        .join(', ') || '(none)'
    }`,
    `chromium present: ${String(recorded.browserPresent)}`,
    // THE WARNING TRAIL IS QUOTED, not summarised. Every way this run can fail short of a verdict
    // — no browser, a refused target, an ungroundable action, a planner the stub could not satisfy
    // — arrives as a `runWarning` or a failed `testFinished`, and a failure message that omitted
    // them would send a reader back to re-run the whole thing just to see the sentence.
    `warnings: ${
      (drive?.envelopes ?? [])
        .filter((envelope) => envelope.type === 'runWarning' || envelope.type === 'testFinished')
        .map((envelope) => JSON.stringify((envelope as unknown as { payload: unknown }).payload).slice(0, 900))
        .join(' | ') || '(none)'
    }`,
    recorded.failure === undefined ? '' : `drive failure: ${recorded.failure}`,
    `dashboard stderr: ${(recorded.dashboardStderr ?? '').slice(-1_500)}`,
  ].join('\n')
}

describe('the shipped binary produces a populated, masked run', () => {
  beforeAll(async () => {
    if (process.platform === 'win32') {
      recorded.failure = WINDOWS_REFUSAL
      return
    }
    try {
      recorded.browserPresent = existsSync(chromium.executablePath())
    } catch {
      recorded.browserPresent = false
    }

    const freshness = buildFreshness(POPULATED_RUN_ANCHORED_BUILDS)
    if (freshness.missing.length > 0 || freshness.stale.length > 0) {
      recorded.failure =
        `${REBUILD_INSTRUCTION} missing: ${freshness.missing.join(', ') || '(none)'}; `
        + `stale: ${freshness.stale.join(', ') || '(none)'}`
      return
    }

    targetServer = await startTargetPageServer()
    stubServer = await startStubModelServer()
    recorded.stub = stubServer

    const project = populatedRunFixtureProject('populated', {
      modelBaseUrl: stubServer.baseUrl,
      targetUrl: targetServer.url,
    })

    const port = await reserveEphemeralPort()
    dashboard = await spawnDashboard(
      project.root,
      project.configPath,
      port,
      60_000,
      populatedRunSpawnEnv(),
    )
    if (!dashboard.ready) {
      recorded.dashboardStdout = dashboard.stdout()
      recorded.dashboardStderr = dashboard.stderr()
      recorded.failure = 'the spawned `agent-qa dashboard` never said it was listening'
      return
    }

    try {
      recorded.drive = await drivePopulatedRun(dashboard, project, RUN_BUDGET_MS)
    } catch (error) {
      recorded.failure = error instanceof Error ? error.message : String(error)
    }
    recorded.envelopeTypes = (recorded.drive?.envelopes ?? []).map((envelope) => envelope.type)
    recorded.dashboardStdout = dashboard.stdout()
    recorded.dashboardStderr = dashboard.stderr()

    // The detached tail is given a moment before its writer is taken away, so a chain that WAS
    // mid-flight is not counted as a stub refusal it never made.
    await new Promise<void>((tick) => { setTimeout(tick, TAIL_GRACE_MS) })
    await dashboard.stop()

    const runId = recorded.drive?.runId
    if (runId !== undefined) {
      const runDir = join(project.agentQaRoot, 'runs', slugBranch(runId))
      recorded.runDir = runDir
      const eventsPath = join(runDir, 'events.jsonl')
      if (existsSync(eventsPath)) recorded.eventsLog = readFileSync(eventsPath, 'utf8')
      const blobDir = join(runDir, 'blobs')
      if (existsSync(blobDir)) recorded.blobNames = readdirSync(blobDir)
    }

    // EVERY database this run's host wrote, AND their write-ahead sidecars. Two widenings, each
    // for a measured reason. The sidecars, because a scan of a main file alone can read clean while
    // the bytes it was looking for sit unmerged in a `-wal`. Every database rather than the
    // projection one, because the projection database is not the only thing the dashboard writes —
    // the job queue lives beside it, carries a run's own metadata, and a masked-side claim that
    // stopped at the file this plan happened to be thinking about would be a claim about one file
    // rather than about the host.
    const chunks: Buffer[] = []
    for (const entry of existsSync(project.agentQaRoot) ? readdirSync(project.agentQaRoot) : []) {
      if (!/\.db(?:-[a-z]+)?$/u.test(entry)) continue
      const full = join(project.agentQaRoot, entry)
      recorded.scannedDbFiles.push(entry)
      chunks.push(readFileSync(full))
    }
    recorded.dbBytes = Buffer.concat(chunks)
  }, RUN_BUDGET_MS + 120_000)

  afterAll(async () => {
    await dashboard?.stop()
    await stubServer?.close()
    await targetServer?.close()
    cleanupTempRoots()
  })

  it('reaches a verdict and a runFinished on the local run-stream door', () => {
    expect(
      recorded.failure,
      `the populated run never started. ${BROWSER_INSTALL_INSTRUCTION}${context()}`,
    ).toBeUndefined()
    expect(
      recorded.envelopeTypes,
      `the run served no \`verdict\` frame. ${BROWSER_INSTALL_INSTRUCTION}${context()}`,
    ).toContain('verdict')
    expect(
      recorded.drive?.finished,
      `the run never reached \`runFinished\` inside ${String(RUN_BUDGET_MS)}ms.${context()}`,
    ).toBe(true)
  })

  it('carries a decision-screenshot sha on a sub-action, whose blob exists on disk', () => {
    const withRefs = subActions(recorded.drive?.envelopes ?? []).filter((payload) => {
      const refs = payload.artifactRefs
      return Array.isArray(refs) && refs.length > 0
    })
    expect(
      withRefs.length,
      'no `subActionRecorded` envelope carried `artifactRefs`. A live planning turn with an '
      + 'attached screenshot is what mints one, so either no live turn happened (a cache replay, '
      + 'or a run that never opened a page) or the artifact-ref fold stopped folding. '
      + `${BROWSER_INSTALL_INSTRUCTION}${context()}`,
    ).toBeGreaterThan(0)

    const first = (withRefs[0]?.artifactRefs as { sha?: unknown }[])[0]
    const sha = first?.sha
    expect(
      typeof sha === 'string' ? sha : '',
      `\`artifactRefs[0].sha\` is not a 64-character lowercase hex digest.${context()}`,
    ).toMatch(/^[0-9a-f]{64}$/u)

    const blobPath = join(recorded.runDir ?? '', 'blobs', String(sha))
    expect(
      existsSync(blobPath),
      `the ref names a blob this run never wrote: ${blobPath}. `
      + `blobs present: ${recorded.blobNames.join(', ') || '(none)'}${context()}`,
    ).toBe(true)
  })

  it('carries a measured token triple on a finalized step', () => {
    const measured = stepsFinalized(recorded.drive?.envelopes ?? []).filter((payload) => {
      const usage = payload.tokenUsage as { totalTokens?: unknown } | undefined
      return typeof usage?.totalTokens === 'number' && usage.totalTokens > 0
    })
    expect(
      measured.length,
      'no `stepFinalized` envelope carried a positive `tokenUsage.totalTokens`. The stub reports '
      + 'non-zero `usage` on every arm, so an absent triple means the runner summed no model call '
      + `for the step — or the token-usage append stopped appending.${context()}`,
    ).toBeGreaterThan(0)
  })

  it('carries the declared marker and the email and env credential as written in a sub-action plan on the wire', () => {
    const plans = subActions(recorded.drive?.envelopes ?? [])
      .map((payload) => (typeof payload.plan === 'string' ? payload.plan : ''))
    for (const [what, value] of [
      ['the declared marker', `[secret:${POPULATED_SECRET_NAME}]`],
      ['the planted email address', POPULATED_EMAIL],
      ['the env credential', POPULATED_SECRET_VALUE],
    ] as const) {
      expect(
        plans.some((plan) => plan.includes(value)),
        `no sub-action \`plan\` carried ${what}. The planner's reasoning carries all three; the run `
        + `masks the declared value by name and records the others as written. `
        + `plans: ${JSON.stringify(plans)}${context()}`,
      ).toBe(true)
    }
    expect(
      plans.filter((plan) => plan.includes('<SECRET_') || plan.includes('<EMAIL_')),
      `a sub-action \`plan\` carried a masking-context placeholder.${context()}`,
    ).toEqual([])
  })

  it('never writes the declared value in clear, in the log or the database', () => {
    const eventsLog = recorded.eventsLog
    expect(
      eventsLog,
      `the run wrote no \`events.jsonl\` to scan at ${recorded.runDir ?? '(no run dir)'}${context()}`,
    ).toBeDefined()

    expect(
      (eventsLog ?? '').includes(POPULATED_DECLARED_SECRET_VALUE),
      'the declared step secret appears IN CLEAR in this run\'s events.jsonl — masking is broken '
      + `for the artifact a person installs.${context()}`,
    ).toBe(false)
    for (const [what, value] of [
      ['the env credential', POPULATED_SECRET_VALUE],
      ['the planted email address', POPULATED_EMAIL],
    ] as const) {
      expect(
        (eventsLog ?? '').includes(value),
        `${what} is not in this run's events.jsonl as written.${context()}`,
      ).toBe(true)
    }

    const dbBytes = recorded.dbBytes
    expect(
      recorded.scannedDbFiles.length,
      `no runtime database file was found to scan — a clean scan of nothing is not a claim.${context()}`,
    ).toBeGreaterThan(0)
    expect(
      (dbBytes ?? Buffer.alloc(0)).includes(Buffer.from(POPULATED_DECLARED_SECRET_VALUE, 'utf8')),
      'the declared step secret appears IN CLEAR in the dashboard\'s own SQLite bytes '
      + `(${recorded.scannedDbFiles.join(', ')}).${context()}`,
    ).toBe(false)
  })

  it('answered every request the shipped run made, and refused none', () => {
    const requests = recorded.stub?.requests ?? []
    expect(
      requests.length,
      'the stub model server was asked fewer than two questions, so the run reached neither a '
      + `planning turn nor a verification. ${BROWSER_INSTALL_INSTRUCTION}${context()}`,
    ).toBeGreaterThanOrEqual(2)
    expect(
      requests.filter((request) => request.kind === 'planner').length,
      `the shipped planner never called the stub — no tool-bearing request arrived.${context()}`,
    ).toBeGreaterThan(0)

    const refused = requests.filter((request) => request.status !== 200)
    expect(
      refused.map((request) => `${request.method} ${request.path}: ${request.body}`),
      'the stub refused a request shape it did not recognise. This is the STOP condition the '
      + 'fixture header names: report the exact shape rather than downgrading the cell to a '
      + `provider-gated one.${context()}`,
    ).toEqual([])
  })

})
