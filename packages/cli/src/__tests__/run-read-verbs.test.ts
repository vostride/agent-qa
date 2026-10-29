// the dedicated CLI reads over their canonical ops.
//
// In-process cells drive the Commander verbs against a populated project and compare `--json` with
// the MCP `structuredContent` answered by the same composition. `runs.overview` and the document arm
// of `runs.evidence` bind through a run-detail reader; these cells hand the composition the
// shipped dashboard reader over the project's runs database. Spawned cells run the built
// `dist/cli.js`: run `pnpm build` at the repository root first.

import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import {
  existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, renameSync,
  rmSync, symlinkSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { invokeFunction, RUNS_ARTIFACT_FUNCTION_ID } from '@vostride/agent-qa-agent'
import { AGENT_QA_TOOL_PROJECTIONS } from '@vostride/agent-qa-mcp'
import { DashboardDatabase, createDashboardRunDetailReader } from '@vostride/agent-qa-dashboard'
import { generateRunId, generateTestId } from '@vostride/agent-qa-ids'
import { FsEvidenceArtifactStore, FsHandoffStore } from '@vostride/agent-qa-runner-local'
import {
  CURRENT_HANDOFF_SCHEMA_VERSION,
  RETRIEVAL_TRACE_SCHEMA_VERSION,
  RUN_EVIDENCE_DOCUMENT_SCHEMA_VERSION,
} from '@vostride/agent-qa-schema'
import type { CompletedRunHandoff, EvidenceDocument, PerTestOutcome } from '@vostride/agent-qa-schema'
import { Command, CommanderError } from 'commander'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { DEDICATED_READ_VERBS } from '../capability-catalog/manifest.js'
import { exportArtifactBytes } from '../commands/artifact-export.js'
import { composeMcpMasking, createMcpHttpRequestListener } from '../commands/mcp.js'
import { createKnowledgeCommand } from '../commands/knowledge.js'
import { createRunsCommand } from '../commands/runs.js'
import * as host from '../composition/local-agent-host.js'
import { markFixture } from '../gates/__tests__/feedback-fixture.js'
import {
  CLI_ENTRY,
  REBUILD_INSTRUCTION,
  buildFreshness,
  cleanupTempRoots,
  fixtureProject,
  spawnCollecting,
} from './conformance/spawned-chat.js'

const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
const PNG = Uint8Array.from(atob(PNG_BASE64), (char) => char.charCodeAt(0))
const WEBM = Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3, ...Array.from({ length: 96 }, (_, index) => index)])
const UNICODE_NAME = 'Café checkout — 日本語 ✓ 🧪'
const UNICODE_STEP = 'Öffne den Warenkorb 🛒 «schnell»'
const NETWORK: Extract<EvidenceDocument, { kind: 'network' }> = {
  schemaVersion: RUN_EVIDENCE_DOCUMENT_SCHEMA_VERSION, kind: 'network', records: [{
    url: 'https://app.test/api/cart?q=ümlaut', method: 'GET', status: 500,
    requestHeaders: { accept: 'application/json' }, responseHeaders: { 'content-type': 'application/json' },
    body: 'cart unavailable ✗', startTime: 1, endTime: 2,
  }],
}
const CONSOLE: Extract<EvidenceDocument, { kind: 'console' }> = {
  schemaVersion: RUN_EVIDENCE_DOCUMENT_SCHEMA_VERSION, kind: 'console', records: [
    { level: 'error', text: 'TypeError: price is undefined — 価格', timestamp: 3 },
    { level: 'warning', text: 'slow response', timestamp: 4 },
  ],
}
const ARIA: Extract<EvidenceDocument, { kind: 'aria' }> = {
  schemaVersion: RUN_EVIDENCE_DOCUMENT_SCHEMA_VERSION, kind: 'aria', tree: '- button "Payer ✓"',
}
const READER_TOKEN = 'zz-431-07-reader-credential-5c21aa'

const cleanups: (() => void | Promise<void>)[] = []
let originalExitCode: typeof process.exitCode
let runDetailDbPath: string | undefined
const realCompose = host.composeCliLocalAgent

beforeEach(() => {
  originalExitCode = process.exitCode
  runDetailDbPath = undefined
  vi.spyOn(host, 'composeCliLocalAgent').mockImplementation((input) => {
    if (runDetailDbPath === undefined || input.runDetail !== undefined) return realCompose(input)
    const db = new DashboardDatabase({ dbPath: runDetailDbPath })
    const composed = realCompose({ ...input, runDetail: createDashboardRunDetailReader(db) })
    const close = composed.close.bind(composed)
    return Object.assign(composed, {
      close: () => {
        try { return close() } finally { db.close() }
      },
    })
  })
})

afterEach(async () => {
  vi.restoreAllMocks()
  process.exitCode = originalExitCode
  for (const close of cleanups.splice(0).reverse()) await close()
  cleanupTempRoots()
})

// ---- The populated project ------------------------------------------------------------------------

function populatedProject() {
  const f = markFixture()
  cleanups.push(() => rmSync(f.root, { recursive: true, force: true }))
  writeFileSync(join(f.root, 'hooks.yaml'), 'hooks: []\n')
  writeFileSync(join(f.root, '.env'), '')
  writeFileSync(join(f.root, '.env.secrets.local'), '')
  mkdirSync(join(f.root, 'tests'), { recursive: true })
  mkdirSync(join(f.root, 'suites'), { recursive: true })

  const runId = String(f.handoff.runId)
  const recordId = String(f.published.id)
  const first = f.handoff.tests[0]!
  first.testName = UNICODE_NAME
  first.steps[0]!.stepText = UNICODE_STEP
  Object.assign(first.steps[0]!, { retrievalTrace: {
    schemaVersion: RETRIEVAL_TRACE_SCHEMA_VERSION, servedLines: [{ recordId, leg: 'lexical', rank: 1, score: 1.5 }], truncated: [],
  } })
  const second = structuredClone(first)
  second.testId = generateTestId() as PerTestOutcome['testId']
  second.testIndex = 1
  second.testName = 'Second member'
  second.outcome = 'passed'
  Object.assign(second.steps[0]!, { retrievalTrace: {
    schemaVersion: RETRIEVAL_TRACE_SCHEMA_VERSION, servedLines: [{ recordId, leg: 'dense', rank: 2, score: 0.25 }], truncated: [],
  } })
  f.handoff.tests.push(second)
  f.save()

  const blobs = new FsEvidenceArtifactStore({ root: f.agentQaRoot, runId: f.handoff.runId })
  const screenshot = blobs.persistDecisionScreenshot(PNG)
  const recording = blobs.persistDecisionScreenshot(WEBM)
  const networkRef = blobs.persistEvidenceDocument(NETWORK)
  const consoleRef = blobs.persistEvidenceDocument(CONSOLE)
  const ariaRef = blobs.persistEvidenceDocument(ARIA)
  const dbPath = join(f.agentQaRoot, 'runs.db')
  const db = new DashboardDatabase({ dbPath })
  db.insertRun({ id: runId, name: 'Discovery fixture', status: 'failed', duration: 1,
    startedAt: new Date(0).toISOString(), endedAt: new Date(1).toISOString() })
  db.upsertRunMember({ runId, testIndex: 0, testId: first.testId, name: UNICODE_NAME, totalSteps: 1,
    outcome: 'failed', recording: {
      state: 'present', ref: { id: `recording:${recording.sha}`, sha: recording.sha },
      contentType: 'video/webm', byteLength: WEBM.length,
    } })
  db.upsertRunMember({ runId, testIndex: 1, testId: second.testId, name: 'Second member', totalSteps: 1,
    outcome: 'passed', recording: { state: 'absent', reason: 'not-captured' } })
  db.insertRunStep({
    runId, testIndex: 0, stepIndex: 0, stepText: UNICODE_STEP, cacheStatus: 'miss',
    verifierVerdict: null, selfHealOccurred: false, briefDigest: '', status: 'failed',
    evidence: {
      console: { kind: 'console', state: 'present', ref: consoleRef as never, counts: { total: 2, errors: 1, warnings: 1 } },
      network: { kind: 'network', state: 'present', ref: networkRef as never, counts: { total: 1, failed: 1, errored: 0 } },
      a11y: { kind: 'a11y', state: 'absent', reason: 'unsupported' },
      variables: { kind: 'variables', state: 'absent', reason: 'empty' },
    },
  })
  db.insertRunStep({
    runId, testIndex: 1, stepIndex: 0, stepText: 'Second step', cacheStatus: 'hit',
    verifierVerdict: null, selfHealOccurred: false, briefDigest: '', status: 'passed',
    evidence: {
      console: { kind: 'console', state: 'absent', reason: 'empty' },
      network: { kind: 'network', state: 'absent', reason: 'empty' },
      a11y: { kind: 'a11y', state: 'absent', reason: 'unsupported' },
      variables: { kind: 'variables', state: 'absent', reason: 'empty' },
    },
  })
  db.insertRunSubAction({
    runId, testIndex: 0, stepIndex: 0, subActionIndex: 0, plan: 'click Pay', plannedAction: {},
    result: {}, screenStateHash: 'h0', artifactRefs: [screenshot, ariaRef],
    ariaEvidence: { kind: 'aria', state: 'present', ref: ariaRef as never },
  })
  db.close()
  runDetailDbPath = dbPath
  return {
    ...f, runId, recordId, dbPath, firstTestId: String(first.testId), secondTestId: String(second.testId),
    screenshotSha: screenshot.sha, recordingSha: recording.sha,
  }
}

