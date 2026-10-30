// Each child spawns built `dist/cli.js` under the embedding-runtime trap; run `pnpm build` first.

import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { DashboardDatabase } from '@vostride/agent-qa-dashboard'
import { resolveModelCacheDir } from '@vostride/agent-qa-knowledge-local'
import { FsEvidenceArtifactStore } from '@vostride/agent-qa-runner-local'
import {
  RETRIEVAL_TRACE_SCHEMA_VERSION,
  RUN_EVIDENCE_DOCUMENT_SCHEMA_VERSION,
} from '@vostride/agent-qa-schema'
import type { EvidenceDocument } from '@vostride/agent-qa-schema'
import { afterEach, describe, expect, it } from 'vitest'

import { markFixture } from '../gates/__tests__/feedback-fixture.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const CLI_ENTRY = resolve(HERE, '../../dist/cli.js')
const WORKSPACE = resolve(HERE, '../../../..')
const KNOWLEDGE_LOCAL = join(WORKSPACE, 'packages', 'knowledge-local')
const TRAP_PATH = join(WORKSPACE, 'scripts', 'embedding-runtime-trap.mjs')
const LINT_PATH = join(WORKSPACE, 'scripts', 'lint-discovery-imports.mjs')

interface TrapRecord { readonly event: string; readonly kind?: string; readonly identity?: string; readonly forbidden?: readonly string[] }
interface TrapModule {
  readonly TRAP_REPORT_ENV: string
  readonly TRAP_SENTINEL: string
  readonly TRAP_URL: string
  modelCacheDirFor(env: Record<string, string | undefined>): string
  readTrapReport(text: string): {
    readonly installed: readonly TrapRecord[]
    readonly observed: readonly string[]
    readonly violations: readonly TrapRecord[]
    readonly problems: readonly string[]
  }
}
interface LintModule {
  readonly PINNED_FORBIDDEN_RUNTIME: readonly string[]
  readonly PINNED_ACQUISITION_ROOTS: readonly string[]
  deriveForbiddenRuntime(): { readonly roots: readonly string[]; readonly names: readonly string[] }
}
const trap = await import(pathToFileURL(TRAP_PATH).href) as TrapModule
const lint = await import(pathToFileURL(LINT_PATH).href) as LintModule

const READER = 'zz-reader-credential-71d0c4'
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
const PNG = Uint8Array.from(atob(PNG_BASE64), (char) => char.charCodeAt(0))
const NETWORK: Extract<EvidenceDocument, { kind: 'network' }> = {
  schemaVersion: RUN_EVIDENCE_DOCUMENT_SCHEMA_VERSION, kind: 'network', records: [{
    url: 'https://app.test/api/cart', method: 'GET', status: 500,
    requestHeaders: { accept: 'application/json' }, responseHeaders: { 'content-type': 'application/json' },
    body: 'cart unavailable', startTime: 1, endTime: 2,
  }],
}

type Block = { readonly type: string; readonly text?: string; readonly data?: string; readonly mimeType?: string }
type WireResult = { readonly content: readonly Block[]; readonly structuredContent?: unknown; readonly isError?: boolean }

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close()
})

function scratch(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `agent-qa-${label}-`))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

function trapEnv(report: string, modelCache: string, extra: Record<string, string> = {}): Record<string, string> {
  const base = Object.fromEntries(Object.entries(process.env)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
  return {
    ...base, ...extra,
    [trap.TRAP_REPORT_ENV]: report,
    AGENT_QA_MODEL_CACHE_DIR: modelCache,
    NODE_OPTIONS: `${base.NODE_OPTIONS ?? ''} --import=${trap.TRAP_URL}`.trim(),
  }
}

function readReport(path: string) {
  expect(existsSync(path), `the trap wrote no report at ${path}`).toBe(true)
  return trap.readTrapReport(readFileSync(path, 'utf8'))
}

/** Any failure inside a door names what the trap refused, so a mutation reads as a load, not a hang. */
async function underTrap(report: string, stderr: () => string, body: () => Promise<void>): Promise<void> {
  try {
    await body()
  } catch (error) {
    const violations = existsSync(report) ? trap.readTrapReport(readFileSync(report, 'utf8')).violations : []
    const trapped = violations.map((violation) => `${String(violation.kind)} ${String(violation.identity)}`)
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(`COLD-MCP-NO-RUNTIME: ${reason}; trapped ${JSON.stringify(trapped)}\n${stderr().slice(-1500)}`,
      { cause: error })
  }
  expectCleanTrap(report, stderr())
}

function expectCleanTrap(path: string, stderr: string): void {
  const report = readReport(path)
  expect(report.problems).toEqual([])
  expect(report.observed).toEqual(['cjs', 'esm'])
  expect(report.installed[0]?.forbidden).toEqual([...lint.PINNED_FORBIDDEN_RUNTIME])
  expect(report.violations).toEqual([])
  expect(stderr).not.toContain(trap.TRAP_SENTINEL)
}

async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((listening) => server.listen(0, '127.0.0.1', listening))
  const address = server.address()
  await new Promise<void>((closed) => server.close(() => closed()))
  if (address === null || typeof address === 'string') throw new Error('no free port')
  return address.port
}

