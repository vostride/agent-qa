// What a run, `ask` and `chat` send, write and print carries `[secret:<name>]`, never the value.

import {
  existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative, sep } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { AUTH_STATE_SCHEMA_VERSION, resolveAuthStatePaths } from '@vostride/agent-qa-core'
import { afterAll, describe, expect, it } from 'vitest'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'

import {
  dashboardDbPath,
  recordedDoorProject,
  runStoreEvents,
  runStoreIds,
  spawnCliRun,
  type CliRunOutcome,
  type RecordedDoorProject,
} from './run-doors-fixture.js'
import {
  POPULATED_BUTTON_LABEL,
  POPULATED_TARGET_NAME,
  type RecordedStubRequest,
} from './populated-run-fixture.js'
import { cleanupTempRoots, driveChatSpawned, type SpawnOutcome } from './spawned-chat.js'

const CELL_BUDGET_MS = 300_000

const SHORT = 'q^7'
const LONG = 'Lx~9^aZ4-proof441-long-declared-value-0123456789'
const SHORT_MARKER = '[secret:SHORT_441]'
const LONG_MARKER = '[secret:LONG_441]'
const RAW = [SHORT, LONG] as const
const MARKERS = [SHORT_MARKER, LONG_MARKER] as const
const SECRETS_FILE = '.env.secrets.local'
const NOT_FOUND_HINT = 'Create the file before running tests. It may be empty, but it must exist.'

function echoOf(text: string): string {
  return `/fn knowledge.record.show ${JSON.stringify({ recordId: text })}`
}

const FREE_FORM_UTTERANCE = `keep ${SHORT} and ${LONG} in mind`
const ECHO_UTTERANCE = echoOf(`${SHORT} ${LONG}`)

// Excluded: the cells' input files, media by extension or signature, blobs, blanked handoff keys.
const EXCLUDED = {
  mediaExtensions: ['.png', '.jpg', '.jpeg', '.webp', '.webm', '.mp4', '.zip'],
  mediaSignatures: [
    { offset: 0, bytes: '89504e47' },
    { offset: 0, bytes: 'ffd8ff' },
    { offset: 8, bytes: '57454250' },
    { offset: 0, bytes: '1a45dfa3' },
    { offset: 4, bytes: '66747970' },
    { offset: 0, bytes: '504b0304' },
  ],
  blobDirectory: /(^|\/)runs\/[^/]+\/blobs\//u,
  WRITTEN_STEP_PATHS: ['stepText', 'plannedAction', 'interpolatedVariables', 'stateBefore', 'stateAfter'],
} as const

function isMedia(bytes: Buffer): boolean {
  return EXCLUDED.mediaSignatures.some(({ offset, bytes: hex }) =>
    bytes.subarray(offset, offset + hex.length / 2).toString('hex') === hex)
}

afterAll(() => {
  cleanupTempRoots()
})

type HitClass = 'text' | 'sqlite' | 'handoff' | 'undecodable'

interface ScanHit {
  readonly path: string
  readonly class: HitClass
  readonly raw: string
}

interface ScanExclusions {
  readonly files: readonly string[]
}

const SQLITE_HEADER = 'SQLite format 3\u0000'
const SQLITE_SIDECARS = ['-wal', '-shm', '-journal']

function filesUnder(root: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) files.push(...filesUnder(path))
    else if (entry.isFile()) files.push(path)
  }
  return files
}

function sqliteText(path: string): string {
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    // A virtual table (vec0, fts5) keeps its rows in shadow tables, which are read here.
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' "
      + "AND sql NOT LIKE 'CREATE VIRTUAL TABLE%'").all() as { name: string }[]
    const cells: string[] = []
    for (const { name } of tables) {
      for (const row of db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all()) {
        for (const value of Object.values(row as Record<string, unknown>)) {
          if (typeof value === 'string') cells.push(value)
        }
      }
    }
    return cells.join('\n')
  } finally {
    db.close()
  }
}

function blankWrittenStepPaths(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(blankWrittenStepPaths)
  if (value === null || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value).map(([key, member]) => [
    key,
    (EXCLUDED.WRITTEN_STEP_PATHS as readonly string[]).includes(key) ? null : blankWrittenStepPaths(member),
  ]))
}

