// Every cell drives the spawned binary over TCP: only bytes off a socket show no live handle leaks.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  RunEventEnvelopeSchema,
  RunServiceErrorBodySchema,
  RunServiceReadinessSchema,
  RunStartAcknowledgementSchema,
  RunsLiveUrlResultSchema,
} from '@vostride/agent-qa-schema'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  REBUILD_INSTRUCTION,
  RUN_SERVICE_ANCHORED_BUILDS,
  buildFreshness,
  cleanupTempRoots,
  reserveEphemeralPort,
  runServiceFixtureProject,
  spawnDashboard,
  type SpawnedDashboard,
} from './spawned-chat.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const SCHEMA_SRC = join(HERE, '..', '..', '..', '..', 'schema', 'src')

/** Every wait in this file is bounded; a hung door must fail as a timeout, never as a hang. */
const WIRE_BUDGET_MS = 90_000

// RPC-shape sweep: a no-function check after `JSON.parse` is tautological; the inner rings decide.

/**
 * The `RunSession` members that may NEVER appear on the wire, and the ones that legitimately do.
 *
 * BOTH HALVES ARE DECLARED AND THE UNION IS ASSERTED SET-EQUAL against `run-session.ts`'s own
 * interface by the census cell below. That two-way equality is what stops this from being a list
 * that goes quiet: a member added to `RunSession` tomorrow belongs to one of these two sets and the
 * census reds until somebody has said which. A one-directional list would let a new live handle
 * enter the type unwatched, which is the exact defect these anchors exist for.
 *
 * The split is by KIND, not by taste. `subscribe` and `cancel` are closures over this process's
 * event bus and `done` is a promise resolved by it; none of the three has a serialization and none
 * of them means anything to a caller on another machine. `id`, `status` and `executionContext` are
 * data, and two of them are on the ack by contract.
 */
const RUN_SESSION_HANDLE_MEMBERS = [
  'subscribe',
  'cancel',
  'done',
  // Closures over this process's live-stream hub, with no serialization; neither may leak.
  'subscribeFrames', 'streamCapabilityOf',
] as const
const RUN_SESSION_DATA_MEMBERS = ['id', 'status', 'executionContext'] as const

/** Every key that appears anywhere in a parsed JSON document, at any depth. */
function everyKey(value: unknown, into: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) {
    for (const member of value) everyKey(member, into)
    return into
  }
  if (typeof value === 'object' && value !== null) {
    for (const [key, member] of Object.entries(value)) {
      into.add(key)
      everyKey(member, into)
    }
  }
  return into
}

/** Every value that appears anywhere in a parsed JSON document, at any depth, with its path. */
function everyValue(
  value: unknown,
  path = '$',
  into: { path: string; value: unknown }[] = [],
): { path: string; value: unknown }[] {
  into.push({ path, value })
  if (Array.isArray(value)) {
    value.forEach((member, index) => everyValue(member, `${path}[${String(index)}]`, into))
    return into
  }
  if (typeof value === 'object' && value !== null) {
    for (const [key, member] of Object.entries(value)) everyValue(member, `${path}.${key}`, into)
  }
  return into
}

/** What one RPC-shape reading found about one document, as data. */
interface RpcShapeReading {
  /** Ring 1 (cheap, and honestly tautological for a document that parsed). */
  readonly functionTyped: readonly string[]
  /** Ring 2: a value whose prototype is not a plain object, array or null. */
  readonly exotic: readonly string[]
  /** Ring 3: a `RunSession` HANDLE member name appearing anywhere at any depth. */
  readonly handleKeys: readonly string[]
  /** Ring 4: the bytes are not what `JSON.stringify` of their own parse produces. */
  readonly byteUnstable: boolean
}

/**
 * Read one document's RPC shape off its RAW BYTES — pure, total, and exported for the control cell.
 *
 * RING 4 IS THE ONE WITH TEETH ABOUT FRAMING. `JSON.stringify(JSON.parse(raw)) === raw` says the
 * bytes are the canonical serialization of their own value: no pretty-printing, no padding, and —
 * the defect it exists for — no side-channel envelope. A door that started answering a
 * self-describing JS serialization (`superjson`, `devalue`, a `{"$type":"…","value":…}` wrapper),
 * which is precisely how a live object gets smuggled across a process boundary, cannot satisfy it,
 * because such a format's whole point is to carry more than JSON's value space.
 *
 * RING 3 IS THE ONE WITH TEETH ABOUT `RunSession`. A handle that leaked and was flattened by
 * `JSON.stringify` leaves its KEY behind — `"done": {}`, `"subscribe": null` — even when the value
 * is gone. The key set is walked to any depth because an ack is shallow and an event payload is not.
 */