// ---- The populated project ------------------------------------------------------------------------

function discoveryProject(mcpPort: number) {
  const f = markFixture()
  cleanups.push(() => rmSync(f.root, { recursive: true, force: true }))
  writeFileSync(f.configPath, [
    'workspace:', '  testMatch: [tests/**/*.yaml]', '  suiteMatch: [suites/**/*.suite.yaml]',
    '  hooksFile: hooks.yaml', '  envFile: .env', '  secretsFile: .env.secrets.local',
    // No `safety` block and no MCP token list; a declared `services.mcp` block mounts the endpoint.
    'use:', '  mobile:', '    appState: preserve',
    'services:', '  mcp:', `    port: ${String(mcpPort)}`, '',
  ].join('\n'))
  writeFileSync(join(f.root, 'hooks.yaml'), 'hooks: []\n')
  writeFileSync(join(f.root, '.env'), '')
  writeFileSync(join(f.root, '.env.secrets.local'), '')
  mkdirSync(join(f.root, 'tests'), { recursive: true })
  mkdirSync(join(f.root, 'suites'), { recursive: true })

  const runId = f.handoff.runId
  const recordId = f.published.id as string
  Object.assign(f.handoff.tests[0]!.steps[0]!, { retrievalTrace: {
    schemaVersion: RETRIEVAL_TRACE_SCHEMA_VERSION, servedLines: [{ recordId, leg: 'lexical', rank: 1, score: 1.5 }], truncated: [],
  } })
  f.save()
  const blobs = new FsEvidenceArtifactStore({ root: f.agentQaRoot, runId })
  const { sha } = blobs.persistDecisionScreenshot(PNG)
  const networkRef = blobs.persistEvidenceDocument(NETWORK)
  const dbPath = join(f.agentQaRoot, 'runs.db')
  const db = new DashboardDatabase({ dbPath })
  db.insertRun({ id: runId, name: 'Discovery fixture', status: 'failed', duration: 1,
    startedAt: new Date(0).toISOString(), endedAt: new Date(1).toISOString() })
  db.upsertRunMember({ runId, testIndex: 0, name: 'Discovery member', totalSteps: 1, outcome: 'failed' })
  db.insertRunStep({
    runId, testIndex: 0, stepIndex: 0, stepText: 'Open the cart', cacheStatus: 'miss',
    verifierVerdict: null, selfHealOccurred: false, briefDigest: '', status: 'failed',
    evidence: {
      console: { kind: 'console', state: 'absent', reason: 'empty' },
      network: { kind: 'network', state: 'present', ref: networkRef as never, counts: { total: 1, failed: 1, errored: 0 } },
      a11y: { kind: 'a11y', state: 'absent', reason: 'unsupported' },
      variables: { kind: 'variables', state: 'absent', reason: 'empty' },
    },
  })
  db.close()
  return { ...f, runId, sha, dbPath, recordId }
}

type Project = ReturnType<typeof discoveryProject>

// ---- The reads, each with the content it must carry -----------------------------------------------

interface Read {
  readonly tool: string
  args(p: Project): Record<string, unknown>
  expectPopulated(result: WireResult, p: Project): void
}

function textOf(result: WireResult): string {
  return result.content.filter((block) => block.type === 'text').map((block) => block.text ?? '').join('\n')
}