function scanRoot(root: string, raw: readonly string[], exclusions: ScanExclusions): ScanHit[] {
  const decoder = new TextDecoder('utf-8', { fatal: true })
  const hits: ScanHit[] = []
  for (const path of filesUnder(root)) {
    const rel = relative(root, path).split(sep).join('/')
    if (exclusions.files.includes(path)) continue
    if (EXCLUDED.mediaExtensions.some((ext) => path.toLowerCase().endsWith(ext))) continue
    if (EXCLUDED.blobDirectory.test(rel)) continue
    const sidecarOf = SQLITE_SIDECARS.find((suffix) => path.endsWith(suffix))
    if (sidecarOf !== undefined && existsSync(path.slice(0, -sidecarOf.length))) continue
    const bytes = readFileSync(path)
    if (isMedia(bytes)) continue
    let text: string
    let kind: HitClass
    if (bytes.subarray(0, SQLITE_HEADER.length).toString('latin1') === SQLITE_HEADER) {
      text = sqliteText(path)
      kind = 'sqlite'
    } else {
      try {
        text = decoder.decode(bytes)
      } catch {
        hits.push({ path: rel, class: 'undecodable', raw: '<not UTF-8>' })
        continue
      }
      kind = 'text'
      if (basename(path) === 'handoff.json') {
        text = JSON.stringify(blankWrittenStepPaths(JSON.parse(text)))
        kind = 'handoff'
      }
    }
    for (const value of raw) {
      if (text.includes(value)) hits.push({ path: rel, class: kind, raw: value })
    }
  }
  return hits
}

interface SessionEvent {
  readonly kind?: string
}

function sessionEvents(agentQaRoot: string): SessionEvent[] {
  const dir = join(agentQaRoot, 'sessions')
  if (!existsSync(dir)) return []
  return readdirSync(dir).filter((name) => name.endsWith('.jsonl')).flatMap((name) =>
    readFileSync(join(dir, name), 'utf8').split('\n').filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line) as SessionEvent))
}

type PresenceClass = 'user_message' | 'clause_receipt'

function presence(agentQaRoot: string, marker: string): Record<PresenceClass, boolean> {
  const events = sessionEvents(agentQaRoot)
  const holds = (kind: PresenceClass): boolean =>
    events.filter((event) => event.kind === kind)
      .some((event) => JSON.stringify(event).includes(marker))
  return { user_message: holds('user_message'), clause_receipt: holds('clause_receipt') }
}

function transcript(outcome: CliRunOutcome | SpawnOutcome): string {
  const code = 'status' in outcome ? outcome.status : outcome.code
  return `exit ${String(code)}\n--- stdout ---\n${outcome.stdout}\n`
    + `--- stderr ---\n${outcome.stderr}`
}

function declare(root: string): string {
  const path = join(root, SECRETS_FILE)
  writeFileSync(path, `SHORT_441=${SHORT}\nLONG_441=${LONG}\n`, 'utf8')
  return path
}

interface ChatModelStub {
  readonly baseUrl: string
  readonly requests: readonly { readonly status: number; readonly fullBody: string }[]
  close(): Promise<void>
}

// Answers every chat-completions request 200 with prose and no tool call; records bodies whole.
async function startChatModelStub(): Promise<ChatModelStub> {
  const requests: { status: number; fullBody: string }[] = []
  const server = createServer((req, res) => {
    let raw = ''
    req.setEncoding('utf8')
    req.on('data', (chunk: string) => { raw += chunk })
    req.on('end', () => {
      const served = req.method === 'POST' && (req.url ?? '').startsWith('/v1/chat/completions')
      requests.push({ status: served ? 200 : 404, fullBody: raw })
      if (!served) {
        res.writeHead(404).end()
        return
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        id: 'chatcmpl-441',
        object: 'chat.completion',
        created: 0,
        model: 'stub-441',
        choices: [{
          index: 0,
          message: { role: 'assistant', content: 'Noted.' },
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }))
    })
  })
  await new Promise<void>((settle) => { server.listen(0, '127.0.0.1', settle) })
  const address = server.address()
  if (address === null || typeof address === 'string') {
    throw new TypeError('the chat stub bound no port')
  }
  return {
    baseUrl: `http://127.0.0.1:${String(address.port)}/v1`,
    requests,
    close: () => new Promise<void>((settle) => { server.close(() => settle()) }),
  }
}

