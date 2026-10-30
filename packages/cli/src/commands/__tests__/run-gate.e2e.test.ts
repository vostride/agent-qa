// The CLI door: `agent-qa run`, measured through `dist/cli.js` because what the caller sees is a
// property of the process a person starts.
//
// Nothing asks and nothing gates a run on its target: a no-tty run against a shared, undeclared or
// local target starts, writes `runStarted`, advances its build ordinal and knocks on the target.
// What this door still refuses is a removed flag and a malformed or colliding run id, and those
// refusals leave no run directory behind.

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createHash } from 'node:crypto'

import { generateRunId, generateTestId } from '@vostride/agent-qa-ids'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

/**
 * The SHIPPED binary, resolved from this file's own location.
 *
 * `packages/cli/src/commands/__tests__` → three levels up is `packages/cli`. The plan's verify line
 * runs `pnpm build` before every run of this file: a reading taken on a stale dist compares two
 * copies of the previous build and calls the result a measurement.
 */
const CLI_DIST = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'dist', 'cli.js')

interface AuditRow {
  action: string
  riskTier: string
  verdict: string
  outcome: string
  reason: string
  runId: string
  executionContext: string
}

let project: string

/**
 * THE TARGET, as a loopback server that counts who knocked.
 *
 * This is the fifth artifact, and the one that measures the ordering claim DIRECTLY rather than by
 * proxy: "the gate decides before any network touch of the target, including the run-start baseline
 * probe". Every target below points at this server, so a request recorded here is `agent-qa`
 * touching the environment it was about to drive. A denied run must leave the counter at zero — and
 * the allow control must move it, or the zero would be a server nobody was ever going to call.
 */
let probeServer: Server
let probeHits: string[] = []
let probeOrigin: string

beforeAll(async () => {
  probeServer = createServer((request, response) => {
    probeHits.push(request.url ?? '')
    response.writeHead(200, { 'content-type': 'text/html' })
    response.end('<!doctype html><title>Example</title><p>Example</p>')
  })
  await new Promise<void>((ready) => probeServer.listen(0, '127.0.0.1', ready))
  probeOrigin = `http://127.0.0.1:${(probeServer.address() as AddressInfo).port}`
})

afterAll(async () => {
  await new Promise<void>((closed) => probeServer.close(() => closed()))
})

beforeEach(() => {
  probeHits = []
  project = mkdtempSync(join(tmpdir(), 'run-gate-e2e-'))
  mkdirSync(join(project, 'tests'), { recursive: true })

  // A config this cell owns end to end. THREE targets, differing ONLY in their `environment`
  // declaration — that is the axis under test, so nothing else may vary between them, the URL
  // included: all three point at the same counting loopback server.
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
      '    shared-thing:',
      '      platform: web',
      `      url: ${probeOrigin}/shared-thing`,
      '      environment: shared',
      '    undeclared-thing:',
      '      platform: web',
      `      url: ${probeOrigin}/undeclared-thing`,
      '    local-thing:',
      '      platform: web',
      `      url: ${probeOrigin}/local-thing`,
      '      environment: local',
      'use:',
      '  mobile:',
      '    appState: preserve',
      '',
    ].join('\n'),
  )
  writeFileSync(join(project, 'hooks.yaml'), 'hooks: []\n')
  writeFileSync(join(project, '.env'), '')
  writeFileSync(join(project, '.env.secrets.local'), '')

  for (const target of [
    'shared-thing', 'undeclared-thing', 'local-thing',
  ]) {
    writeFileSync(
      join(project, 'tests', `${target}.yaml`),
      [
        `test-id: ${generateTestId()}`,
        `name: a run against ${target}`,
        `target: ${target}`,
        'steps:',
        '  - Verify the page says "Example"',
        '',
      ].join('\n'),
    )
  }
})

afterEach(() => {
  rmSync(project, { recursive: true, force: true })
})

/**
 * Run the shipped binary with PIPED stdio — no tty on either end, which is what makes the context
 * non-interactive and the fail-closed arm reachable. That is the same shape a CI job, a cron entry
 * or a redirected shell gives the process.
 *
 * ASYNCHRONOUS, AND THAT IS LOAD-BEARING RATHER THAN STYLE. The first version of this helper used
 * `spawnSync`, which blocks this process's event loop until the child exits — including the
 * loopback server above. The child's baseline probe then connected, waited for a response nobody
 * could send, and aborted on its own 4s timeout, so the counter read empty on EVERY leg. The deny
 * cells passed on a measurement that could not have failed; the allow control is what caught it.
 */