export function rpcShapeOf(raw: string): RpcShapeReading {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { functionTyped: [], exotic: ['$: the bytes are not JSON'], handleKeys: [], byteUnstable: true }
  }
  const functionTyped: string[] = []
  const exotic: string[] = []
  for (const seen of everyValue(parsed)) {
    if (typeof seen.value === 'function') {
      functionTyped.push(seen.path)
      continue
    }
    if (typeof seen.value === 'object' && seen.value !== null) {
      const proto = Object.getPrototypeOf(seen.value) as unknown
      if (proto !== Object.prototype && proto !== Array.prototype && proto !== null) {
        exotic.push(seen.path)
      }
    }
  }
  const keys = everyKey(parsed)
  const handleKeys = RUN_SESSION_HANDLE_MEMBERS.filter((member) => keys.has(member))
  return {
    functionTyped,
    exotic,
    handleKeys,
    byteUnstable: JSON.stringify(parsed) !== raw,
  }
}

/** The empty reading — what a document that leaked nothing looks like. */
const RPC_SHAPE_CLEAN: RpcShapeReading = {
  functionTyped: [],
  exotic: [],
  handleKeys: [],
  byteUnstable: false,
}

// Every swept document is recorded under a declared class, and the census checks both directions.
const WIRE_DOCUMENT_CLASSES = [
  'ack',
  'errorBody',
  'liveUrl',
  'readiness',
  'sseEnvelope',
] as const
type WireDocumentClass = (typeof WIRE_DOCUMENT_CLASSES)[number]

const observedWireDocuments: { readonly wireClass: WireDocumentClass; readonly raw: string }[] = []

/**
 * Sweep one document and record that it was swept. Every wire-document assertion in this file goes
 * through here, so the census below is reading what actually crossed the socket rather than a list.
 */
function sweepWireDocument(wireClass: WireDocumentClass, raw: string, why: string): void {
  observedWireDocuments.push({ wireClass, raw })
  expect(rpcShapeOf(raw), why).toEqual(RPC_SHAPE_CLEAN)
}

// ---- The wire ----------------------------------------------------------------------------------

/** One SSE frame, split into the three fields the contract allows plus whatever else arrived. */
interface SseFrame {
  readonly id?: string
  readonly event?: string
  readonly data?: string
  /** Any line whose field name is NOT `id`, `event` or `data`, and not a comment. */
  readonly foreignFields: readonly string[]
}

function parseFrame(frame: string): SseFrame {
  const out: { id?: string; event?: string; data?: string } = {}
  const foreignFields: string[] = []
  for (const line of frame.split('\n')) {
    if (line === '' || line.startsWith(':')) continue
    const colon = line.indexOf(':')
    const field = colon === -1 ? line : line.slice(0, colon)
    const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /u, '')
    if (field === 'id') out.id = value
    else if (field === 'event') out.event = value
    else if (field === 'data') out.data = value
    else foreignFields.push(field)
  }
  return { ...out, foreignFields }
}

/** What the wire answered for one run's stream. */
interface StreamReading {
  readonly status: number
  readonly contentType: string | null
  readonly corsHeader: string | null
  readonly frames: readonly SseFrame[]
  /** Every `data:` line, verbatim, so the sweep reads BYTES rather than a re-serialization. */
  readonly dataLines: readonly string[]
}

