// A self-contained `agent-qa run` SUITE-path fixture, driven through the shipped binary.
//
// Phase 401 plan 04. Two cell files need the same thing — the suite door's gate legs
// (`run-gate-suite.e2e.test.ts`) and the INVK-06 marker carriage legs (`run-markers.test.ts`) — and
// they need it to be the SAME thing, because "the markers still carry" and "the gate now decides"
// are two readings of one wire. A helper rather than two fixtures, so a divergence between them
// cannot become a divergence in what the two claims are about.
//
// NOT A TEST FILE: vitest's include here is `src/**/__tests__/**/*.test.ts`, so this module is
// imported, never collected.
//
// WHY THE SUITE PATH NEEDS MORE FIXTURE THAN THE SINGLE-TEST PATH DID. `run-gate.e2e.test.ts`
// (plan 03) gets away with no `registry.llms` because the single-test path resolves its model
// lazily, inside the member closure — the run STARTS and then fails downstream. The suite path
// resolves models eagerly in `prepareSuite`, so with no llm config it dies at
// `Provider "anthropic-subscription" requires an auth plugin` BEFORE a run could begin, and an
// allow control that never reaches `startRun` cannot show that the gate let anything through.
// So the fixture declares an `openai-compatible` config (auth-optional: a missing credential
// resolves `unauthenticated` rather than `missing`) pointed at a port nothing listens on. The run
// starts, plans, fails to reach the model, and finishes — which is all any cell here asserts.
//
// THE MODEL'S BASE URL IS DELIBERATELY NOT THE COUNTING SERVER. Port 1 is unbindable; a model call
// therefore fails at connect and never reaches the loopback server below. If it did, a planner
// retry would land in `probeHits` and the "nobody knocked" assertion would be measuring the
// planner instead of the run-start probe.

import { spawn } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from 'node:fs'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { generateSuiteId, generateTestId } from '@vostride/agent-qa-ids'

/**
 * The SHIPPED binary, resolved from this file's own location.
 *
 * `packages/cli/src/commands/__tests__` → three levels up is `packages/cli`. Every verify line that
 * runs a cell built on this helper runs `pnpm build` first: a reading taken on a stale dist compares
 * two copies of the previous build and calls the result a measurement.
 */
export const CLI_DIST = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'dist', 'cli.js')

export interface AuditRow {
  /**
   * When the decision was taken (401-09).
   *
   * ON THE TYPE BECAUSE A MULTI-RUN CELL NEEDS IT. `auditRows` concatenates one run-scoped sink per
   * run directory, in directory order, which is not the order the decisions were taken in — so a
   * cell with two runs has to sort, and could not.
   */
  ts: string
  action: string
  riskTier: string
  verdict: string
  outcome: string
  reason: string
  /** Which rung of `resolveAsk` allowed it, when one did. Absent on a denial and on a plain allow. */
  trustSource?: string
  runId: string
  executionContext: string
}

/**
 * THE TARGET, as a loopback server that counts who knocked.
 *
 * This is the artifact that measures the ordering claim DIRECTLY rather than by proxy: "the gate
 * decides before any network touch of the target, including the run-start baseline probe". A
 * request recorded here is `agent-qa` touching the environment it was about to drive. A dry run
 * must leave the counter at zero — and a started run must move it, or the zero would be a server
 * nobody was ever going to call.
 */
export class CountingTarget {
  private server: Server | undefined
  private originValue = ''
  hits: string[] = []

  /** `onHit` runs as each request arrives, before it is answered (2026-10-03, quick-261003-tsr). */
  constructor(private readonly onHit?: (url: string) => void) {}

  async listen(): Promise<void> {
    this.server = createServer((request, response) => {
      this.onHit?.(request.url ?? '')
      this.hits.push(request.url ?? '')
      response.writeHead(200, { 'content-type': 'text/html' })
      response.end('<!doctype html><title>Example</title><p>Example</p>')
    })
    await new Promise<void>((ready) => this.server!.listen(0, '127.0.0.1', ready))
    this.originValue = `http://127.0.0.1:${(this.server!.address() as AddressInfo).port}`
  }

  async close(): Promise<void> {
    const server = this.server
    if (server === undefined) return
    await new Promise<void>((closed) => server.close(() => closed()))
  }

  get origin(): string {
    return this.originValue
  }

  reset(): void {
    this.hits = []
  }
}

/** A target's `environment:` declaration — `undefined` writes NO declaration at all (D-06). */
export type FixtureEnvironment = 'local' | 'shared' | undefined

export interface SuiteFixture {
  /** The project directory, real-pathed (macOS `/var` → `/private/var`) so scrubbing is exact. */
  readonly project: string
  /** The suite file's workspace-relative path, i.e. the argument `agent-qa run` is given. */
  readonly suitePattern: string
}

/**
 * Write a one-suite, one-member project whose single target differs from its siblings in EXACTLY
 * the `environment` declaration — that is the axis under test, so nothing else may vary, the URL
 * included.
 */