async function runCli(...args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return await runCliWithEnv({}, ...args)
}

// `AGENT_QA_RUN_ID` never passes `RunsStartInputSchema`, so its refusals are measured here.
async function runCliWithEnv(
  overrides: Record<string, string>,
  ...args: string[]
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: '1' }
  // A run id inherited from this process would attach the child's run to another run's directory —
  // and an EMPTY string is not the same as absent: `?? generateRunId()` keeps `''`, which slugs to
  // a run directory called `default`. Deleted, not blanked.
  delete env.AGENT_QA_RUN_ID
  for (const [key, value] of Object.entries(overrides)) env[key] = value

  const child = spawn(process.execPath, [CLI_DIST, 'run', ...args], { cwd: project, env })
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
function runDirs(): string[] {
  const runs = join(project, '.agent-qa', 'runs')
  if (!existsSync(runs)) return []
  return readdirSync(runs).map((entry) => join(runs, entry))
}

function auditRows(): AuditRow[] {
  return runDirs().flatMap((dir) => {
    const path = join(dir, 'execution_audit.jsonl')
    if (!existsSync(path)) return []
    return readFileSync(path, 'utf8')
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line) as AuditRow)
  })
}

/** Every recorded run event, across every run dir — an empty array means no run began. */
function eventTypes(): string[] {
  return runDirs().flatMap((dir) => {
    const path = join(dir, 'events.jsonl')
    if (!existsSync(path)) return []
    return readFileSync(path, 'utf8')
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => (JSON.parse(line) as { type: string }).type)
  })
}

/** A sha of every file in a directory — "untouched" has to be a statement about bytes. */
function digestsUnder(dir: string): Record<string, string> {
  if (!existsSync(dir)) return {}
  const digests: Record<string, string> = {}
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (!statSync(path).isFile()) continue
    digests[name] = createHash('sha256').update(readFileSync(path)).digest('hex')
  }
  return digests
}

/** Did assembly run? The build-ordinal ledger is its durable trace, written behind the gate. */
function buildOrdinalsExist(): boolean {
  return existsSync(join(project, '.agent-qa', 'build-ordinals.json'))
}

/** The approval wording a retired prompt or refusal would print. None of it may reach a person. */
const RETIRED_APPROVAL_TEXT = /\[y\/N\]|\[y\/a\/N\]|needs your approval|Proceed\?|--trust-session|fail-closed/

// `agent-qa run` asks nobody. A CI job with stdin that is not a terminal starts a run; the piped
// stdin below is held open and never written, so a run that waited on an answer would never exit.
describe('CI with a non-TTY stdin starts the run', () => {
  it.each(['undeclared-thing', 'shared-thing'])(
    'CI=true against a %s target starts, with no refusal, no prompt and no gate row',
    async (target) => {
      const result = await runCliWithEnv({ CI: 'true' }, `tests/${target}.yaml`)

      expect(eventTypes()[0]).toBe('runStarted')
      expect(buildOrdinalsExist()).toBe(true)
      expect(probeHits).toContain(`/${target}`)
      expect(auditRows().filter((row) => row.action === 'run:start')).toEqual([])
      expect(`${result.stdout}\n${result.stderr}`).not.toMatch(RETIRED_APPROVAL_TEXT)
    },
    180_000,
  )
})

describe('the CLI door starts a no-tty run, and --trust-session is gone', () => {
  it('a no-tty run against a local target starts', async () => {
    await runCli('tests/local-thing.yaml')

    expect(auditRows().filter((row) => row.action === 'run:start')).toEqual([])
    expect(eventTypes()[0]).toBe('runStarted')
    expect(buildOrdinalsExist()).toBe(true)
    expect(probeHits).toContain('/local-thing')
  }, 180_000)

  it('--trust-session is no longer an option: Commander refuses it and no run starts', async () => {
    const result = await runCli('tests/shared-thing.yaml', '--trust-session')

    expect(result.stderr).toContain("unknown option '--trust-session'")
    expect(runDirs()).toEqual([])
    expect(probeHits).toEqual([])
    expect(result.status).not.toBe(0)
  }, 180_000)
})