function pointChatModelAt(project: RecordedDoorProject, baseUrl: string): void {
  const config = JSON.parse(readFileSync(project.configPath, 'utf8')) as {
    registry: { llms: { baseURL: string }[] }
  }
  for (const llm of config.registry.llms) llm.baseURL = baseUrl
  writeFileSync(project.configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
}

function wholeBodies(requests: readonly RecordedStubRequest[]): string[] {
  return requests.map((request) => {
    if (request.fullBody === undefined) {
      throw new Error('the stub recorded a request without its whole body')
    }
    return request.fullBody
  })
}

// The run leg's own page: a labelled field for the fill and the assertValue, beside the button
// the first step clicks.
const RUN_LEG_PAGE_HTML = [
  '<!doctype html>',
  '<html lang="en">',
  '<head><meta charset="utf-8"><title>Run leg target</title></head>',
  '<body>',
  '<h1>Run leg target</h1>',
  '<label for="access-code">Access code</label>'
    + '<input id="access-code" name="access-code" type="text" autocomplete="off">',
  `<button type="button" id="ack">${POPULATED_BUTTON_LABEL}</button>`,
  '<p id="ack-state">Notice pending</p>',
  '<script>',
  "document.getElementById('ack').addEventListener('click', function () {",
  "  document.getElementById('ack-state').textContent = 'Notice acknowledged'",
  '})',
  '</script>',
  '</body>',
  '</html>',
  '',
].join('\n')

const FILL_KEY = 'into the Access code field'
const ASSERT_KEY = 'Confirm the Access code field'
const RUN_LEG_STEPS = [
  `Click the ${POPULATED_BUTTON_LABEL} button. The codes on file are ${SHORT} and ${LONG}.`,
  `Type {{secret:SHORT_441}} ${FILL_KEY}`,
  `${ASSERT_KEY} holds the short code`,
] as const
const ACCESS_CODE_EXPR = "document.getElementById('access-code').value"

interface LoopbackServer {
  readonly origin: string
  close(): Promise<void>
}

async function listenLoopback(server: Server): Promise<LoopbackServer> {
  await new Promise<void>((settle, fail) => {
    server.once('error', fail)
    server.listen(0, '127.0.0.1', settle)
  })
  const address = server.address()
  if (address === null || typeof address === 'string') {
    throw new TypeError('the loopback server bound no port')
  }
  return {
    origin: `http://127.0.0.1:${String(address.port)}`,
    close: () => new Promise<void>((settle) => {
      server.closeAllConnections()
      server.close(() => settle())
    }),
  }
}

function startRunLegPage(): Promise<LoopbackServer> {
  return listenLoopback(createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end(RUN_LEG_PAGE_HTML)
  }))
}

interface PlanningRequest {
  readonly messages?: unknown
  readonly tools?: unknown
}

interface StubToolCall {
  readonly function: { name: string; arguments: string }
}

interface StubCompletion {
  readonly choices?: readonly { readonly message?: { readonly tool_calls?: StubToolCall[] } }[]
}

interface BoundTool {
  readonly function?: { readonly name?: unknown; readonly parameters?: unknown }
}

function currentStep(request: PlanningRequest): string | undefined {
  if (!Array.isArray(request.messages)) return undefined
  const texts: string[] = []
  for (const message of request.messages as { content?: unknown }[]) {
    if (typeof message?.content === 'string') texts.push(message.content)
    else if (Array.isArray(message?.content)) {
      for (const part of message.content as { type?: unknown; text?: unknown }[]) {
        if (part?.type === 'text' && typeof part.text === 'string') texts.push(part.text)
      }
    }
  }
  return /^Current step: "(.*)"$/mu.exec(texts.join('\n'))?.[1]
}

function boundTool(request: PlanningRequest, suffix: string): BoundTool | undefined {
  if (!Array.isArray(request.tools)) return undefined
  return (request.tools as BoundTool[]).find((tool) =>
    typeof tool?.function?.name === 'string' && tool.function.name.endsWith(suffix))
}

async function readRequest(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(Buffer.from(chunk as Buffer))
  return Buffer.concat(chunks).toString('utf8')
}

interface RunLegProxy extends LoopbackServer {
  readonly rewrites: { fill: number; assertValue: number }
}