type Project = ReturnType<typeof populatedProject>

function completedRun(agentQaRoot: string, endedAt: number, tests: { id: string; name: string }[],
  verdict: CompletedRunHandoff['aggregateVerdict'] = 'passed'): string {
  const runId = generateRunId()
  const handoff: CompletedRunHandoff = {
    schemaVersion: CURRENT_HANDOFF_SCHEMA_VERSION,
    runId: runId as CompletedRunHandoff['runId'],
    scope: { tier: 'product', key: 'shop' },
    buildOrdinal: 1,
    executionContext: 'local-headless',
    aggregateVerdict: verdict,
    configDigests: { suiteConfigDigest: 'suite', testConfigDigest: 'test' },
    startedAt: endedAt - 50,
    endedAt,
    tests: tests.map((test, testIndex) => ({
      testId: test.id, testName: test.name, filePath: `tests/${test.id}.yaml`, testIndex,
      outcome: verdict === 'passed' ? 'passed' : 'failed', steps: [],
    }) as PerTestOutcome),
  }
  new FsHandoffStore({ root: agentQaRoot, runId }).save(handoff)
  return runId
}

// ---- Drivers --------------------------------------------------------------------------------------

interface Invocation {
  stdout: string
  stderr: string
  exitCode: number
}

function allCommands(command: Command): Command[] {
  return [command, ...command.commands.flatMap(allCommands)]
}

async function cli(configPath: string, args: readonly string[]): Promise<Invocation> {
  const stdout: string[] = []
  const stderr: string[] = []
  const log = vi.spyOn(console, 'log').mockImplementation((...values: unknown[]) => {
    stdout.push(values.map(String).join(' '))
  })
  const error = vi.spyOn(console, 'error').mockImplementation((...values: unknown[]) => {
    stderr.push(values.map(String).join(' '))
  })
  process.exitCode = undefined
  const program = new Command()
    .option('--config <path>', 'config file path')
    .addCommand(createRunsCommand())
    .addCommand(createKnowledgeCommand())
  for (const command of allCommands(program)) {
    command.exitOverride().configureOutput({
      writeOut: (text) => { stdout.push(text) },
      writeErr: (text) => { stderr.push(text) },
    })
  }
  let exitCode: number
  try {
    await program.parseAsync(['node', 'agent-qa', '--config', configPath, ...args])
    exitCode = Number(process.exitCode ?? 0)
  } catch (thrown) {
    if (!(thrown instanceof CommanderError)) throw thrown
    exitCode = thrown.exitCode
  } finally {
    log.mockRestore()
    error.mockRestore()
    process.exitCode = undefined
  }
  return { stdout: stdout.join('\n'), stderr: stderr.join('\n'), exitCode }
}

function json(invocation: Invocation): unknown {
  expect(invocation.exitCode, invocation.stderr).toBe(0)
  return JSON.parse(invocation.stdout) as unknown
}

type WireResult = {
  readonly content: readonly { type: string; text?: string; data?: string }[]
  readonly structuredContent?: unknown
  readonly isError?: boolean
}