// The paired control differs by one environment variable and starts, so no run is the refusal.
describe('the environment door cannot name a malformed or colliding run id', () => {
  it('a MALFORMED AGENT_QA_RUN_ID is refused, and no run directory is created at all', async () => {
    const result = await runCliWithEnv(
      { AGENT_QA_RUN_ID: 'not-a-minted-id' },
      'tests/local-thing.yaml',
    )

    // The refusal names the id; it is not rendered as a framework error or a stack.
    expect(result.stderr).toContain('not-a-minted-id')
    expect(result.stderr).toContain('run id')
    expect(result.stderr).not.toContain('Framework error')
    // Nothing happened: no run directory, so no audit row and no events; no assembly; no knock.
    expect(runDirs()).toEqual([])
    expect(auditRows()).toEqual([])
    expect(buildOrdinalsExist()).toBe(false)
    expect(probeHits).toEqual([])
    expect(result.status).not.toBe(0)
  }, 180_000)

  it('a PATH-SHAPED AGENT_QA_RUN_ID is refused — the traversal never reaches a path join', async () => {
    const result = await runCliWithEnv(
      { AGENT_QA_RUN_ID: '../../escape' },
      'tests/local-thing.yaml',
    )

    expect(result.stderr).toContain('run id')
    // A traversal id is refused outright, so no run directory is made.
    expect(runDirs()).toEqual([])
    expect(existsSync(join(project, '.agent-qa', 'runs', 'escape'))).toBe(false)
    expect(probeHits).toEqual([])
    expect(result.status).not.toBe(0)
  }, 180_000)

  it('an EMPTY AGENT_QA_RUN_ID no longer runs into the shared runs/default/ directory', async () => {
    const result = await runCliWithEnv({ AGENT_QA_RUN_ID: '' }, 'tests/local-thing.yaml')

    // `slugBranch('')` is `'default'`, so blank ids would share one run directory.
    expect(existsSync(join(project, '.agent-qa', 'runs', 'default'))).toBe(false)
    expect(runDirs()).toEqual([])
    expect(result.status).not.toBe(0)
  }, 180_000)

  it('a COLLIDING AGENT_QA_RUN_ID is refused and the victim run is byte-identical after', async () => {
    const victimId = generateRunId()

    const first = await runCliWithEnv({ AGENT_QA_RUN_ID: victimId }, 'tests/local-thing.yaml')
    expect(first.stderr).not.toContain('run id')
    const victimDir = join(project, '.agent-qa', 'runs', victimId)
    expect(existsSync(victimDir)).toBe(true)
    const before = digestsUnder(victimDir)
    // Non-vacuity: the victim really holds the artifacts a collision would tamper with.
    expect(Object.keys(before)).toContain('events.jsonl')
    expect(Object.keys(before)).toContain('handoff.json')
    const hitsAfterFirst = [...probeHits]

    const second = await runCliWithEnv({ AGENT_QA_RUN_ID: victimId }, 'tests/local-thing.yaml')

    expect(second.stderr).toContain(victimId)
    expect(second.stderr).toContain('already names a run')
    expect(second.status).not.toBe(0)
    expect(digestsUnder(victimDir)).toEqual(before)
    // …and the refusal cost the target nothing, so it landed above assembly here too.
    expect(probeHits).toEqual(hitsAfterFirst)
  }, 240_000)

  it('THE CONTROL — a freshly minted AGENT_QA_RUN_ID runs, under exactly that id', async () => {
    const mintedId = generateRunId()

    const result = await runCliWithEnv({ AGENT_QA_RUN_ID: mintedId }, 'tests/local-thing.yaml')

    // The run the refusal cells say never happened is this run: same door, same target, same
    // stdio, one environment value different.
    expect(runDirs().map((dir) => dir.split('/').pop())).toEqual([mintedId])
    expect(eventTypes()[0]).toBe('runStarted')
    expect(buildOrdinalsExist()).toBe(true)
    expect(probeHits).toEqual(['/local-thing'])
    expect(result.stderr).not.toContain('already names a run')
  }, 180_000)
})