/** Read an SSE stream until `runFinished` or the budget expires. Bounded, always. */
async function readStream(
  url: string,
  headers: Record<string, string>,
  budgetMs = WIRE_BUDGET_MS,
): Promise<StreamReading> {
  const controller = new AbortController()
  const timer = setTimeout(() => { controller.abort() }, budgetMs)
  try {
    const response = await fetch(url, { headers, signal: controller.signal })
    const contentType = response.headers.get('content-type')
    const corsHeader = response.headers.get('access-control-allow-origin')
    if (response.body === null || !(contentType ?? '').includes('text/event-stream')) {
      return { status: response.status, contentType, corsHeader, frames: [], dataLines: [] }
    }
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    const raw: string[] = []
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let boundary = buffer.indexOf('\n\n')
      while (boundary !== -1) {
        raw.push(buffer.slice(0, boundary))
        buffer = buffer.slice(boundary + 2)
        boundary = buffer.indexOf('\n\n')
      }
      if (raw.some((frame) => frame.includes('event: runFinished'))) break
    }
    await reader.cancel().catch(() => undefined)
    const frames = raw.map(parseFrame)
    return {
      status: response.status,
      contentType,
      corsHeader,
      frames,
      dataLines: frames.map((frame) => frame.data).filter((line): line is string => line !== undefined),
    }
  } finally {
    clearTimeout(timer)
  }
}

// ---- The spawned door --------------------------------------------------------------------------

let door: SpawnedDashboard | undefined
let doorReady = false
let doorDiagnostics = ''
// The run service is tokenless; a request carries no credential.
const bearer: Record<string, string> = {}
const authedJson = { ...bearer, 'Content-Type': 'application/json' }

beforeAll(async () => {
  // THE GUARD BEFORE THE SPAWN, because a stale-build refusal must be reported as what it is and
  // not as a door that answered oddly ninety seconds later. Every cell repeats it in its own body
  // on `parity-anchors.test.ts`'s reasoning: a guard that only ran in a neighbouring cell is a
  // guard a `--testNamePattern` run silently skips.
  const freshness = buildFreshness(RUN_SERVICE_ANCHORED_BUILDS)
  if (freshness.missing.length > 0 || freshness.stale.length > 0) return

  const fixture = runServiceFixtureProject('anchors')
  const port = await reserveEphemeralPort()
  // No credential reaches the child; none is declared and none is read.
  const spawned = await spawnDashboard(
    fixture.root,
    fixture.configPath,
    port,
    WIRE_BUDGET_MS,
  )
  door = spawned
  doorReady = spawned.ready
  doorDiagnostics = `child stdout:\n${spawned.stdout()}\nchild stderr:\n${spawned.stderr()}`
}, WIRE_BUDGET_MS + 30_000)

afterAll(async () => {
  await door?.stop()
  cleanupTempRoots()
})

/** The origin, with the child's own streams quoted if it never got there. */
function origin(): string {
  expect(doorReady, `the spawned agent-qa dashboard never reported listening.\n${doorDiagnostics}`)
    .toBe(true)
  return (door as SpawnedDashboard).origin
}

// ---- The anchors -------------------------------------------------------------------------------