function structured(result: WireResult): Record<string, unknown> {
  expect(result.structuredContent, textOf(result).slice(0, 400)).toBeTypeOf('object')
  return result.structuredContent as Record<string, unknown>
}

const EIGHT_READS: readonly Read[] = [
  {
    tool: 'agent_qa_list_knowledge_bundles', args: () => ({}),
    expectPopulated: (result, p) => expect(structured(result)['result'])
      .toContainEqual(expect.objectContaining({ bundleId: p.recordId, status: 'candidate' })),
  },
  {
    tool: 'agent_qa_inspect_knowledge_records', args: () => ({ filter: {} }),
    expectPopulated: (result, p) => expect(structured(result)['records'])
      .toContainEqual(expect.objectContaining({ recordId: p.recordId })),
  },
  {
    tool: 'agent_qa_diff_knowledge_records', args: () => ({ sinceOrdinal: 0 }),
    expectPopulated: (result, p) => expect(structured(result)['changes'])
      .toContainEqual(expect.objectContaining({ recordId: p.recordId, change: 'added' })),
  },
  {
    tool: 'agent_qa_show_knowledge_record', args: (p) => ({ recordId: p.recordId }),
    expectPopulated: (result, p) => expect(structured(result))
      .toMatchObject({ kind: 'found', record: { recordId: p.recordId } }),
  },
  {
    tool: 'agent_qa_explain_brief', args: (p) => ({ runId: p.runId, stepIndex: 0 }),
    expectPopulated(result, p) {
      expect(structured(result)).toMatchObject({ kind: 'answered' })
      expect(JSON.stringify(result.structuredContent)).toContain(p.recordId)
    },
  },
  {
    tool: 'agent_qa_get_run_knowledge', args: (p) => ({ runId: p.runId }),
    expectPopulated(result, p) {
      expect(structured(result)).toMatchObject({ kind: 'ready', runId: p.runId, knowledgeStore: 'bound' })
      expect(structured(result)['steps']).toHaveLength(1)
      expect(JSON.stringify(result.structuredContent)).toContain(p.recordId)
    },
  },
  {
    tool: 'agent_qa_get_run_overview', args: (p) => ({ runId: p.runId }),
    expectPopulated: (result, p) => expect(structured(result)).toMatchObject({
      runId: p.runId, tests: [{ testIndex: 0, outcome: 'failed', steps: [{ stepIndex: 0, status: 'failed' }] }],
    }),
  },
]

const ARTIFACT_ARM: Read = {
  tool: 'agent_qa_get_run_evidence', args: (p) => ({ action: 'runs.artifact', runId: p.runId, sha: p.sha }),
  expectPopulated(result) {
    expect(result.content.filter((block) => block.type === 'image'))
      .toEqual([{ type: 'image', data: PNG_BASE64, mimeType: 'image/png' }])
  },
}

const EVIDENCE_ARM: Read = {
  tool: 'agent_qa_get_run_evidence',
  args: (p) => ({ action: 'runs.evidence', runId: p.runId, testIndex: 0, stepIndex: 0, kind: 'network' }),
  expectPopulated(result) {
    expect(result.structuredContent).toMatchObject({
      outcome: 'ready', evidence: { kind: 'network', state: 'present' },
      document: { kind: 'network', records: [{ url: 'https://app.test/api/cart', status: 500 }] },
    })
  },
}

async function driveReads(client: Client, p: Project, reads: readonly Read[]): Promise<string[]> {
  const answered: string[] = []
  for (const read of reads) {
    const result = await client.callTool({ name: read.tool, arguments: read.args(p) }) as unknown as WireResult
    const label = `${read.tool} ${JSON.stringify(read.args(p))}`
    expect(result.isError ?? false, `${label}: ${textOf(result).slice(0, 400)}`).toBe(false)
    read.expectPopulated(result, p)
    answered.push(read.tool === 'agent_qa_get_run_evidence' ? `${read.tool}:${String(read.args(p)['action'])}` : read.tool)
  }
  return answered
}

const NEW_TOOLS = [...new Set([...EIGHT_READS.map((read) => read.tool), EVIDENCE_ARM.tool])].sort()
const ALL_READS: readonly Read[] = [...EIGHT_READS, ARTIFACT_ARM, EVIDENCE_ARM]
const ALL_ANSWERED = [...EIGHT_READS.map((read) => read.tool),
  'agent_qa_get_run_evidence:runs.artifact', 'agent_qa_get_run_evidence:runs.evidence']