async function mcpReader(p: { configPath: string; agentQaRoot: string }) {
  const composed = host.composeCliLocalAgent({ configPath: p.configPath, agentQaRoot: p.agentQaRoot })
  cleanups.push(() => composed.close())
  // tokenless. The client below still sends a legacy reader bearer, which is ignored.
  const masking = composeMcpMasking({ configPath: p.configPath })
  const server = createServer(createMcpHttpRequestListener({
    registry: composed.registry, maskText: (text) => masking.mask(text),
  }))
  await new Promise<void>((listening, fail) => {
    server.once('error', fail)
    server.listen(0, '127.0.0.1', listening)
  })
  cleanups.push(() => new Promise<void>((closed) => server.close(() => closed())))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('MCP did not bind')
  const client = new Client({ name: 'agent-qa-431-07', version: '0.0.0' })
  cleanups.push(() => client.close())
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${String(address.port)}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${READER_TOKEN}` } },
  }))
  return {
    async call(name: string, args: Record<string, unknown>): Promise<WireResult> {
      return await client.callTool({ name, arguments: args }) as unknown as WireResult
    },
    async structured(name: string, args: Record<string, unknown>): Promise<unknown> {
      const result = await client.callTool({ name, arguments: args }) as unknown as WireResult
      const text = result.content.map((block) => block.text ?? '').join('\n')
      expect(result.isError ?? false, text.slice(0, 400)).toBe(false)
      return result.structuredContent
    },
  }
}

/** The SDK wraps a non-object root as `{ result }` on the wire; the op's own value is inside. */
function unwrapped(structured: unknown): unknown {
  const value = structured as { result?: unknown }
  return Array.isArray(value?.result) ? value.result : structured
}

// ---- CLI-RUN-READ-PARITY (07-1) -------------------------------------------------------------------

describe('CLI-RUN-READ-PARITY: runs list, overview and knowledge', () => {
  it('runs list --json equals the MCP list for zero, one and many rows', async () => {
    const empty = fixtureProject('431-07-empty')
    const emptyRoot = join(empty.root, '.agent-qa')
    const emptyMcp = await mcpReader({ configPath: empty.configPath, agentQaRoot: emptyRoot })
    expect(json(await cli(empty.configPath, ['runs', 'list', '--json']))).toEqual([])
    expect(unwrapped(await emptyMcp.structured('agent_qa_list_runs', {}))).toEqual([])
    const emptyHuman = await cli(empty.configPath, ['runs', 'list'])
    expect(emptyHuman.exitCode).toBe(0)
    expect(emptyHuman.stdout).toContain('No completed runs')

    const p = populatedProject()
    const mcp = await mcpReader(p)
    const one = json(await cli(p.configPath, ['runs', 'list', '--json']))
    expect(one).toEqual(unwrapped(await mcp.structured('agent_qa_list_runs', {})))
    expect(one).toMatchObject([{ runId: p.runId, tests: [{ testName: UNICODE_NAME }, { testName: 'Second member' }] }])

    const many = fixtureProject('431-07-many')
    const manyRoot = join(many.root, '.agent-qa')
    const written = [1, 2, 3].map((index) => completedRun(manyRoot, 1_700_000_000_000 + index * 1_000,
      [{ id: `t-${String(index)}`, name: `Checkout ${String(index)}` }], index === 2 ? 'failed' : 'passed'))
    const manyMcp = await mcpReader({ configPath: many.configPath, agentQaRoot: manyRoot })
    const listed = json(await cli(many.configPath, ['runs', 'list', '--json'])) as { runId: string }[]
    expect(listed.map((row) => row.runId)).toEqual([...written].reverse())
    expect(listed).toEqual(unwrapped(await manyMcp.structured('agent_qa_list_runs', {})))
  })

  it('normalizes every list flag into the canonical filter the MCP tool takes', async () => {
    const many = fixtureProject('431-07-flags')
    writeFileSync(join(many.root, '.env.secrets.local'), '')
    const root = join(many.root, '.agent-qa')
    const old = completedRun(root, Date.UTC(2026, 0, 1, 12), [{ id: 't-cart', name: 'Cart totals' }], 'failed')
    const recent = completedRun(root, Date.UTC(2026, 5, 1, 12), [{ id: 't-pay', name: 'Pay now' }], 'failed')
    completedRun(root, Date.UTC(2026, 5, 2, 12), [{ id: 't-pay', name: 'Pay now' }], 'passed')
    const mcp = await mcpReader({ configPath: many.configPath, agentQaRoot: root })
    const cases: [string[], Record<string, unknown>][] = [
      [['--verdict', 'failed'], { verdict: 'failed' }],
      [['--test', 'cart'], { test: 'cart' }],
      [['--target', 'web'], { target: 'web' }],
      [['--since', '2026-03-01T00:00:00+02:00'], { since: Date.UTC(2026, 1, 28, 22) }],
      [['--since', '2026-06-01T12:00:00.000Z'], { since: Date.UTC(2026, 5, 1, 12) }],
      [['--limit', '1'], { limit: 1 }],
      [['--verdict', 'failed', '--since', '2026-01-01T12:00:00Z', '--limit', '1'],
        { verdict: 'failed', since: Date.UTC(2026, 0, 1, 12), limit: 1 }],
    ]
    for (const [flags, input] of cases) {
      const listed = json(await cli(many.configPath, ['runs', 'list', ...flags, '--json']))
      expect(listed, flags.join(' ')).toEqual(unwrapped(await mcp.structured('agent_qa_list_runs', input)))
    }
    const failed = json(await cli(many.configPath, ['runs', 'list', '--verdict', 'failed', '--limit', '1', '--json']))
    expect((failed as { runId: string }[]).map((row) => row.runId)).toEqual([recent])
    const cart = json(await cli(many.configPath, ['runs', 'list', '--test', 'CART', '--json']))
    expect((cart as { runId: string }[]).map((row) => row.runId)).toEqual([old])
  })

  it('runs list masks a declared secret in a test name and --test is no oracle for it', async () => {
    const secret = 'zz-431-list-sentinel-not-a-real-credential'
    const project = fixtureProject('431-07-list-secret')
    writeFileSync(join(project.root, '.env.secrets.local'), `LIST_PASSWORD=${secret}\n`)
    const root = join(project.root, '.agent-qa')
    const runId = completedRun(root, 1_700_000_000_000, [{ id: 't-login', name: `Login as ${secret}` }])
    const mcp = await mcpReader({ configPath: project.configPath, agentQaRoot: root })

    const listed = json(await cli(project.configPath, ['runs', 'list', '--json']))
    expect(listed).toMatchObject([{ runId, tests: [{ testId: 't-login', testName: 'Login as [secret:LIST_PASSWORD]' }] }])
    expect(listed).toEqual(unwrapped(await mcp.structured('agent_qa_list_runs', {})))
    const human = await cli(project.configPath, ['runs', 'list'])
    expect(human.exitCode).toBe(0)
    expect(`${human.stdout}${JSON.stringify(listed)}`).not.toContain(secret)

    for (const probe of [secret, secret.slice(0, 12), secret.slice(-8)]) {
      expect(json(await cli(project.configPath, ['runs', 'list', '--test', probe, '--json'])), probe).toEqual([])
      expect(unwrapped(await mcp.structured('agent_qa_list_runs', { test: probe })), probe).toEqual([])
    }
    const visible = json(await cli(project.configPath, ['runs', 'list', '--test', 'LOGIN AS', '--json']))
    expect((visible as { runId: string }[]).map((row) => row.runId)).toEqual([runId])

    // 2026-10-14 (441-16, E3): without a readable secrets file the list refuses with the loader's message.
    rmSync(join(project.root, '.env.secrets.local'))
    for (const test of ['LOGIN AS', 't-login']) {
      const unmaskable = await cli(project.configPath, ['runs', 'list', '--test', test, '--json'])
      expect(unmaskable.exitCode, test).toBe(1)
      expect(unmaskable.stdout, test).toBe('')
      expect(unmaskable.stderr, test).toMatch(/Secrets file not found/)
    }
  })

  it.each([
    ['--since', '2026-03-01T00:00:00'],
    ['--since', '2026-03-01'],
    ['--since', '2026-02-30T00:00:00Z'],
    ['--since', '2026-03-01T24:00:00Z'],
    ['--since', '2026-03-01T00:00:60Z'],
    ['--since', '1969-12-31T23:59:59Z'],
    ['--since', '2026-03-01T00:00:00.1234Z'],
    ['--since', '1709251200000'],
    ['--limit', '0'],
    ['--limit', '201'],
    ['--limit', '1.5'],
    ['--verdict', 'flaky'],
    ['--test', '   '],
  ])('refuses %s %s with an actionable nonzero exit', async (flag, value) => {
    const project = fixtureProject('431-07-refuse')
    const refused = await cli(project.configPath, ['runs', 'list', flag, value, '--json'])
    expect(refused.exitCode).not.toBe(0)
    expect(refused.stdout).toBe('')
    expect(refused.stderr).toContain(flag)
  })

  it('renders list rows with the run id and test addresses the next command takes', async () => {
    const p = populatedProject()
    const human = await cli(p.configPath, ['runs', 'list'])
    expect(human.exitCode).toBe(0)
    expect(human.stdout).toContain(p.runId)
    expect(human.stdout).toContain(`test 0 · ${p.firstTestId} · ${UNICODE_NAME}`)
    expect(human.stdout).toContain(`test 1 · ${p.secondTestId} · Second member`)
    expect(human.stdout).toContain(`agent-qa runs overview ${p.runId}`)
  })

  it('runs overview --json equals agent_qa_get_run_overview and keeps Unicode unchanged', async () => {
    const p = populatedProject()
    const mcp = await mcpReader(p)
    const overview = json(await cli(p.configPath, ['runs', 'overview', p.runId, '--json']))
    expect(overview).toEqual(await mcp.structured('agent_qa_get_run_overview', { runId: p.runId }))
    expect(overview).toMatchObject({
      runId: p.runId,
      tests: [
        { testIndex: 0, testId: p.firstTestId, name: { text: UNICODE_NAME },
          recording: { state: 'present', address: { runId: p.runId, sha: p.recordingSha } },
          steps: [{ stepIndex: 0, label: { text: UNICODE_STEP }, status: 'failed',
            capture: { state: 'recorded', screenshots: [{ sha: p.screenshotSha }] } }] },
        { testIndex: 1, testId: p.secondTestId },
      ],
    })
  })

  it('renders the overview as addressed lines and names the next fetch', async () => {
    const p = populatedProject()
    const human = await cli(p.configPath, ['runs', 'overview', p.runId])
    expect(human.exitCode, human.stderr).toBe(0)
    const out = human.stdout
    expect(out).toContain(`Run ${p.runId}`)
    expect(out).toContain(`Test 0 · ${p.firstTestId} · ${UNICODE_NAME} · failed`)
    expect(out).toContain(`Test 1 · ${p.secondTestId} · Second member · passed`)
    expect(out).toContain(`step 0 · ${UNICODE_STEP} · failed`)
    expect(out).toContain(`screenshot ${p.screenshotSha}`)
    expect(out).toContain(`recording ${p.recordingSha}`)
    expect(out).toContain('console 2 (1 error)')
    expect(out).toContain('network 1 (1 failed)')
    expect(out).toContain('aria sub-action 0')
    expect(out).toContain(p.recordId)
    expect(out).toContain(`agent-qa runs evidence ${p.runId} --test 0 --step 0 --kind console`)
    expect(out).toContain(`agent-qa runs evidence ${p.runId} --screenshot ${p.screenshotSha} --out`)
    expect(out).toContain(`agent-qa knowledge brief-why ${p.runId} --step 0 --test ${p.firstTestId}`)
    expect(out).not.toContain('TypeError: price is undefined')
  })

  it('runs knowledge --json equals agent_qa_get_run_knowledge and renders step addresses', async () => {
    const p = populatedProject()
    const mcp = await mcpReader(p)
    const knowledge = json(await cli(p.configPath, ['runs', 'knowledge', p.runId, '--json']))
    expect(knowledge).toEqual(await mcp.structured('agent_qa_get_run_knowledge', { runId: p.runId }))
    expect(knowledge).toMatchObject({ kind: 'ready', runId: p.runId, steps: [{ stepText: UNICODE_STEP }, {}] })
    const human = await cli(p.configPath, ['runs', 'knowledge', p.runId])
    expect(human.exitCode, human.stderr).toBe(0)
    expect(human.stdout).toContain(`test 0 · ${p.firstTestId} · step 0 · ${UNICODE_STEP}`)
    expect(human.stdout).toContain(`test 1 · ${p.secondTestId} · step 0`)
    expect(human.stdout).toContain(p.recordId)
    expect(human.stdout).toContain(`agent-qa knowledge show ${p.recordId}`)
  })

  it('exits nonzero with an actionable message for a missing run on overview and knowledge', async () => {
    const p = populatedProject()
    const missing = generateRunId()
    const overview = await cli(p.configPath, ['runs', 'overview', missing, '--json'])
    expect(overview.exitCode).toBe(1)
    expect(overview.stdout).toBe('')
    expect(overview.stderr).toContain(missing)
    expect(overview.stderr).toContain('agent-qa runs list')
    const knowledge = await cli(p.configPath, ['runs', 'knowledge', missing, '--json'])
    expect(knowledge.exitCode).toBe(1)
    expect(JSON.parse(knowledge.stdout)).toEqual({ kind: 'evidence-incomplete', runId: missing })
    expect(knowledge.stderr).toContain('agent-qa runs list')
    const human = await cli(p.configPath, ['runs', 'knowledge', missing])
    expect(human.exitCode).toBe(1)
    expect(human.stdout).toContain(missing)
  })

  it('leaves runs mark registered with its shipped options', () => {
    const runs = createRunsCommand()
    const mark = runs.commands.find((command) => command.name() === 'mark')
    expect(mark?.options.map((option) => option.long)).toEqual([
      '--kind', '--test', '--step', '--note', '--json',
    ])
    expect(runs.commands.map((command) => command.name())).toEqual(
      expect.arrayContaining(['mark', 'list', 'overview', 'knowledge']))
  })
})

// ---- CLI-KNOWLEDGE-PARITY (07-2) ------------------------------------------------------------------

describe('CLI-KNOWLEDGE-PARITY: knowledge show and brief-why', () => {
  it('knowledge show --json equals agent_qa_show_knowledge_record and renders provenance, not the body', async () => {
    const p = populatedProject()
    const mcp = await mcpReader(p)
    const shown = json(await cli(p.configPath, ['knowledge', 'show', p.recordId, '--json']))
    const structured = await mcp.structured('agent_qa_show_knowledge_record', { recordId: p.recordId })
    expect(shown).toEqual(structured)
    expect(shown).toMatchObject({ kind: 'found', record: { recordId: p.recordId } })
    const found = shown as { body: string; summary: string; provenance: { mode: string } }
    const human = await cli(p.configPath, ['knowledge', 'show', p.recordId])
    expect(human.exitCode, human.stderr).toBe(0)
    expect(human.stdout).toContain(`record ${p.recordId}`)
    expect(human.stdout).toContain(`provenance ${found.provenance.mode}`)
    expect(human.stdout).toContain(found.summary)
    expect(found.body.length).toBeGreaterThan(0)
    expect(human.stdout).not.toContain(found.body)
  })

  it('knowledge show exits nonzero for a record no bundle carries, with the canonical not-found result', async () => {
    const p = populatedProject()
    const mcp = await mcpReader(p)
    const missing = await cli(p.configPath, ['knowledge', 'show', 'fact-no-such-record', '--json'])
    expect(missing.exitCode).toBe(1)
    expect(JSON.parse(missing.stdout)).toEqual(
      await mcp.structured('agent_qa_show_knowledge_record', { recordId: 'fact-no-such-record' }))
    expect(missing.stderr).toContain('fact-no-such-record')
    expect(missing.stderr).toContain('agent-qa knowledge inspect')
    const human = await cli(p.configPath, ['knowledge', 'show', 'fact-no-such-record'])
    expect(human.exitCode).toBe(1)
    expect(human.stdout).toContain('not found')
  })

  it('brief-why selects the brief by test id, equals agent_qa_explain_brief and keeps the trace in JSON', async () => {
    const p = populatedProject()
    const mcp = await mcpReader(p)
    const first = json(await cli(p.configPath, ['knowledge', 'brief-why', p.runId, '--step', '0', '--test', p.firstTestId, '--json']))
    expect(first).toEqual(await mcp.structured('agent_qa_explain_brief', { runId: p.runId, stepIndex: 0, testId: p.firstTestId }))
    expect(first).toMatchObject({ kind: 'answered', trace: { servedLines: [{ recordId: p.recordId, leg: 'lexical', rank: 1 }] } })
    const second = json(await cli(p.configPath, ['knowledge', 'brief-why', p.runId, '--step', '0', '--test', p.secondTestId, '--json']))
    expect(second).toEqual(await mcp.structured('agent_qa_explain_brief', { runId: p.runId, stepIndex: 0, testId: p.secondTestId }))
    expect(second).toMatchObject({ kind: 'answered', trace: { servedLines: [{ recordId: p.recordId, leg: 'dense', rank: 2 }] } })
    const filtered = json(await cli(p.configPath, [
      'knowledge', 'brief-why', p.runId, '--step', '0', '--test', p.firstTestId, '--record', 'fact-elsewhere', '--json']))
    expect(filtered).toEqual(await mcp.structured('agent_qa_explain_brief',
      { runId: p.runId, stepIndex: 0, testId: p.firstTestId, recordId: 'fact-elsewhere' }))
    expect(filtered).toMatchObject({ kind: 'answered', trace: { servedLines: [], truncated: [] } })

    const human = await cli(p.configPath, ['knowledge', 'brief-why', p.runId, '--step', '0', '--test', p.firstTestId])
    expect(human.exitCode, human.stderr).toBe(0)
    expect(human.stdout).toContain(`run ${p.runId} · test ${p.firstTestId} · step 0`)
    expect(human.stdout).toContain(`served ${p.recordId} · lexical · rank 1 · score 1.5`)
    expect(human.stdout).toContain(`agent-qa knowledge show ${p.recordId}`)
  })

  it('brief-why treats --test as a test id, never an index, and refuses an ambiguous step', async () => {
    const p = populatedProject()
    const byIndex = await cli(p.configPath, ['knowledge', 'brief-why', p.runId, '--step', '0', '--test', '1', '--json'])
    expect(byIndex.exitCode).toBe(1)
    expect(JSON.parse(byIndex.stdout)).toEqual({ kind: 'no-trace', reason: 'step-not-found' })
    expect(byIndex.stderr).toContain('agent-qa runs overview')
    const ambiguous = await cli(p.configPath, ['knowledge', 'brief-why', p.runId, '--step', '0', '--json'])
    expect(ambiguous.exitCode).toBe(1)
    expect(ambiguous.stdout).toBe('')
    expect(ambiguous.stderr).toContain(p.firstTestId)
    expect(ambiguous.stderr).toContain(p.secondTestId)
    expect(ambiguous.stderr).toContain('--test')
  })

  it('brief-why exits nonzero for a missing run and a missing step', async () => {
    const p = populatedProject()
    const mcp = await mcpReader(p)
    const missingRun = generateRunId()
    const run = await cli(p.configPath, ['knowledge', 'brief-why', missingRun, '--step', '0', '--json'])
    expect(run.exitCode).toBe(1)
    expect(JSON.parse(run.stdout)).toEqual(await mcp.structured('agent_qa_explain_brief', { runId: missingRun, stepIndex: 0 }))
    expect(JSON.parse(run.stdout)).toEqual({ kind: 'no-trace', reason: 'artifact-missing' })
    const step = await cli(p.configPath, ['knowledge', 'brief-why', p.runId, '--step', '7', '--test', p.firstTestId])
    expect(step.exitCode).toBe(1)
    expect(step.stdout).toContain('step-not-found')
  })

  it.each(['-1', '1.5', 'abc', '9007199254740993'])('brief-why refuses --step %s', async (value) => {
    const p = populatedProject()
    const refused = await cli(p.configPath, ['knowledge', 'brief-why', p.runId, '--step', value, '--json'])
    expect(refused.exitCode).not.toBe(0)
    expect(refused.stdout).toBe('')
    expect(refused.stderr).toContain('--step')
  })

  it('requires --step on brief-why', async () => {
    const p = populatedProject()
    const refused = await cli(p.configPath, ['knowledge', 'brief-why', p.runId, '--json'])
    expect(refused.exitCode).not.toBe(0)
    expect(refused.stderr).toContain('--step')
  })
})

// ---- CLI-EVIDENCE-PARITY, EXPORT-BYTE-IDENTITY, EXPORT-ATOMIC (07-3) -----------------------------

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function outDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agent-qa-431-07-out-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

const DOCUMENT_CASES: readonly [string, string[], Record<string, unknown>, Record<string, unknown>][] = [
  ['console', ['--kind', 'console'], { kind: 'console' },
    { outcome: 'ready', document: { kind: 'console', records: [{ text: 'TypeError: price is undefined — 価格' }, {}] } }],
  ['network', ['--kind', 'network'], { kind: 'network' },
    { outcome: 'ready', document: { kind: 'network', records: [{ url: 'https://app.test/api/cart?q=ümlaut' }] } }],
  ['a11y', ['--kind', 'a11y'], { kind: 'a11y' },
    { outcome: 'absent', evidence: { kind: 'a11y', state: 'absent', reason: 'unsupported' } }],
  ['variables', ['--kind', 'variables'], { kind: 'variables' },
    { outcome: 'absent', evidence: { kind: 'variables', state: 'absent', reason: 'empty' } }],
  ['aria', ['--kind', 'aria', '--sub-action', '0'], { kind: 'aria', subActionIndex: 0 },
    { outcome: 'ready', document: { kind: 'aria', tree: '- button "Payer ✓"' } }],
]

describe('CLI-EVIDENCE-PARITY: runs evidence documents over runs.evidence', () => {
  it.each(DOCUMENT_CASES)('%s --json equals agent_qa_get_run_evidence', async (_label, flags, input, shape) => {
    const p = populatedProject()
    const mcp = await mcpReader(p)
    const fetched = json(await cli(p.configPath, ['runs', 'evidence', p.runId, '--test', '0', '--step', '0', ...flags, '--json']))
    expect(fetched).toEqual(await mcp.structured('agent_qa_get_run_evidence',
      { action: 'runs.evidence', runId: p.runId, testIndex: 0, stepIndex: 0, ...input }))
    expect(fetched).toMatchObject({ address: { runId: p.runId, testIndex: 0, stepIndex: 0, ...input }, ...shape })
  })

  it('renders a document as an addressed summary and leaves the body to --json', async () => {
    const p = populatedProject()
    const consoleHuman = await cli(p.configPath, ['runs', 'evidence', p.runId, '--test', '0', '--step', '0', '--kind', 'console'])
    expect(consoleHuman.exitCode, consoleHuman.stderr).toBe(0)
    expect(consoleHuman.stdout).toContain(`console evidence · run ${p.runId} · test 0 · step 0 · ready · 2 records`)
    expect(consoleHuman.stdout).toContain('--json')
    expect(consoleHuman.stdout).not.toContain('TypeError: price is undefined')
    const aria = await cli(p.configPath, ['runs', 'evidence', p.runId, '--test', '0', '--step', '0', '--kind', 'aria', '--sub-action', '0'])
    expect(aria.stdout).toContain(`aria evidence · run ${p.runId} · test 0 · step 0 · sub-action 0 · ready`)
    expect(aria.stdout).not.toContain('Payer')
    const absent = await cli(p.configPath, ['runs', 'evidence', p.runId, '--test', '0', '--step', '0', '--kind', 'a11y'])
    expect(absent.exitCode).toBe(0)
    expect(absent.stdout).toContain('absent (unsupported)')
  })

  it('exits nonzero for an address with no recorded step and for a missing run', async () => {
    const p = populatedProject()
    const mcp = await mcpReader(p)
    const step = await cli(p.configPath, ['runs', 'evidence', p.runId, '--test', '0', '--step', '5', '--kind', 'console', '--json'])
    expect(step.exitCode).toBe(1)
    expect(JSON.parse(step.stdout)).toEqual(await mcp.structured('agent_qa_get_run_evidence',
      { action: 'runs.evidence', runId: p.runId, testIndex: 0, stepIndex: 5, kind: 'console' }))
    expect(JSON.parse(step.stdout)).toMatchObject({ outcome: 'read-error', code: 'address-not-found' })
    expect(step.stderr).toContain(`agent-qa runs overview ${p.runId}`)
    const run = await cli(p.configPath, ['runs', 'evidence', generateRunId(), '--test', '0', '--step', '0', '--kind', 'console'])
    expect(run.exitCode).toBe(1)
    expect(run.stdout).toBe('')
    expect(run.stderr).toContain('agent-qa runs list')
  })

  it.each([
    [['--test', '0', '--step', '0', '--kind', 'console', '--screenshot', 'a'.repeat(64), '--out', 'x.png'], 'not both'],
    [[], '--screenshot'],
    [['--test', '0', '--kind', 'console'], '--step'],
    [['--step', '0', '--kind', 'console'], '--test'],
    [['--test', '0', '--step', '0'], '--kind'],
    [['--test', '0', '--step', '0', '--kind', 'console', '--sub-action', '0'], '--sub-action'],
    [['--test', '0', '--step', '0', '--kind', 'console', '--range-start', '0', '--range-end', '1'], 'not both'],
    [['--test', '0', '--step', '0', '--kind', 'screenshot'], '--kind'],
    [['--test', '-1', '--step', '0', '--kind', 'console'], '--test'],
    [['--screenshot', 'a'.repeat(64)], '--out'],
    [['--out', 'x.png'], '--screenshot'],
    [['--screenshot', 'not-a-sha', '--out', 'x.png'], '--screenshot'],
    [['--screenshot', 'a'.repeat(64), '--out', 'x.png', '--range-start', '0'], '--range-end'],
    [['--screenshot', 'a'.repeat(64), '--out', 'x.png', '--range-end', '3'], '--range-start'],
    [['--screenshot', 'a'.repeat(64), '--out', 'x.png', '--range-start', '5', '--range-end', '3'], '--range-end'],
  ])('refuses conflicting or incomplete options %j', async (flags, named) => {
    const p = populatedProject()
    const refused = await cli(p.configPath, ['runs', 'evidence', p.runId, ...flags, '--json'])
    expect(refused.exitCode).not.toBe(0)
    expect(refused.stdout).toBe('')
    expect(refused.stderr).toContain(named)
    expect(existsSync(join(p.root, 'x.png'))).toBe(false)
  })
})

describe('EXPORT-BYTE-IDENTITY: runs evidence --screenshot writes the addressed bytes', () => {
  it('exports a screenshot byte for byte and --json equals the MCP artifact result', async () => {
    const p = populatedProject()
    const mcp = await mcpReader(p)
    const out = join(outDir(), 'shot.png')
    const exported = await cli(p.configPath, ['runs', 'evidence', p.runId, '--screenshot', p.screenshotSha, '--out', out, '--json'])
    expect(exported.exitCode, exported.stderr).toBe(0)
    const canonical = await mcp.call('agent_qa_get_run_evidence', { action: 'runs.artifact', runId: p.runId, sha: p.screenshotSha })
    expect(canonical.isError ?? false).toBe(false)
    expect(JSON.parse(exported.stdout)).toEqual(canonical.structuredContent)
    expect(canonical.content.filter((block) => block.type === 'image').map((block) => block.data)).toEqual([PNG_BASE64])
    expect(new Uint8Array(readFileSync(out))).toEqual(PNG)
    expect(sha256(readFileSync(out))).toBe(p.screenshotSha)
    expect(exported.stderr).toContain(`wrote ${out}`)
    expect(exported.stderr).toContain('image/png')
    expect(exported.stdout).not.toContain('wrote')

    const second = join(outDir(), 'again.png')
    const human = await cli(p.configPath, ['runs', 'evidence', p.runId, '--screenshot', p.screenshotSha, '--out', second])
    expect(human.exitCode, human.stderr).toBe(0)
    expect(human.stdout).toContain(`wrote ${second} · image/png · ${String(PNG.length)} bytes · sha256 ${p.screenshotSha}`)
  })

  it('exports a recording the MCP evidence tool refuses to relay', async () => {
    const p = populatedProject()
    const mcp = await mcpReader(p)
    const out = join(outDir(), 'member-0.webm')
    const exported = await cli(p.configPath, ['runs', 'evidence', p.runId, '--screenshot', p.recordingSha, '--out', out, '--json'])
    expect(exported.exitCode, exported.stderr).toBe(0)
    expect(new Uint8Array(readFileSync(out))).toEqual(WEBM)
    expect(sha256(readFileSync(out))).toBe(p.recordingSha)
    expect(JSON.parse(exported.stdout)).toMatchObject({ sha: p.recordingSha, contentType: 'video/webm', byteLength: WEBM.length })
    const refused = await mcp.call('agent_qa_get_run_evidence', { action: 'runs.artifact', runId: p.runId, sha: p.recordingSha })
    expect(refused.isError).toBe(true)
  })

  it('exports an inclusive byte range the function door serves and the MCP tool refuses', async () => {
    const p = populatedProject()
    const mcp = await mcpReader(p)
    const out = join(outDir(), 'slice.bin')
    const exported = await cli(p.configPath, ['runs', 'evidence', p.runId, '--screenshot', p.recordingSha, '--out', out,
      '--range-start', '4', '--range-end', '19', '--json'])
    expect(exported.exitCode, exported.stderr).toBe(0)
    expect(new Uint8Array(readFileSync(out))).toEqual(WEBM.slice(4, 20))
    const composed = realCompose({ configPath: p.configPath, agentQaRoot: p.agentQaRoot })
    cleanups.push(() => composed.close())
    const functionDoor = await invokeFunction(composed.registry, RUNS_ARTIFACT_FUNCTION_ID,
      { runId: p.runId, sha: p.recordingSha, range: { start: 4, end: 19 } }, host.CLI_FUNCTION_CALLER)
    expect(JSON.parse(exported.stdout)).toEqual(functionDoor)
    expect(functionDoor).toMatchObject({ range: { start: 4, end: 19 }, totalLength: WEBM.length, byteLength: 16 })
    expect(exported.stderr).toContain(`bytes 4-19 of ${String(WEBM.length)}`)
    const refused = await mcp.call('agent_qa_get_run_evidence',
      { action: 'runs.artifact', runId: p.runId, sha: p.screenshotSha, range: { start: 0, end: 7 } })
    expect(refused.isError).toBe(true)
    expect(refused.content.map((block) => block.text ?? '').join('')).toContain('artifact-range-fragment')
  })

  it('exits nonzero and writes nothing for a sha the run does not hold', async () => {
    const p = populatedProject()
    const dir = outDir()
    const refused = await cli(p.configPath, ['runs', 'evidence', p.runId, '--screenshot', 'b'.repeat(64), '--out', join(dir, 'none.png')])
    expect(refused.exitCode).toBe(1)
    expect(refused.stdout).toBe('')
    expect(refused.stderr).toContain('No evidence blob is recorded')
    expect(readdirSync(dir)).toEqual([])
  })
})

describe('EXPORT-ATOMIC: exclusive publication that never overwrites', () => {
  it('refuses an existing file, a symlink, a hard link and a directory, leaving each unchanged', async () => {
    const p = populatedProject()
    const dir = outDir()
    const existing = join(dir, 'existing.png')
    writeFileSync(existing, 'keep me')
    const elsewhere = join(dir, 'elsewhere.txt')
    writeFileSync(elsewhere, 'target bytes')
    const link = join(dir, 'link.png')
    symlinkSync(elsewhere, link)
    const dangling = join(dir, 'dangling.png')
    symlinkSync(join(dir, 'nowhere.png'), dangling)
    const hard = join(dir, 'hard.png')
    linkSync(elsewhere, hard)
    const directory = join(dir, 'directory.png')
    mkdirSync(directory)
    for (const [destination, kind] of [[existing, 'regular file'], [link, 'symbolic link'], [dangling, 'symbolic link'],
      [hard, 'hard-linked file'], [directory, 'directory']] as const) {
      const refused = await cli(p.configPath, ['runs', 'evidence', p.runId, '--screenshot', p.screenshotSha, '--out', destination])
      expect(refused.exitCode, destination).toBe(1)
      expect(refused.stderr).toContain(kind)
      expect(refused.stderr).toContain('not overwritten')
    }
    expect(readFileSync(existing, 'utf8')).toBe('keep me')
    expect(readFileSync(elsewhere, 'utf8')).toBe('target bytes')
    expect(readlinkSync(link)).toBe(elsewhere)
    expect(lstatSync(dangling).isSymbolicLink()).toBe(true)
    expect(existsSync(join(dir, 'nowhere.png'))).toBe(false)
    expect(lstatSync(hard).nlink).toBe(2)
    expect(readdirSync(directory)).toEqual([])
    expect(readdirSync(dir).filter((name) => name.endsWith('.tmp'))).toEqual([])
  })

  it('creates no parent directory and exports through a symlinked parent, never over a symlinked file', async () => {
    const p = populatedProject()
    const dir = outDir()
    const missing = await cli(p.configPath, ['runs', 'evidence', p.runId, '--screenshot', p.screenshotSha, '--out', join(dir, 'new', 'shot.png')])
    expect(missing.exitCode).toBe(1)
    expect(missing.stderr).toContain('does not exist')
    expect(existsSync(join(dir, 'new'))).toBe(false)
    mkdirSync(join(dir, 'real'))
    symlinkSync(join(dir, 'real'), join(dir, 'alias'))
    const aliased = await cli(p.configPath, ['runs', 'evidence', p.runId, '--screenshot', p.screenshotSha, '--out', join(dir, 'alias', 'shot.png')])
    expect(aliased.exitCode, aliased.stderr).toBe(0)
    expect(new Uint8Array(readFileSync(join(dir, 'real', 'shot.png')))).toEqual(PNG)
    expect(readdirSync(join(dir, 'real'))).toEqual(['shot.png'])
    symlinkSync(join(dir, 'real', 'shot.png'), join(dir, 'real', 'link.png'))
    const overLink = await cli(p.configPath, ['runs', 'evidence', p.runId, '--screenshot', p.screenshotSha, '--out', join(dir, 'alias', 'link.png')])
    expect(overLink.exitCode).toBe(1)
    expect(overLink.stderr).toContain('symbolic link')
    const fileParent = await cli(p.configPath, ['runs', 'evidence', p.runId, '--screenshot', p.screenshotSha, '--out', join(dir, 'real', 'shot.png', 'x.png')])
    expect(fileParent.exitCode).toBe(1)
    expect(fileParent.stderr).toContain('not a directory')
  })

  it('loses a publication race without touching the winner, and cleans only its own temporary', () => {
    const dir = outDir()
    const destination = join(dir, 'race.png')
    const foreign = join(dir, '.race.png.agent-qa-export-1-foreign.tmp')
    writeFileSync(foreign, 'someone else')
    const winner = Uint8Array.from([1, 2, 3, 4])
    let owned: string | undefined
    expect(() => exportArtifactBytes({ destination, bytes: PNG, sha256: sha256(PNG) }, {
      beforePublish(temporary) {
        owned = temporary
        expect(existsSync(temporary)).toBe(true)
        exportArtifactBytes({ destination, bytes: winner, sha256: sha256(winner) })
      },
    })).toThrow(/appeared during export/u)
    expect(new Uint8Array(readFileSync(destination))).toEqual(winner)
    expect(owned).toBeDefined()
    expect(existsSync(owned!)).toBe(false)
    expect(readFileSync(foreign, 'utf8')).toBe('someone else')
    expect(readdirSync(dir).sort()).toEqual(['.race.png.agent-qa-export-1-foreign.tmp', 'race.png'])
  })

  it('leaves no destination and no owned temporary when interrupted before publication', () => {
    const dir = outDir()
    const destination = join(dir, 'interrupted.png')
    const foreign = join(dir, '.interrupted.png.agent-qa-export-2-foreign.tmp')
    writeFileSync(foreign, 'not mine')
    expect(() => exportArtifactBytes({ destination, bytes: PNG, sha256: sha256(PNG) }, {
      beforePublish() { throw new Error('SIGINT') },
    })).toThrow('SIGINT')
    expect(existsSync(destination)).toBe(false)
    expect(readdirSync(dir)).toEqual(['.interrupted.png.agent-qa-export-2-foreign.tmp'])
  })

  it('refuses bytes that do not hash to the address before writing anything', () => {
    const dir = outDir()
    const destination = join(dir, 'tampered.png')
    expect(() => exportArtifactBytes({ destination, bytes: PNG, sha256: 'c'.repeat(64) })).toThrow(/sha256/u)
    expect(readdirSync(dir)).toEqual([])
  })
})

describe('DEDICATED-READ-VERBS: the manifest table matches the live verbs', () => {
  it('names every new verb, its flags and the ops it invokes', () => {
    const program = new Command().addCommand(createRunsCommand()).addCommand(createKnowledgeCommand())
    const live = (path: string) => path.split(' ').reduce<Command | undefined>(
      (parent, name) => parent?.commands.find((command) => command.name() === name), program)
    expect(DEDICATED_READ_VERBS.map((entry) => entry.verb)).toEqual([
      'runs list', 'runs overview', 'runs knowledge', 'runs evidence', 'knowledge show', 'knowledge brief-why',
    ])
    const composed = realCompose(fixtureProjectPaths())
    cleanups.push(() => composed.close())
    const declared = new Set(composed.registry.list(host.CLI_FUNCTION_CALLER).map((declaration) => declaration.id))
    const projected = new Set(AGENT_QA_TOOL_PROJECTIONS.flatMap((projection) => [...projection.ops]))
    for (const entry of DEDICATED_READ_VERBS) {
      expect(live(entry.verb)?.options.map((option) => option.long), entry.verb).toEqual([...entry.flags])
      for (const opId of entry.opIds) {
        expect(declared.has(opId), opId).toBe(true)
        expect(projected.has(opId), opId).toBe(true)
      }
    }
  })
})

describe('RUN-DETAIL-BINDING: the CLI host over the project runs database', () => {
  it('retries a run-detail open that failed instead of keeping the failure for the host', async () => {
    const p = populatedProject()
    runDetailDbPath = undefined
    const aside = `${p.dbPath}.aside`
    renameSync(p.dbPath, aside)
    writeFileSync(p.dbPath, 'not a database')
    const composed = host.composeCliLocalAgent({ configPath: p.configPath, agentQaRoot: p.agentQaRoot })
    cleanups.push(() => composed.close())
    const overview = () => invokeFunction(composed.registry, 'runs.overview', { runId: p.runId },
      host.CLI_FUNCTION_CALLER)
    await expect(overview()).rejects.toThrow()
    rmSync(p.dbPath)
    renameSync(aside, p.dbPath)
    await expect(overview()).resolves.toMatchObject({ runId: p.runId, tests: [{ testIndex: 0 }, { testIndex: 1 }] })
  })

  it('never opens a legacy dashboard.db, and reads runs.db in the same host once the writer renames it', async () => {
    const p = populatedProject()
    runDetailDbPath = undefined
    const legacy = join(p.agentQaRoot, 'dashboard.db')
    renameSync(p.dbPath, legacy)
    const composed = host.composeCliLocalAgent({ configPath: p.configPath, agentQaRoot: p.agentQaRoot })
    cleanups.push(() => composed.close())
    const overview = () => invokeFunction(composed.registry, 'runs.overview', { runId: p.runId },
      host.CLI_FUNCTION_CALLER)
    await expect(overview())
      .resolves.toMatchObject({ runId: p.runId, tests: [{ steps: [{ capture: { state: 'unavailable' } }] }, {}] })
    expect(existsSync(legacy)).toBe(true)
    expect(existsSync(p.dbPath)).toBe(false)
    renameSync(legacy, p.dbPath)
    await expect(overview())
      .resolves.toMatchObject({ runId: p.runId, tests: [{ steps: [{ capture: { state: 'recorded' } }] }, {}] })
  })
})

function fixtureProjectPaths(): { configPath: string; agentQaRoot: string } {
  const project = fixtureProject('431-07-registry')
  return { configPath: project.configPath, agentQaRoot: join(project.root, '.agent-qa') }
}

// ---- The built CLI --------------------------------------------------------------------------------

describe('BUILT-CLI-RUN-READS: the shipped binary answers the run reads', () => {
  beforeAll(() => {
    expect(buildFreshness(), REBUILD_INSTRUCTION).toEqual({ missing: [], stale: [] })
  })

  it('lists and reads a completed run through dist/cli.js', async () => {
    const p = populatedProject()
    const listed = await spawnCollecting(p.root, [CLI_ENTRY, '--config', p.configPath, 'runs', 'list', '--json'])
    expect(listed.stderr).toBe('')
    expect(listed.code).toBe(0)
    expect((JSON.parse(listed.stdout) as { runId: string }[]).map((row) => row.runId)).toEqual([p.runId])
    const knowledge = await spawnCollecting(p.root, [CLI_ENTRY, '--config', p.configPath, 'runs', 'knowledge', p.runId, '--json'])
    expect(knowledge.code, knowledge.stderr).toBe(0)
    expect(JSON.parse(knowledge.stdout)).toMatchObject({ kind: 'ready', runId: p.runId })
    const missing = await spawnCollecting(p.root, [CLI_ENTRY, '--config', p.configPath, 'runs', 'overview', generateRunId()])
    expect(missing.code).toBe(1)
    expect(missing.stdout).toBe('')
    const shown = await spawnCollecting(p.root, [CLI_ENTRY, '--config', p.configPath, 'knowledge', 'show', p.recordId, '--json'])
    expect(shown.code, shown.stderr).toBe(0)
    expect(JSON.parse(shown.stdout)).toMatchObject({ kind: 'found', record: { recordId: p.recordId } })
    const why = await spawnCollecting(p.root, [CLI_ENTRY, '--config', p.configPath, 'knowledge', 'brief-why', p.runId,
      '--step', '0', '--test', p.secondTestId, '--json'])
    expect(why.code, why.stderr).toBe(0)
    expect(JSON.parse(why.stdout)).toMatchObject({ kind: 'answered', trace: { servedLines: [{ leg: 'dense' }] } })
  }, 60_000)

  it('reads a populated overview and every evidence document through dist/cli.js equal to MCP', async () => {
    const p = populatedProject()
    const mcp = await mcpReader(p)
    const overview = await spawnCollecting(p.root, [CLI_ENTRY, '--config', p.configPath, 'runs', 'overview', p.runId, '--json'])
    expect(overview.code, overview.stderr).toBe(0)
    expect(JSON.parse(overview.stdout)).toEqual(await mcp.structured('agent_qa_get_run_overview', { runId: p.runId }))
    for (const [, flags, input] of DOCUMENT_CASES) {
      const document = await spawnCollecting(p.root, [CLI_ENTRY, '--config', p.configPath, 'runs', 'evidence', p.runId,
        '--test', '0', '--step', '0', ...flags, '--json'])
      expect(document.code, document.stderr).toBe(0)
      expect(JSON.parse(document.stdout)).toEqual(await mcp.structured('agent_qa_get_run_evidence',
        { action: 'runs.evidence', runId: p.runId, testIndex: 0, stepIndex: 0, ...input }))
    }
  }, 120_000)

  it('answers overview and refuses evidence documents by run, creating no database, when the project has none', async () => {
    const p = populatedProject()
    for (const suffix of ['', '-wal', '-shm']) rmSync(`${p.dbPath}${suffix}`, { force: true })
    const overview = await spawnCollecting(p.root, [CLI_ENTRY, '--config', p.configPath, 'runs', 'overview', p.runId, '--json'])
    expect(overview.code, overview.stderr).toBe(0)
    expect(overview.stderr).not.toContain('not bound')
    expect((JSON.parse(overview.stdout) as { tests: { steps: { capture: { state: string } }[] }[] })
      .tests[0]!.steps[0]!.capture.state).toBe('unavailable')
    const document = await spawnCollecting(p.root, [CLI_ENTRY, '--config', p.configPath, 'runs', 'evidence', p.runId,
      '--test', '0', '--step', '0', '--kind', 'console', '--json'])
    expect(document.code).toBe(1)
    expect(document.stderr).toContain('No completed run recorded for id')
    expect(document.stderr).toContain('in the runs database')
    expect(document.stderr).not.toContain('not bound')
    expect(readdirSync(p.agentQaRoot).filter((name) => name.startsWith('runs.db'))).toEqual([])
  }, 60_000)

  it('exports a screenshot byte for byte through dist/cli.js', async () => {
    const p = populatedProject()
    const out = join(outDir(), 'shot.png')
    const exported = await spawnCollecting(p.root, [CLI_ENTRY, '--config', p.configPath, 'runs', 'evidence', p.runId,
      '--screenshot', p.screenshotSha, '--out', out])
    expect(exported.code, exported.stderr).toBe(0)
    expect(new Uint8Array(readFileSync(out))).toEqual(PNG)
    expect(exported.stdout).toContain(`sha256 ${p.screenshotSha}`)
  }, 60_000)

  it('lets exactly one of several concurrent exports to one destination publish, completely', async () => {
    const p = populatedProject()
    for (let round = 0; round < 4; round += 1) {
      const dir = outDir()
      const out = join(dir, 'contended.webm')
      const racers = await Promise.all(Array.from({ length: 3 }, () => spawnCollecting(p.root, [CLI_ENTRY, '--config',
        p.configPath, 'runs', 'evidence', p.runId, '--screenshot', p.recordingSha, '--out', out])))
      const winners = racers.filter((racer) => racer.code === 0)
      expect(winners, JSON.stringify(racers.map((racer) => [racer.code, racer.stderr]))).toHaveLength(1)
      for (const loser of racers.filter((racer) => racer.code !== 0)) {
        expect(loser.code).toBe(1)
        expect(loser.stderr).toContain('not overwritten')
      }
      expect(new Uint8Array(readFileSync(out))).toEqual(WEBM)
      expect(readdirSync(dir)).toEqual(['contended.webm'])
    }
  }, 120_000)
})

describe('RUN-DETAIL-LATE-DATABASE: one stdio agent-qa mcp session reads a runs database that appears after it started', () => {
  beforeAll(() => {
    expect(buildFreshness(), REBUILD_INSTRUCTION).toEqual({ missing: [], stale: [] })
  })

  it('answers the overview and both evidence arms, populated, in the same session once the database appears', async () => {
    const p = populatedProject()
    const aside = (suffix: string) => join(p.agentQaRoot, `pending-runs-database${suffix}`)
    const moved = ['-wal', '-shm', ''].filter((suffix) => existsSync(`${p.dbPath}${suffix}`))
    for (const suffix of moved) renameSync(`${p.dbPath}${suffix}`, aside(suffix))
    const databaseEntries = () => readdirSync(p.agentQaRoot).filter((name) => name.startsWith('runs.db'))
    expect(databaseEntries()).toEqual([])

    const env = Object.fromEntries(Object.entries(process.env)
      .filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
    const transport = new StdioClientTransport({
      command: process.execPath, args: [CLI_ENTRY, '--config', p.configPath, 'mcp'], cwd: p.root, env, stderr: 'pipe',
    })
    let stderr = ''
    transport.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
    const client = new Client({ name: 'agent-qa-431-15-late-db', version: '0.0.0' })
    cleanups.push(async () => {
      await client.close().catch(() => {})
      await transport.close().catch(() => {})
    })
    await client.connect(transport)
    const call = async (name: string, args: Record<string, unknown>) =>
      await client.callTool({ name, arguments: args }) as unknown as WireResult
    const textOf = (result: WireResult) =>
      result.content.filter((block) => block.type === 'text').map((block) => block.text ?? '').join('\n')
    const why = (result: WireResult) => `${textOf(result).slice(0, 400)}\nstderr: ${stderr.slice(0, 400)}`
    const overviewArgs = { runId: p.runId }
    const consoleArgs = { action: 'runs.evidence', runId: p.runId, testIndex: 0, stepIndex: 0, kind: 'console' }

    const early = await call('agent_qa_get_run_overview', overviewArgs)
    expect(early.isError ?? false, why(early)).toBe(false)
    expect(textOf(early), why(early)).not.toContain('not bound')
    expect(early.structuredContent, why(early))
      .toMatchObject({ tests: [{ testIndex: 0, steps: [{ stepIndex: 0, capture: { state: 'unavailable' } }] }, {}] })
    const earlyDocument = await call('agent_qa_get_run_evidence', consoleArgs)
    expect(earlyDocument.isError, why(earlyDocument)).toBe(true)
    expect(textOf(earlyDocument), why(earlyDocument)).toContain('No completed run recorded for id')
    expect(textOf(earlyDocument), why(earlyDocument)).toContain('in the runs database')
    expect(textOf(earlyDocument), why(earlyDocument)).not.toContain('not bound')
    expect(databaseEntries()).toEqual([])

    for (const suffix of moved) renameSync(aside(suffix), `${p.dbPath}${suffix}`)

    const late = await call('agent_qa_get_run_overview', overviewArgs)
    expect(late.isError ?? false, why(late)).toBe(false)
    expect(late.structuredContent, why(late))
      .toMatchObject({ tests: [{ testIndex: 0, steps: [{ stepIndex: 0, capture: { state: 'recorded' } }] }, {}] })
    const lateDocument = await call('agent_qa_get_run_evidence', consoleArgs)
    expect(lateDocument.isError ?? false, why(lateDocument)).toBe(false)
    expect(lateDocument.structuredContent, why(lateDocument)).toMatchObject({
      outcome: 'ready', document: { kind: 'console', records: [{ level: 'error' }, { level: 'warning' }] },
    })
    expect((lateDocument.structuredContent as { document: { records: unknown[] } }).document.records).toHaveLength(2)
    const image = await call('agent_qa_get_run_evidence', { action: 'runs.artifact', runId: p.runId, sha: p.screenshotSha })
    expect(image.isError ?? false, why(image)).toBe(false)
    expect(image.content.filter((block) => block.type === 'image'))
      .toEqual([{ type: 'image', data: PNG_BASE64, mimeType: 'image/png' }])
  }, 90_000)
})