describe('the run-service wire anchors', () => {
  it('refuses to measure a build that is missing or older than its source', () => {
    expect(buildFreshness(RUN_SERVICE_ANCHORED_BUILDS), REBUILD_INSTRUCTION)
      .toEqual({ missing: [], stale: [] })
  })

  it('drives the SHIPPED binary and imports no router of its own', () => {
    // THE FRAME, ASSERTED ON THIS FILE'S OWN SOURCE. Criterion 4 is a claim about the wire, and the
    // one way to void it silently is for a later edit to swap the child process for an imported
    // `createRunServiceRoutes` mounted on a bare server — which would leave every assertion below
    // reading identically while measuring an in-process object.
    //
    // THE SCAN RANGES THE IMPORT STATEMENTS, NOT THE WHOLE FILE, and that is a correction rather
    // than a convenience: a whole-file scan for the forbidden identifiers is satisfied by its own
    // forbidden list — the cell fails on the array literal it is written with, which is a detector
    // whose subject is itself. Import specifiers are where an in-process mount would have to enter,
    // and they are a region this cell's own body is not part of.
    const source = readFileSync(join(HERE, 'run-service-anchors.test.ts'), 'utf8')
    const importedFrom = [...source.matchAll(/^import[\s\S]*?from '([^']+)'/gmu)]
      .map((match) => match[1] as string)
    expect(importedFrom.length, 'this file must import something for the scan to mean anything')
      .toBeGreaterThan(0)
    // The two modules that could hand this file an in-process door: the surface package that owns
    // every router, and the CLI command module that owns every composition. Neither may be imported
    // here. `@vostride/agent-qa-schema` is fine and IS imported — schemas parse bytes, they serve
    // nothing.
    const MOUNTING_MODULES = ['@vostride/agent-qa-dashboard', '../../commands/dashboard.js']
    for (const forbidden of MOUNTING_MODULES) {
      expect(
        importedFrom.includes(forbidden),
        `${forbidden}: importing this would let a later edit mount a door in-process and leave `
        + 'every cell below reading identically while measuring the wrong frame',
      ).toBe(false)
    }
    // And the positive half: the child is spawned, by the one shared instrument.
    expect(source, 'these anchors must spawn the built binary').toContain('spawnDashboard(')
    expect(importedFrom, 'the spawn instrument has exactly one home').toContain('./spawned-chat.js')
  })

  it('names every RunSession member as either wire data or an in-process handle', () => {
    // THE COMPLETE-SET CLAIM the ring-3 sweep rests on, and it reds in BOTH directions. The forbidden
    // set is only as good as its coverage of the type it is drawn from: a live handle added to
    // `RunSession` that this file never heard of would sail through a sweep that only knows three
    // names. So the interface is PARSED — from the schema package's source, which is the declaration
    // of record — and its member set is compared with the union of the two declared halves.
    const source = readFileSync(join(SCHEMA_SRC, 'run', 'run-session.ts'), 'utf8')
    const block = /export interface RunSession \{([\s\S]*?)\n\}/u.exec(source)
    expect(block, 'RunSession must be declared in packages/schema/src/run/run-session.ts').not.toBeNull()
    const body = (block as RegExpExecArray)[1] ?? ''
    const declared = new Set<string>()
    // ONLY LINES AT THE TOP LEVEL OF THE INTERFACE BODY DECLARE A MEMBER. A member whose signature
    // spans several lines — a method with three parameters, say — puts `handle: number,` on a line
    // of its own, and a purely line-based read counts each of those as a member of `RunSession`. The
    // census then fails on a type nobody changed, and worse, it would pass a real leak hidden inside
    // such a signature. Bracket depth is what tells a declaration apart from a continuation. Comment
    // lines are skipped before the count so unbalanced prose cannot shift it.
    let depth = 0
    for (const line of body.split('\n')) {
      const trimmed = line.trim()
      if (trimmed === '' || trimmed.startsWith('*') || trimmed.startsWith('/')) continue
      const atTopLevel = depth === 0
      for (const character of line) {
        if (character === '(' || character === '[' || character === '{') depth += 1
        else if (character === ')' || character === ']' || character === '}') depth -= 1
      }
      if (!atTopLevel) continue
      const member = /^([A-Za-z_$][\w$]*)\s*[?(:]/u.exec(trimmed)
      if (member !== null) declared.add(member[1] as string)
    }
    expect(depth, 'the interface body must have balanced brackets, or this walk lost its place')
      .toBe(0)
    expect(
      [...declared].sort(),
      'every RunSession member must be classified as wire data or an in-process handle — '
      + 'an unclassified member is a leak this file cannot see',
    ).toEqual([...RUN_SESSION_DATA_MEMBERS, ...RUN_SESSION_HANDLE_MEMBERS].sort())
  })

  it('refuses a cross-site POST /run — 403 from the spawned binary, not a fixture', async () => {
    expect(buildFreshness(RUN_SERVICE_ANCHORED_BUILDS), REBUILD_INSTRUCTION)
      .toEqual({ missing: [], stale: [] })
    const response = await fetch(`${origin()}/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain', Origin: 'https://evil.example' },
      body: '{}',
    })
    expect(response.status).toBe(403)
    const raw = await response.text()
    const body = RunServiceErrorBodySchema.parse(JSON.parse(raw))
    expect(body).toEqual({ error: 'cross_site_refused' })
    // The single-key law, on the wire: a refused caller learns a reason word and no more.
    expect(Object.keys(body)).toEqual(['error'])
    // No cross-origin grant, asserted where a browser would read it.
    expect(response.headers.get('access-control-allow-origin')).toBeNull()
    sweepWireDocument('errorBody', raw, 'the refusal body must be pure JSON')
  }, WIRE_BUDGET_MS)

  // Asks the spawned dashboard, so only a composition threading `runServiceReadiness` passes.
  it('serves the LOCAL readiness door from the shipped composition, not a fixture', async () => {
    expect(buildFreshness(RUN_SERVICE_ANCHORED_BUILDS), REBUILD_INSTRUCTION)
      .toEqual({ missing: [], stale: [] })
    // The local door is loopback-guarded, not token-guarded.
    const response = await fetch(`${origin()}/api/run-readiness`)
    expect(
      response.status,
      'a 503 here means `agent-qa dashboard` stopped threading runServiceReadiness into '
      + 'startServer, which silently disables the whole of criterion 2\'s preflight',
    ).toBe(200)
    const readiness = RunServiceReadinessSchema.parse(JSON.parse(await response.text()))
    expect(readiness.hostComposed).toBe(true)
  }, WIRE_BUDGET_MS)

  // Its own dashboard, so a second child pins the same readiness answer.
  it('serves the LOCAL readiness door with NO credential declared — the default posture', async () => {
    expect(buildFreshness(RUN_SERVICE_ANCHORED_BUILDS), REBUILD_INSTRUCTION)
      .toEqual({ missing: [], stale: [] })
    const fixture = runServiceFixtureProject('anchors-no-token')
    const port = await reserveEphemeralPort()
    const child = await spawnDashboard(fixture.root, fixture.configPath, port, WIRE_BUDGET_MS)
    try {
      expect(child.ready, `the token-less dashboard never listened.\n${child.stdout()}`).toBe(true)
      const response = await fetch(`${child.origin}/api/run-readiness`)
      expect(
        response.status,
        'a 503 here means the zero-token fallback arm was dropped, which disables the preflight '
        + 'for every project that declares no run-service credential — i.e. most of them',
      ).toBe(200)
      const readiness = RunServiceReadinessSchema.parse(JSON.parse(await response.text()))
      expect(readiness.hostComposed).toBe(true)
      // Composed, with no credential fact at all.
      expect(Object.keys(readiness).sort()).toEqual(['contractVersion', 'hostComposed', 'service'])
    } finally {
      await child.stop()
    }
  }, WIRE_BUDGET_MS + 30_000)

  it('refuses a caller-supplied runId over the wire, in the current vocabulary', async () => {
    expect(buildFreshness(RUN_SERVICE_ANCHORED_BUILDS), REBUILD_INSTRUCTION)
      .toEqual({ missing: [], stale: [] })
    // On the spawned binary: an unrefused field could address another caller's run.
    const response = await fetch(`${origin()}/run`, {
      method: 'POST',
      headers: authedJson,
      body: JSON.stringify({ runId: 'r_a-caller-chose-this' }),
    })
    expect(response.status).toBe(400)
    const raw = await response.text()
    expect(RunServiceErrorBodySchema.parse(JSON.parse(raw)))
      .toEqual({ error: 'refused_request_field' })
    // Nothing echoes the caller's value back — the refusal names no field and no id.
    expect(raw).not.toContain('r_a-caller-chose-this')
  }, WIRE_BUDGET_MS)

  it('acks a run under the runs.start contract and streams envelopes under the frozen frame',
    async () => {
      expect(buildFreshness(RUN_SERVICE_ANCHORED_BUILDS), REBUILD_INSTRUCTION)
        .toEqual({ missing: [], stale: [] })

      // (1) THE ACK, off the shipped binary. Parsed under the ack contract rather than inspected:
      // `RunStartAcknowledgementSchema` is `.strict()`, so a field the contract does not declare —
      // which is exactly the residue a flattened live object leaves behind — is a named RED here.
      const started = await fetch(`${origin()}/run`, {
        method: 'POST',
        headers: authedJson,
        body: JSON.stringify({ patterns: ['tests/probe.test.yaml'] }),
      })
      const ackBytes = await started.text()
      expect(started.status, `the spawned door refused a credentialled start: ${ackBytes}`).toBe(202)
      const ack = RunStartAcknowledgementSchema.parse(JSON.parse(ackBytes))
      expect(ack.runId).toBeTruthy()
      expect(ack.testCount).toBeGreaterThan(0)
      sweepWireDocument('ack', ackBytes, 'the ack must be pure JSON with no handle residue')

      // The mint body is the one document whose producer holds a live session, so it is swept too.
      const mintDeadline = Date.now() + 30_000
      let liveUrlBytes: string | undefined
      while (Date.now() < mintDeadline) {
        const probe = await fetch(`${origin()}/api/runs/${encodeURIComponent(ack.runId)}/live-url`)
        const probeBytes = await probe.text()
        if (probe.status === 200) { liveUrlBytes = probeBytes; break }
        await new Promise((resolve) => setTimeout(resolve, 250))
      }
      expect(
        liveUrlBytes,
        'the spawned dashboard never minted a liveUrl for a run it was executing — the session '
        + 'registry is composed only on the token arm if #264 has regressed',
      ).toBeDefined()
      // SWEPT BEFORE PARSED, deliberately. The strict result contract would also refuse a leaked
      // member, but a schema refusal and a ring-3 refusal are different instruments and the ring is
      // the one this census is about — running it second would let the parse mask what it measures.
      sweepWireDocument(
        'liveUrl',
        liveUrlBytes as string,
        'the liveUrl mint body must be pure JSON with no handle residue — a `subscribeFrames` or '
        + '`streamCapabilityOf` key at ANY depth here is the frame seam leaking onto the wire',
      )
      const liveUrl = RunsLiveUrlResultSchema.parse(JSON.parse(liveUrlBytes as string))
      expect(liveUrl.liveUrl, 'the mint names the run it was minted for, in the URL and nowhere else')
        .toContain(encodeURIComponent(ack.runId))
      expect(liveUrl.stream.kind, 'a browserless spawned run declares the HONEST none capability')
        .toBe('none')
      expect(rpcShapeOf(liveUrlBytes as string).handleKeys, 'no RunSession handle member, at any depth')
        .toEqual([])
      expect(rpcShapeOf(liveUrlBytes as string).functionTyped).toEqual([])
      expect(rpcShapeOf(liveUrlBytes as string).byteUnstable).toBe(false)

      // (2) Readiness, from the same child.
      const ok = await fetch(`${origin()}/ok`, { headers: bearer })
      expect(ok.status).toBe(200)
      const okBytes = await ok.text()
      const readiness = RunServiceReadinessSchema.parse(JSON.parse(okBytes))
      expect(readiness.hostComposed).toBe(true)
      // No credential can be configured, and the answer carries no such fact.
      expect(Object.keys(readiness).sort()).toEqual(['contractVersion', 'hostComposed', 'service'])
      sweepWireDocument('readiness', okBytes, 'the readiness body must be pure JSON')

      // (3) THE STREAM. `subscribe(1, …)` replays from the first seq, so the frames are the whole
      // log whether or not the run is already over by the time this connects.
      const stream = await readStream(
        `${origin()}/run/${encodeURIComponent(ack.runId)}/events`,
        bearer,
      )
      expect(stream.status).toBe(200)
      expect(stream.contentType).toContain('text/event-stream')
      expect(stream.corsHeader).toBeNull()
      expect(stream.dataLines.length, 'the stream delivered no envelope at all').toBeGreaterThan(0)

      // THE FRAME VOCABULARY IS CLOSED. `id`, `event`, `data` and comments, and nothing else — a
      // frame field the contract never declared is a side channel beside the envelope, which is the
      // shape a live handle would travel in if one ever did.
      for (const frame of stream.frames) {
        expect(frame.foreignFields, 'an SSE frame carried a field the contract does not declare')
          .toEqual([])
      }

      const observed: string[] = []
      for (const line of stream.dataLines) {
        const envelope = RunEventEnvelopeSchema.parse(JSON.parse(line))
        expect(envelope.runId).toBe(ack.runId)
        observed.push(envelope.type)
        // EVERY PAYLOAD, SWEPT — the ack is shallow and a payload is not, and a handle that leaked
        // would leak into a payload long before it reached a top-level field.
        sweepWireDocument('sseEnvelope', line, `envelope ${envelope.type}: not pure JSON on the wire`)
      }

      // The run reached its terminal event, which is what makes every claim above a claim about a
      // whole run rather than about a prefix somebody happened to catch.
      expect(observed).toContain('runStarted')
      expect(observed).toContain('runFinished')

      // Resuming one seq short of the end yields exactly the terminal envelope, then a close.
      const finalSeq = Number(stream.frames.at(-1)?.id)
      expect(finalSeq, 'the terminal frame carried no id to resume from').toBeGreaterThan(0)

      const replayed = await fetch(
        `${origin()}/api/run-stream/${encodeURIComponent(ack.runId)}?lastEventId=${String(finalSeq - 1)}`,
        { signal: AbortSignal.timeout(20_000) },
      )
      expect(replayed.status).toBe(200)
      expect(replayed.headers.get('content-type')).toContain('text/event-stream')
      // `.text()` RESOLVES ONLY WHEN THE SOCKET ENDS, which is the "and closes" half.
      const replayedBody = await replayed.text()
      const replayedFrames = replayedBody.split('\n\n').filter((frame) => frame.trim() !== '')
        .map(parseFrame)
      const replayedData = replayedFrames
        .map((frame) => frame.data)
        .filter((line): line is string => line !== undefined)
      expect(
        replayedData.length,
        `a resume one seq short of the end must replay exactly the terminal envelope: ${replayedBody}`,
      ).toBe(1)
      const terminal = RunEventEnvelopeSchema.parse(JSON.parse(replayedData[0] as string))
      expect(terminal.type).toBe('runFinished')
      expect(terminal.seq).toBe(finalSeq)
      expect(terminal.runId).toBe(ack.runId)
      for (const frame of replayedFrames) {
        expect(frame.foreignFields, 'a replayed frame carried an undeclared field').toEqual([])
      }
      // Every document put on the wire goes through the sweep and declares its class.
      sweepWireDocument('sseEnvelope', replayedData[0] as string, 'the replayed terminal envelope')

      // And a run this process never started is 404 on the same door, not an empty stream.
      const unknown = await fetch(`${origin()}/api/run-stream/r_403_03_never_started`)
      expect(unknown.status).toBe(404)
      const unknownBytes = await unknown.text()
      expect(JSON.parse(unknownBytes)).toEqual({ error: 'unknown_run' })
      sweepWireDocument('errorBody', unknownBytes, 'the unknown-run refusal must be pure JSON')
    }, WIRE_BUDGET_MS)

  it('the ring-3 sweep spans EVERY declared wire-document class — the complete-set claim', () => {
    // BOTH DIRECTIONS, on the RunSession-member census's own reasoning one cell up. A declared
    // class with no observed document is a hole the sweep cannot see; an observed document under a
    // class nobody declared is a door that entered the corpus without anybody saying so.
    const observedClasses = [...new Set(observedWireDocuments.map((doc) => doc.wireClass))].sort()
    expect(
      observedClasses,
      'every declared wire-document class must actually have been swept in this run (run the whole '
      + 'file — a --testNamePattern run cannot make this claim)',
    ).toEqual([...WIRE_DOCUMENT_CLASSES].sort())

    // And the register is re-swept as one corpus, so the complete-set claim is a measurement over
    // the union rather than a count of the parts.
    for (const doc of observedWireDocuments) {
      expect(rpcShapeOf(doc.raw), `${doc.wireClass}: re-swept as part of the whole corpus`)
        .toEqual(RPC_SHAPE_CLEAN)
    }
    expect(observedWireDocuments.length, 'the corpus must be non-empty in every class')
      .toBeGreaterThanOrEqual(WIRE_DOCUMENT_CLASSES.length)
  })

  it('is a sweep that can fail — both discriminating rings, driven with synthetic bytes', () => {
    // Each failing branch is driven with bytes shaped like the defect it exists for.
    expect(rpcShapeOf('{"runId":"r_1","status":"failed"}')).toEqual(RPC_SHAPE_CLEAN)

    // Ring 3: a leaked `RunSession` handle, flattened by `JSON.stringify` — the value is gone and
    // the KEY is what is left, at depth, which is why the walk goes to any depth.
    expect(rpcShapeOf('{"runId":"r_1","session":{"done":{},"id":"r_1"}}').handleKeys)
      .toEqual(['done'])
    expect(rpcShapeOf('{"subscribe":null,"cancel":null}').handleKeys)
      .toEqual(['subscribe', 'cancel'])

    // Ring 4: a self-describing JS serialization — how a live object actually gets smuggled across
    // a process boundary. It parses as JSON, so rings 1-3 are silent; the byte-stability ring is
    // what refuses it, because pretty-printed or padded bytes are not the canonical form.
    expect(rpcShapeOf('{\n  "runId": "r_1"\n}').byteUnstable).toBe(true)
    expect(rpcShapeOf('{"runId":"r_1"} ').byteUnstable).toBe(true)

    // And bytes that are not JSON at all are reported rather than thrown on.
    expect(rpcShapeOf('runId=r_1').exotic).toEqual(['$: the bytes are not JSON'])
  })
})