export function createSuiteFixture(input: {
  origin: string
  environment: FixtureEnvironment
}): SuiteFixture {
  const project = realpathSync(mkdtempSync(join(tmpdir(), 'run-suite-gate-')))
  mkdirSync(join(project, 'tests'), { recursive: true })
  mkdirSync(join(project, 'suites'), { recursive: true })

  writeFileSync(
    join(project, 'agent-qa.config.yaml'),
    [
      'workspace:',
      '  testMatch:',
      "    - 'tests/**/*.yaml'",
      '  suiteMatch:',
      "    - 'suites/**/*.suite.yaml'",
      '  hooksFile: hooks.yaml',
      '  envFile: .env',
      '  secretsFile: .env.secrets.local',
      'registry:',
      '  targets:',
      '    suite-thing:',
      '      platform: web',
      `      url: ${input.origin}/suite-thing`,
      ...(input.environment === undefined ? [] : [`      environment: ${input.environment}`]),
      '  llms:',
      '    - name: unreachable',
      '      provider: openai-compatible',
      '      model: gpt-4o-mini',
      // Port 1 is unbindable — a model call fails at connect and never reaches the counting server.
      '      baseURL: http://127.0.0.1:1/v1',
      'use:',
      '  llm: unreachable',
      '  mobile:',
      '    appState: preserve',
      '',
    ].join('\n'),
  )
  writeFileSync(join(project, 'hooks.yaml'), 'hooks: []\n')
  writeFileSync(join(project, '.env'), '')
  writeFileSync(join(project, '.env.secrets.local'), '')

  const memberTestId = generateTestId()
  writeFileSync(
    join(project, 'tests', 'member.yaml'),
    [
      `test-id: ${memberTestId}`,
      'name: the suite member',
      'target: suite-thing',
      'steps:',
      '  - Verify the page says "Example"',
      '',
    ].join('\n'),
  )
  writeFileSync(
    join(project, 'suites', 'gate.suite.yaml'),
    [
      `suite-id: ${generateSuiteId()}`,
      'name: the gated suite',
      'target: suite-thing',
      'tests:',
      '  - test: tests/member.yaml',
      `    id: ${memberTestId}`,
      '',
    ].join('\n'),
  )

  return { project, suitePattern: 'suites/gate.suite.yaml' }
}

/**
 * Run the shipped binary with PIPED stdio — no tty on either end, which is what makes the context
 * non-interactive and the fail-closed arm reachable. That is the same shape a CI job, a cron entry
 * or a redirected shell gives the process.
 *
 * ASYNCHRONOUS, AND THAT IS LOAD-BEARING RATHER THAN STYLE (plan 03's measured defect, inherited
 * here deliberately). `spawnSync` blocks this process's event loop until the child exits — the
 * loopback target above included. The child's baseline probe then connects, waits for a response
 * nobody can send, and aborts on its own timeout, so the counter reads empty on EVERY leg and the
 * deny cells pass on a measurement that could not have failed.
 */
export async function runCli(
  fixture: SuiteFixture,
  ...args: string[]
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: '1', DO_NOT_TRACK: '1' }
  // A run id inherited from this process would attach the child's run to another run's directory —
  // and an EMPTY string is not the same as absent: `?? generateRunId()` keeps `''`, which slugs to
  // a run directory called `default`. Deleted, not blanked.
  delete env.AGENT_QA_RUN_ID

  const child = spawn(process.execPath, [CLI_DIST, 'run', ...args], { cwd: fixture.project, env })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => { stdout += chunk })
  child.stderr.on('data', (chunk: string) => { stderr += chunk })

  const status = await new Promise<number | null>((settle, fail) => {
    child.on('error', fail)
    child.on('close', (code) => settle(code))
  })
  return { status, stdout, stderr }
}

/** Every run directory the invocation left behind under the project's own `.agent-qa`. */
export function runDirs(fixture: SuiteFixture): string[] {
  const runs = join(fixture.project, '.agent-qa', 'runs')
  if (!existsSync(runs)) return []
  return readdirSync(runs).map((entry) => join(runs, entry))
}

export function auditRows(fixture: SuiteFixture): AuditRow[] {
  return runDirs(fixture).flatMap((dir) => {
    const path = join(dir, 'execution_audit.jsonl')
    if (!existsSync(path)) return []
    return readFileSync(path, 'utf8')
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line) as AuditRow)
  })
}

/** Every recorded run event, across every run dir — an empty array means no run began. */
export function eventTypes(fixture: SuiteFixture): string[] {
  return runDirs(fixture).flatMap((dir) => {
    const path = join(dir, 'events.jsonl')
    if (!existsSync(path)) return []
    return readFileSync(path, 'utf8')
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => (JSON.parse(line) as { type: string }).type)
  })
}

/** Did assembly run? The build-ordinal ledger is its durable trace, written behind the gate. */
export function buildOrdinalsExist(fixture: SuiteFixture): boolean {
  return existsSync(join(fixture.project, '.agent-qa', 'build-ordinals.json'))
}