// ---- The cells ------------------------------------------------------------------------------------

describe('COLD-MCP-NO-RUNTIME', () => {
  it('the stdio `agent-qa mcp` door starts, lists and answers every populated read with no runtime load', async () => {
    expect(existsSync(CLI_ENTRY), `the built CLI entry is missing at ${CLI_ENTRY}; run \`pnpm build\` first`).toBe(true)
    const p = discoveryProject(await freePort())
    const report = join(scratch('stdio'), 'trap.jsonl')
    const transport = new StdioClientTransport({
      command: process.execPath, args: ['--import', trap.TRAP_URL, CLI_ENTRY, 'mcp'], cwd: p.root,
      env: trapEnv(report, scratch('models'), { AGENT_QA_READER: READER }), stderr: 'pipe',
    })
    let stderr = ''
    transport.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
    const client = new Client({ name: 'agent-qa-stdio', version: '0.0.0' })
    cleanups.push(async () => {
      await client.close().catch(() => {})
      await transport.close().catch(() => {})
    })
    await underTrap(report, () => stderr, async () => {
      await client.connect(transport)
      const listed = (await client.listTools()).tools.map((tool) => tool.name)
      expect(listed).toEqual(expect.arrayContaining(NEW_TOOLS))
      expect(await driveReads(client, p, ALL_READS)).toEqual(ALL_ANSWERED)
    })
  }, 90_000)

  it('the dashboard co-hosted MCP door answers every read and both evidence arms with no runtime load', async () => {
    expect(existsSync(CLI_ENTRY), `the built CLI entry is missing at ${CLI_ENTRY}; run \`pnpm build\` first`).toBe(true)
    const [dashboardPort, mcpPort] = [await freePort(), await freePort()]
    const p = discoveryProject(mcpPort)
    const report = join(scratch('cohost'), 'trap.jsonl')
    const child: ChildProcess = spawn(process.execPath, [
      '--import', trap.TRAP_URL, CLI_ENTRY, 'dashboard', '--port', String(dashboardPort), '--db', p.dbPath,
    ], { cwd: p.root, env: trapEnv(report, scratch('models'), { AGENT_QA_READER: READER }),
      stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8') })
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
    cleanups.push(() => new Promise<void>((exited) => {
      if (child.exitCode !== null) return exited()
      child.once('exit', () => exited())
      child.kill('SIGTERM')
    }))
    const client = new Client({ name: 'agent-qa-cohost', version: '0.0.0' })
    cleanups.push(() => client.close().catch(() => {}))
    await underTrap(report, () => stderr, async () => {
      const deadline = Date.now() + 45_000
      while (!stdout.includes('MCP endpoint listening')) {
        if (child.exitCode !== null || Date.now() > deadline) {
          throw new Error(`the dashboard never mounted MCP (exit ${String(child.exitCode)})`)
        }
        await new Promise((tick) => setTimeout(tick, 100))
      }
      await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${String(mcpPort)}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${READER}` } },
      }))
      const listed = (await client.listTools()).tools.map((tool) => tool.name)
      expect(listed).toEqual(expect.arrayContaining(NEW_TOOLS))
      expect(await driveReads(client, p, ALL_READS)).toEqual(ALL_ANSWERED)
    })
  }, 90_000)
})

// ---- The trap's own proof: derivation, completeness and positive controls -------------------------

function runTrapped(code: string) {
  const dir = scratch('control')
  const report = join(dir, 'trap.jsonl')
  const child = spawnSync(process.execPath, ['--import', trap.TRAP_URL, '--input-type=module', '-e', code], {
    cwd: KNOWLEDGE_LOCAL, env: trapEnv(report, join(dir, 'models')), encoding: 'utf8', timeout: 60_000,
  })
  return { status: child.status, stdout: child.stdout, stderr: child.stderr, report: readReport(report) }
}

describe('TRAP-CONTROLS', () => {
  it('derives the forbidden runtime from the acquisition imports and pins it', () => {
    const derived = lint.deriveForbiddenRuntime()
    expect(derived.roots).toEqual([...lint.PINNED_ACQUISITION_ROOTS])
    expect(derived.names).toEqual([...lint.PINNED_FORBIDDEN_RUNTIME])
    expect(derived.names).toEqual(expect.arrayContaining([
      '@huggingface/tokenizers', '@huggingface/transformers', 'onnxruntime-node', 'onnxruntime-web',
    ]))
    expect(derived.names).not.toContain('sharp')
  })

  it('watches the model cache knowledge-local resolves, under every precedence', () => {
    const saved = { cache: process.env.AGENT_QA_MODEL_CACHE_DIR, xdg: process.env.XDG_CACHE_HOME }
    try {
      for (const [cache, xdg] of [['/tmp/agent-qa-cold-start-cache', '/tmp/agent-qa-cold-start-xdg'], [undefined, '/tmp/agent-qa-cold-start-xdg'], [undefined, undefined]]) {
        if (cache === undefined) delete process.env.AGENT_QA_MODEL_CACHE_DIR
        else process.env.AGENT_QA_MODEL_CACHE_DIR = cache
        if (xdg === undefined) delete process.env.XDG_CACHE_HOME
        else process.env.XDG_CACHE_HOME = xdg
        expect(trap.modelCacheDirFor(process.env)).toBe(resolveModelCacheDir())
      }
    } finally {
      if (saved.cache === undefined) delete process.env.AGENT_QA_MODEL_CACHE_DIR
      else process.env.AGENT_QA_MODEL_CACHE_DIR = saved.cache
      if (saved.xdg === undefined) delete process.env.XDG_CACHE_HOME
      else process.env.XDG_CACHE_HOME = saved.xdg
    }
  })

  it('an absent, uninstalled or half-observed report is never a clean verdict', () => {
    expect(trap.readTrapReport('').problems).toEqual([
      'the trap never reported installed', 'the esm loader path was never observed', 'the cjs loader path was never observed',
    ])
    const esmOnly = [
      { event: 'installed', forbidden: ['@huggingface/tokenizers'] }, { event: 'observed', path: 'esm' },
    ].map((record) => JSON.stringify(record)).join('\n')
    expect(trap.readTrapReport(esmOnly).problems).toEqual(['the cjs loader path was never observed'])
  })

  it.each([
    ['an ESM import of the tokenizer runtime', "await import('@huggingface/tokenizers')", 'module', '@huggingface/tokenizers'],
    ['a CommonJS require of the tokenizer runtime',
      "import { createRequire } from 'node:module'; createRequire(process.cwd() + '/package.json')('@huggingface/tokenizers')",
      'module', '@huggingface/tokenizers'],
    ['an import of the inference runtime', "await import('@huggingface/transformers')", 'module', '@huggingface/transformers'],
    ['a read of a committed floor asset',
      "import { readFileSync } from 'node:fs'; readFileSync('assets/potion-retrieval-32m/tokenizer.json')",
      'asset', 'tokenizer.json'],
  ])('refuses %s with the named sentinel', (_label, code, kind, identity) => {
    const run = runTrapped(code)
    expect(run.report.problems).toEqual([])
    expect(run.status).not.toBe(0)
    expect(run.stderr).toContain(`${trap.TRAP_SENTINEL} ${kind}`)
    expect(run.report.violations).toEqual([expect.objectContaining({ kind, identity: expect.stringContaining(identity) })])
  })

  it('refuses a real acquisition through the shipped ladder, and the ladder degrades rather than loads', () => {
    const run = runTrapped([
      "const { acquireEmbedder } = await import('./dist/index.js')",
      `const outcome = await acquireEmbedder({ allowDownload: false, agentQaRoot: ${JSON.stringify(join(tmpdir(), 'agent-qa-none', '.agent-qa'))} })`,
      'console.log(JSON.stringify(outcome))',
    ].join('\n'))
    expect(run.report.problems).toEqual([])
    expect(run.status).toBe(0)
    expect(JSON.parse(run.stdout.trim())).toEqual({ kind: 'lexical-only' })
    expect(run.stderr).toContain(`${trap.TRAP_SENTINEL} module @huggingface/transformers`)
    expect(run.report.violations.map((violation) => violation.kind)).toEqual(['module', 'asset'])
    expect(run.report.violations[0]).toMatchObject({ identity: '@huggingface/transformers' })
    expect(run.report.violations[1]?.identity).toContain(join('potion-retrieval-32m', 'manifest.json'))
  })
})