// Forwards every body unchanged to the door's stub and rewrites only the stub's click on the fill
// and assertValue steps; a turn whose bound tools lack the arm's tool is answered 400.
async function startRunLegProxy(upstreamOrigin: string): Promise<RunLegProxy> {
  const rewrites = { fill: 0, assertValue: 0 }
  const server = createServer((req, res) => {
    void (async () => {
      const raw = await readRequest(req)
      const upstream = await fetch(`${upstreamOrigin}${req.url ?? ''}`, {
        method: req.method ?? 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: raw,
      })
      const answer = await upstream.text()
      const pass = (): void => {
        res.writeHead(upstream.status, { 'Content-Type': 'application/json' })
        res.end(answer)
      }
      const refuse = (message: string): void => {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: { message, type: 'invalid_request_error' } }))
      }
      if (!upstream.ok) return pass()
      const request = JSON.parse(raw) as PlanningRequest
      const completion = JSON.parse(answer) as StubCompletion
      const call = completion.choices?.[0]?.message?.tool_calls?.[0]
      const step = currentStep(request)
      const arm = step?.includes(FILL_KEY)
        ? 'fill'
        : step?.includes(ASSERT_KEY) ? 'assertValue' : undefined
      if (call === undefined || arm === undefined) return pass()
      const tool = boundTool(request, `_${arm}`)
      const toolName = tool?.function?.name
      if (typeof toolName !== 'string') {
        return refuse(`the run-leg proxy found no bound tool ending in _${arm}`)
      }
      const stub = JSON.parse(call.function.arguments) as Record<string, unknown>
      let args: Record<string, unknown>
      if (arm === 'fill') {
        const { ref: _ref, ...rest } = stub
        args = {
          ...rest,
          target: { role: 'textbox', name: 'Access code' },
          elementDescription: 'Access code',
          text: '{{secret:SHORT_441}}',
          stepComplete: true,
        }
      } else {
        const schema = JSON.stringify(tool?.function?.parameters ?? {})
        const missing = ['expr', 'op', 'expected'].filter((name) => !schema.includes(`"${name}"`))
        if (missing.length > 0) {
          return refuse(`the run-leg proxy found ${toolName} without ${missing.join(', ')}`)
        }
        args = {
          expr: ACCESS_CODE_EXPR,
          op: 'equals',
          expected: '{{secret:SHORT_441}}',
          reasoning: stub.reasoning,
          confidence: stub.confidence,
          doesActionAdvanceUsTowardsGoal: true,
          stepComplete: true,
        }
      }
      call.function.name = toolName
      call.function.arguments = JSON.stringify(args)
      rewrites[arm] += 1
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(completion))
    })().catch((error: unknown) => {
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: { message: `the run-leg proxy failed: ${String(error)}` } }))
    })
  })
  return { ...(await listenLoopback(server)), rewrites }
}

function pointRunLegAt(project: RecordedDoorProject, pageUrl: string, modelBaseUrl: string): void {
  const config = JSON.parse(readFileSync(project.configPath, 'utf8')) as {
    registry: { targets: Record<string, { url: string }>; llms: { baseURL: string }[] }
  }
  config.registry.targets[POPULATED_TARGET_NAME]!.url = pageUrl
  config.registry.llms[0]!.baseURL = modelBaseUrl
  writeFileSync(project.configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
  const testFile = join(project.root, project.testPath)
  const test = parseYaml(readFileSync(testFile, 'utf8')) as Record<string, unknown>
  test.steps = [...RUN_LEG_STEPS]
  writeFileSync(testFile, stringifyYaml(test), 'utf8')
}

function runDirectory(project: RecordedDoorProject, runId: string): string {
  const runs = join(project.agentQaRoot, 'runs')
  for (const name of readdirSync(runs)) {
    const events = join(runs, name, 'events.jsonl')
    if (!existsSync(events)) continue
    const first = readFileSync(events, 'utf8').split('\n').find((line) => line.trim() !== '')
    if (first !== undefined && (JSON.parse(first) as { runId?: string }).runId === runId) {
      return join(runs, name)
    }
  }
  throw new Error(`no run directory holds run ${runId}`)
}

function findAssertOutcome(value: unknown): Record<string, unknown> | undefined {
  if (Array.isArray(value)) {
    for (const member of value) {
      const found = findAssertOutcome(member)
      if (found !== undefined) return found
    }
    return undefined
  }
  if (value === null || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  if (record.assertOutcome !== null && typeof record.assertOutcome === 'object') {
    return record.assertOutcome as Record<string, unknown>
  }
  for (const member of Object.values(record)) {
    const found = findAssertOutcome(member)
    if (found !== undefined) return found
  }
  return undefined
}

describe('ask, chat and run mask declared values', () => {
  it('ask masks both declared values in what it writes and prints', async () => {
    const project = await recordedDoorProject('441-ask', { fullBodies: true })
    try {
      const secretsPath = declare(project.root)
      const freeForm = await spawnCliRun(project, ['ask', FREE_FORM_UTTERANCE])
      const echo = await spawnCliRun(project, ['ask', ECHO_UTTERANCE])

      expect(echo.status, transcript(echo)).toBe(0)
      expect(freeForm.status, transcript(freeForm)).toBe(1)
      expect(freeForm.stderr, transcript(freeForm)).toContain('Ask error [fail-closed]')

      for (const body of wholeBodies(project.model.requests)) {
        for (const value of RAW) {
          expect(body.includes(value), `a model request carried ${value}`).toBe(false)
        }
      }

      const events = sessionEvents(project.agentQaRoot)
      expect(events.filter((event) => event.kind === 'user_message')).toHaveLength(2)
      for (const marker of MARKERS) {
        expect(presence(project.agentQaRoot, marker), marker)
          .toEqual({ user_message: true, clause_receipt: true })
      }

      const stdout = `${freeForm.stdout}\n${echo.stdout}`
      const stderr = `${freeForm.stderr}\n${echo.stderr}`
      for (const marker of MARKERS) expect(stdout, marker).toContain(marker)
      for (const value of RAW) {
        expect(stdout.includes(value), `stdout carried ${value}`).toBe(false)
        expect(stderr.includes(value), `stderr carried ${value}`).toBe(false)
      }

      expect(scanRoot(project.root, RAW, { files: [secretsPath] })).toEqual([])
    } finally {
      await project.close()
    }
  }, CELL_BUDGET_MS)

  it('ask refuses at start when the secrets file cannot be read', async () => {
    const project = await recordedDoorProject('441-ask-refusal', { fullBodies: true })
    try {
      const secretsPath = join(project.root, SECRETS_FILE)
      rmSync(secretsPath)
      const outcome = await spawnCliRun(project, ['ask', 'status'])

      expect(outcome.status, transcript(outcome)).toBe(1)
      expect(outcome.stderr).toContain(`Error: Secrets file not found: ${secretsPath}`)
      expect(outcome.stderr).toContain(NOT_FOUND_HINT)
      expect(project.model.requests).toEqual([])
      expect(existsSync(join(project.agentQaRoot, 'sessions'))).toBe(false)
    } finally {
      await project.close()
    }
  }, CELL_BUDGET_MS)

  it('chat masks both declared values in every model request, the transcript and the terminal',
    async () => {
    const project = await recordedDoorProject('441-chat', { fullBodies: true })
    const stub = await startChatModelStub()
    try {
      const secretsPath = declare(project.root)
      pointChatModelAt(project, stub.baseUrl)
      const outcome = await driveChatSpawned(
        project.root,
        project.configPath,
        `${FREE_FORM_UTTERANCE}\n${ECHO_UTTERANCE}`,
      )

      expect(outcome.code, transcript(outcome)).toBe(0)
      expect(project.model.requests).toEqual([])
      expect(stub.requests.length, transcript(outcome)).toBeGreaterThan(0)
      const bodies = stub.requests.map((request) => request.fullBody)
      for (const body of bodies) {
        for (const value of RAW) {
          expect(body.includes(value), `a model request carried ${value}`).toBe(false)
        }
      }
      for (const marker of MARKERS) expect(bodies.join('\n'), marker).toContain(marker)

      for (const marker of MARKERS) {
        expect(presence(project.agentQaRoot, marker), marker)
          .toEqual({ user_message: true, clause_receipt: true })
      }

      for (const marker of MARKERS) expect(outcome.stdout, marker).toContain(marker)
      for (const value of RAW) {
        expect(outcome.stdout.includes(value), `stdout carried ${value}`).toBe(false)
        expect(outcome.stderr.includes(value), `stderr carried ${value}`).toBe(false)
      }

      expect(scanRoot(project.root, RAW, { files: [secretsPath] })).toEqual([])
    } finally {
      await stub.close()
      await project.close()
    }
  }, CELL_BUDGET_MS)

  it('chat refuses at start when the secrets file cannot be read', async () => {
    const project = await recordedDoorProject('441-chat-refusal', { fullBodies: true })
    const stub = await startChatModelStub()
    try {
      pointChatModelAt(project, stub.baseUrl)
      const secretsPath = join(project.root, SECRETS_FILE)
      rmSync(secretsPath)
      const outcome = await driveChatSpawned(project.root, project.configPath, 'status')

      expect(outcome.code, transcript(outcome)).toBe(1)
      expect(outcome.stderr).toContain(`Error: Secrets file not found: ${secretsPath}`)
      expect(outcome.stderr).toContain(NOT_FOUND_HINT)
      expect(stub.requests).toEqual([])
      expect(project.model.requests).toEqual([])
      expect(existsSync(join(project.agentQaRoot, 'sessions'))).toBe(false)
    } finally {
      await stub.close()
      await project.close()
    }
  }, CELL_BUDGET_MS)

  it('run masks both declared values in every model request, record and terminal line',
    async () => {
    const project = await recordedDoorProject('441-run', { fullBodies: true })
    const page = await startRunLegPage()
    const proxy = await startRunLegProxy(project.model.url)
    // Linux Chromium writes binary fontconfig caches under XDG_CACHE_HOME, so they stay out of the
    // scanned root; agent-qa's own model cache is pinned back inside it.
    const fontCache = mkdtempSync(join(tmpdir(), '441-xdg-cache-'))
    try {
      const secretsPath = declare(project.root)
      pointRunLegAt(project, page.origin, `${proxy.origin}/v1`)
      const outcome = await spawnCliRun(project, ['run', project.testPath], {
        env: {
          XDG_CACHE_HOME: fontCache,
          AGENT_QA_MODEL_CACHE_DIR: join(project.root, '.cache', 'agent-qa', 'models'),
        },
      })
      expect(outcome.status, transcript(outcome)).toBe(0)

      const runIds = runStoreIds(project)
      expect(runIds, transcript(outcome)).toHaveLength(1)
      const runId = runIds[0]!
      const verdict = runStoreEvents(project, runId).find((event) => event.type === 'verdict')
      expect(verdict?.payload, transcript(outcome)).toMatchObject({ verdict: 'passed' })
      expect(proxy.rewrites.fill, 'fill turns rewritten').toBeGreaterThan(0)
      expect(proxy.rewrites.assertValue, 'assertValue turns rewritten').toBeGreaterThan(0)

      const bodies = wholeBodies(project.model.requests)
      for (const body of bodies) {
        for (const value of RAW) {
          expect(body.includes(value), `a model request carried ${value}`).toBe(false)
        }
      }
      const sentText = bodies.join('\n')
      expect(sentText.includes('{{secret:SHORT_441}}'), 'the step template reached the model')
        .toBe(true)
      expect(sentText.includes('use {{secret:NAME}} verbatim'), 'Rule 23 reached the model')
        .toBe(true)

      const runDir = runDirectory(project, runId)
      const classes = {
        requests: bodies.join('\n'),
        events: readFileSync(join(runDir, 'events.jsonl'), 'utf8'),
        runsDb: sqliteText(dashboardDbPath(project)),
        stdout: outcome.stdout,
      }
      for (const [name, text] of Object.entries(classes)) {
        for (const marker of MARKERS) {
          expect(text.includes(marker), `${name} holds ${marker}`).toBe(true)
        }
      }
      for (const value of RAW) {
        expect(outcome.stdout.includes(value), `stdout carried ${value}`).toBe(false)
        expect(outcome.stderr.includes(value), `stderr carried ${value}`).toBe(false)
      }

      const handoff = JSON.parse(readFileSync(join(runDir, 'handoff.json'), 'utf8')) as unknown
      expect(findAssertOutcome(handoff)).toMatchObject({
        expected: SHORT_MARKER,
        actual: SHORT_MARKER,
        passed: true,
      })

      expect(EXCLUDED.WRITTEN_STEP_PATHS).toEqual([
        'stepText', 'plannedAction', 'interpolatedVariables', 'stateBefore', 'stateAfter',
      ])
      const testFile = join(project.root, project.testPath)
      expect(scanRoot(project.root, RAW, { files: [secretsPath, testFile] })).toEqual([])
      // The redirected cache is outside the scanned root, so it is held to what it is for: only
      // fontconfig writes there, and no byte of it carries a declared value.
      expect(
        readdirSync(fontCache).filter((entry) => entry !== 'fontconfig'),
        'only fontconfig writes under the redirected XDG cache',
      ).toEqual([])
      for (const file of filesUnder(fontCache)) {
        const bytes = readFileSync(file)
        for (const value of RAW) {
          expect(bytes.includes(value), `${relative(fontCache, file)} under the redirected XDG cache carried ${value}`)
            .toBe(false)
        }
      }
    } finally {
      try {
        await proxy.close()
        await page.close()
        await project.close()
      } finally {
        rmSync(fontCache, { recursive: true, force: true })
      }
    }
  }, CELL_BUDGET_MS)
})

// Only declared values are masked, and nothing is blocked.
const TWIN_VALUES = [
  'qa@example.com',
  'cookie-441-value',
  'pw-env-441',
  'envfile-441',
  '4242 4242 4242 4242',
  'AKIAIOSFODNN7EXAMPLE',
  'Bearer abc123def456ghi789',
] as const
const TWIN_TEXT = TWIN_VALUES.join(' | ')
const TWIN_ENV = { AGENT_QA_X_PASSWORD: 'pw-env-441' }
const TWIN_AUTH_STATE = 'twin-441'
const RUN_TWIN_VALUES = [
  'qa@example.com',
  'cookie-441-value',
  'ls-441-value',
  'pw-env-441',
  'envfile-441',
  '4242 4242 4242 4242',
  'AKIAIOSFODNN7EXAMPLE',
  'Bearer abc123def456ghi789',
] as const
const RUN_TWIN_TEXT = RUN_TWIN_VALUES.join(' | ')

function sessionKinds(agentQaRoot: string, kind: string): string {
  return sessionEvents(agentQaRoot).filter((event) => event.kind === kind)
    .map((event) => JSON.stringify(event)).join('\n')
}

function twinProject(project: RecordedDoorProject, secrets: string): void {
  writeFileSync(join(project.root, SECRETS_FILE), secrets, 'utf8')
  writeFileSync(join(project.root, '.env'), 'ENV_ONLY_441=envfile-441\n', 'utf8')
  const paths = resolveAuthStatePaths({
    configDir: dirname(project.configPath),
    targetName: POPULATED_TARGET_NAME,
    stateName: TWIN_AUTH_STATE,
    platform: 'web',
  })
  mkdirSync(paths.targetDir, { recursive: true })
  writeFileSync(paths.payloadPath, `${JSON.stringify({
    cookies: [{
      name: 'session', value: 'cookie-441-value', domain: '127.0.0.1', path: '/',
      expires: -1, httpOnly: false, secure: false, sameSite: 'Lax',
    }],
    origins: [{
      origin: project.target.url,
      localStorage: [{ name: 'twin', value: 'ls-441-value' }],
    }],
  })}\n`, 'utf8')
  writeFileSync(paths.metadataPath, `${JSON.stringify({
    version: AUTH_STATE_SCHEMA_VERSION, kind: 'web', target: POPULATED_TARGET_NAME, name: TWIN_AUTH_STATE,
    capturedAt: '2026-10-14T00:00:00.000Z',
  })}\n`, 'utf8')
}

describe('undeclared values pass unchanged', () => {
  it('ask and chat leave every undeclared value unchanged and block nothing', async () => {
    const project = await recordedDoorProject('441-twin', { fullBodies: true })
    const stub = await startChatModelStub()
    try {
      twinProject(project, `SHORT_441=${SHORT}\n`)
      pointChatModelAt(project, stub.baseUrl)

      const chat = await driveChatSpawned(project.root, project.configPath, TWIN_TEXT, TWIN_ENV)
      expect(chat.code, transcript(chat)).toBe(0)
      expect(stub.requests.length, transcript(chat)).toBeGreaterThan(0)
      const bodies = stub.requests.map((request) => request.fullBody).join('\n')
      const chatMessages = sessionKinds(project.agentQaRoot, 'user_message')
      for (const value of TWIN_VALUES) {
        expect(bodies, value).toContain(value)
        expect(chatMessages, value).toContain(value)
      }
      rmSync(join(project.agentQaRoot, 'sessions'), { recursive: true, force: true })

      const beforeAsk = stub.requests.length
      const ask = await spawnCliRun(project, ['ask', echoOf(TWIN_TEXT)], { env: TWIN_ENV })
      expect(ask.status, transcript(ask)).toBe(0)
      const askMessages = sessionKinds(project.agentQaRoot, 'user_message')
      const askReceipts = sessionKinds(project.agentQaRoot, 'clause_receipt')
      for (const value of TWIN_VALUES) {
        expect(askMessages, value).toContain(value)
        expect(askReceipts, value).toContain(value)
        expect(ask.stdout, value).toContain(value)
        for (const request of stub.requests.slice(beforeAsk)) {
          expect(request.fullBody, value).toContain(value)
        }
      }

      expect(project.model.requests).toEqual([])
      for (const request of stub.requests) expect(request.status).toBe(200)
    } finally {
      await stub.close()
      await project.close()
    }
  }, CELL_BUDGET_MS)

  it('an empty secrets file changes nothing, and encoded or case-changed forms of a declared value '
    + 'are not masked', async () => {
    const project = await recordedDoorProject('441-twin-forms', { fullBodies: true })
    const stub = await startChatModelStub()
    try {
      twinProject(project, '')
      pointChatModelAt(project, stub.baseUrl)

      const chat = await driveChatSpawned(project.root, project.configPath, TWIN_TEXT, TWIN_ENV)
      const ask = await spawnCliRun(project, ['ask', echoOf(TWIN_TEXT)], { env: TWIN_ENV })
      expect(chat.code, transcript(chat)).toBe(0)
      expect(ask.status, transcript(ask)).toBe(0)
      const bodies = stub.requests.map((request) => request.fullBody).join('\n')
      const session = sessionKinds(project.agentQaRoot, 'user_message')
      for (const value of TWIN_VALUES) {
        expect(bodies, value).toContain(value)
        expect(session, value).toContain(value)
      }

      writeFileSync(join(project.root, SECRETS_FILE), `SHORT_441=${SHORT}\n`, 'utf8')
      rmSync(join(project.agentQaRoot, 'sessions'), { recursive: true, force: true })
      const before = stub.requests.length
      const forms = `Q^7 q%5E7 ${SHORT}`
      const chatForms = await driveChatSpawned(project.root, project.configPath, forms)
      expect(chatForms.code, transcript(chatForms)).toBe(0)
      const formBodies = stub.requests.slice(before).map((request) => request.fullBody)
      expect(formBodies.length, transcript(chatForms)).toBeGreaterThan(0)
      const formBody = formBodies.join('\n')
      expect(formBody).toContain('Q^7')
      expect(formBody).toContain('q%5E7')
      expect(formBody).toContain(SHORT_MARKER)
      expect(formBody.includes(SHORT)).toBe(false)
      rmSync(join(project.agentQaRoot, 'sessions'), { recursive: true, force: true })

      const askForms = await spawnCliRun(project, ['ask', echoOf(forms)])
      expect(askForms.status, transcript(askForms)).toBe(0)
      const askSession = sessionEvents(project.agentQaRoot)
        .map((event) => JSON.stringify(event)).join('\n')
      expect(askSession).toContain('Q^7')
      expect(askSession).toContain('q%5E7')
      expect(askSession).toContain(SHORT_MARKER)
      expect(askSession.includes(SHORT)).toBe(false)

      expect(project.model.requests).toEqual([])
      for (const request of stub.requests) expect(request.status).toBe(200)
    } finally {
      await stub.close()
      await project.close()
    }
  }, CELL_BUDGET_MS)

  it('a run leaves every undeclared value unchanged and blocks nothing', async () => {
    const project = await recordedDoorProject('441-run-twin', { fullBodies: true })
    try {
      twinProject(project, `SHORT_441=${SHORT}\n`)
      const testFile = join(project.root, project.testPath)
      const test = parseYaml(readFileSync(testFile, 'utf8')) as Record<string, unknown>
      test.use = { authState: TWIN_AUTH_STATE }
      test.steps = [
        `Click the ${POPULATED_BUTTON_LABEL} button. Keep these on file: ${RUN_TWIN_TEXT}`,
      ]
      writeFileSync(testFile, stringifyYaml(test), 'utf8')

      const outcome = await spawnCliRun(project, ['run', project.testPath], { env: TWIN_ENV })
      expect(outcome.status, transcript(outcome)).toBe(0)
      expect(outcome.stderr, transcript(outcome)).not.toMatch(/guardrail|blocked/iu)
      const runIds = runStoreIds(project)
      expect(runIds, transcript(outcome)).toHaveLength(1)
      const verdict = runStoreEvents(project, runIds[0]!).find((event) => event.type === 'verdict')
      expect(verdict?.payload, transcript(outcome)).toMatchObject({ verdict: 'passed' })

      const bodies = wholeBodies(project.model.requests).join('\n')
      const events = readFileSync(join(runDirectory(project, runIds[0]!), 'events.jsonl'), 'utf8')
      for (const value of RUN_TWIN_VALUES) {
        expect(bodies, value).toContain(value)
        expect(events, value).toContain(value)
      }
      expect(project.model.requests.length).toBeGreaterThan(0)
      for (const request of project.model.requests) expect(request.status).toBe(200)
    } finally {
      await project.close()
    }
  }, CELL_BUDGET_MS)
})
