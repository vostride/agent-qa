// The WIRE anchors for the authed run service — criterion 4's instrument.
//
// THE CLAIM THIS FILE OWNS, STATED FIRST. Phase 402's milestone acceptance criterion 4 is that
// `RunSession` stays RPC-shaped: no in-process-only handle and no live object leaks across the
// invocation surface. That is a claim about the WIRE. Reaching the seam in-process and reaching it
// over a socket are different questions, and 395 is the phase that made the difference expensive —
// ten cells passed while two shipped commands leaked a planted credential, because the corpus
// asserted on a value the shipped channel never carried. So every cell below drives the SHIPPED
// BINARY: `packages/cli/dist/cli.js`, spawned as `agent-qa dashboard`, reached over TCP, with every
// assertion made against bytes that came off a socket.
//
// WHY AN IN-PROCESS CELL COULD NOT HAVE ASKED THIS. `RunSession` carries `subscribe`, `cancel` and
// `done` — a closure, a closure and a promise. An assertion that imports the type and checks its
// shape is asserting about the type this test file compiled against. An assertion that composes the
// door in this process and reads the object handed to the router is asserting about an object that
// never crossed a process boundary. Only a child process can be asked "what did you actually put on
// the wire", and only bytes can answer.
//
// WHAT IS DIFFERENT ABOUT THIS FILE AND `adapters.ts`'s FIFTH ROW, so neither is mistaken for the
// other. The conformance adapter one file over composes the same door IN THIS PROCESS on an
// ephemeral port and asks WHAT IT REACHES — an enumeration question, correctly answered by the
// production composition. This file asks WHAT IT SERVES, from outside the process entirely, which
// is the only frame in which "no live handle survives" is a measurement rather than a type check.
// D-04's roster row and these anchors land together for exactly that reason: one instrument cannot
// stand in for the other.
//
// THE FRESHNESS GUARD IS PART OF EVERY CELL'S CONTRACT, verbatim from the parity-anchors idiom and
// widened by two packages. A spawned `agent-qa dashboard` resolves `@vostride/agent-qa-runner` and
// `@vostride/agent-qa-core` through their BUILT dists (tsup leaves workspace dependencies external),
// so an anchor run against a stale `runner/dist` drives the previous revision of the very execution
// path whose wire shape it certifies — and reads as proof of this one. `RUN_SERVICE_ANCHORED_BUILDS`
// is what refuses that, naming the offending file.
//
// NO CREDENTIAL VALUE IS EVER ASSERTED OR PRINTED. The fixture declares a variable NAME; the value
// travels only in the child's constructed environment, and no cell below puts it in an expectation
// message.
//
// THE RUN FAILS, AND THAT IS FINE — 402-01's e2e states the same thing about its own probe. The
// planted test names steps no browser is launched for, so the run fails fast. What is asserted here
// is DELIVERY AND SHAPE: an ack under the ack contract, envelopes in the frozen frame, and bytes
// that are pure JSON. A cell that needed a passing run would need a browser and would be measuring
// Playwright.

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

// ---- The RPC-shape sweep -----------------------------------------------------------------------
//
// WHAT "RPC-SHAPED" IS BEING TESTED AGAINST, AND WHAT A WEAKER READING WOULD HAVE BOUGHT. The
// tempting sweep is "walk the parsed body and assert no value is a function". That assertion is a
// TAUTOLOGY: `JSON.parse` cannot produce a function, so it passes on every input that parses,
// including a body that leaked a handle and had it silently dropped by `JSON.stringify`. Writing it
// and calling it a measurement is the shape 393 named — a cell green under the very implementation
// the claim forbids. It is included below anyway, as the cheap outer ring, and labelled as what it
// is; the discriminating rings are the three underneath it.

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
  // both are closures over THIS process's per-run live-stream hub. `subscribeFrames`
  // returns an object holding a `Set` of local callbacks; `streamCapabilityOf` reads a `Map` the
  // member executors filled with adapter objects. Neither has a serialization, and neither means
  // anything to a caller on another machine — the token that lets a remote viewer reach the frames
  // is minted at the function layer, not carried on the session.
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

// ---- The complete-set census over EVERY observed wire document ---------------------------------
//
// THE COMPLETE-SET CLAIM, MADE AUDITABLE. Ring 3 only certifies the documents it was pointed at, so
// the set of documents it is pointed at is itself part of the claim — and a set that lives only in
// the reader's head goes quiet the day a route is added. Every document this file sweeps is
// RECORDED here under a declared class name, and `WIRE_DOCUMENT_CLASSES` is the complete set. The
// census cell asserts the two agree in BOTH directions: a class nobody sweeps is a hole, and a
// sweep of a class nobody declared is a document that entered the corpus unnamed.
//
// 403-02 adds `liveUrl`. `GET /api/runs/:runId/live-url` is a door the phase opened, its body is
// minted by `runs.liveurl`, and it is the one document whose producer can see a `RunSession` and a
// live-stream capability at the same moment — precisely where `subscribeFrames` or
// `streamCapabilityOf` would leak if a shaping step ever grew one.
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
// the run service is tokenless — a request carries no credential.
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
  // no credential reaches the child — none is declared and none is read.
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

  // RE-SPELLED 2026-10-01 from 'refuses POST /run with no credential — 401 from
  // the spawned binary, not a fixture'. No credential is asked for; the spawned binary's refusal is
  // a cross-site POST, answered before the body is read and before any run is queued.
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

  // THE LOCAL READINESS DOOR, PINNED AT THE COMPOSITION THAT SHIPS IT.
  //
  // Criterion 2's preflight rests on ONE line in `commands/dashboard.ts` — the
  // `runServiceReadiness:` option handed to `startServer`. Phase-402 verification deleted that line
  // and measured 390/390 cells green across `dashboard.test.ts`, `run-service-door.e2e.test.ts`,
  // `run-service-auth-hardening.test.ts` and the whole conformance suite, after a forced rebuild.
  // The gate went live-dead in exactly that state: `/api/run-readiness` answers 503, 503 is a member
  // of the UI's NO_READINESS_DOOR set, so `assertRunReadiness` RETURNS and the preflight stops
  // gating with no test signal anywhere.
  //
  // Every other cell that touches readiness supplies the option ITSELF — the e2e composes
  // `runServiceReadiness: runService.readiness` in its own fixture — which is precisely why none of
  // them can see the composition root forgetting to. This one asks the SPAWNED `agent-qa dashboard`
  // and reads the answer off its socket, so the only thing that can satisfy it is the shipped
  // composition still threading the predicate.
  it('serves the LOCAL readiness door from the shipped composition, not a fixture', async () => {
    expect(buildFreshness(RUN_SERVICE_ANCHORED_BUILDS), REBUILD_INSTRUCTION)
      .toEqual({ missing: [], stale: [] })
    // No credential: the local door is loopback-guarded, not token-guarded (D-15's local half).
    const response = await fetch(`${origin()}/api/run-readiness`)
    expect(
      response.status,
      'a 503 here means `agent-qa dashboard` stopped threading runServiceReadiness into '
      + 'startServer, which silently disables the whole of criterion 2\'s preflight',
    ).toBe(200)
    const readiness = RunServiceReadinessSchema.parse(JSON.parse(await response.text()))
    expect(readiness.hostComposed).toBe(true)
  }, WIRE_BUDGET_MS)

  // THE ZERO-TOKEN ARM — history: `runServiceReadiness` used to be composed from TWO arms (a
  // credential-declaring one and a zero-token fallback), and a mutation that dropped the fallback
  // left 374/374 green while a token-less `agent-qa dashboard` answered `/api/run-readiness` 503.
  // there is one arm — the tokenless run service is always composed —
  // and this cell still spawns its OWN dashboard so a second child pins the same answer.
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
      // Honest about what it is: composed, and no credential fact at all.
      expect(Object.keys(readiness).sort()).toEqual(['contractVersion', 'hostComposed', 'service'])
    } finally {
      await child.stop()
    }
  }, WIRE_BUDGET_MS + 30_000)

  it('refuses a caller-supplied runId over the wire, in the current vocabulary', async () => {
    expect(buildFreshness(RUN_SERVICE_ANCHORED_BUILDS), REBUILD_INSTRUCTION)
      .toEqual({ missing: [], stale: [] })
    // THE CURRENT REFUSAL VOCABULARY, not this plan's snapshot of it. 402-06 added a SECOND `runId`
    // refusal after 402-01 shipped the first; asserted here against the spawned binary because a
    // request field the door forgot to refuse is a field a remote caller can use to address a run
    // it did not start, and no in-process cell can say what the shipped bundle refuses.
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

      // (1b) THE MINT BODY. `GET /api/runs/:runId/live-url` is the ONE document
      // whose producer holds a live `RunSession` and a live-stream capability at the same instant:
      // `runs.liveurl` looks the session up in the registry and reads `streamCapabilityOf(handle)`
      // to declare the stream kind. If a shaping step ever carried the session or the capability
      // through instead of the declaration, the residue would land HERE and nowhere else — which is
      // why this door has to be inside the ring-3 sweep and not merely inside a schema parse.
      //
      // No credential: the mint is on the LOCAL door, which the loopback bind guards. Polled
      // because the queue starts the run asynchronously, and bounded because every wait here is.
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
      // And said plainly, because it is the phase's own prohibition rather than a generic ring:
      expect(rpcShapeOf(liveUrlBytes as string).handleKeys, 'no RunSession handle member, at any depth')
        .toEqual([])
      expect(rpcShapeOf(liveUrlBytes as string).functionTyped).toEqual([])
      expect(rpcShapeOf(liveUrlBytes as string).byteUnstable).toBe(false)

      // (2) READINESS, from the same child — the contract version a 403 may bump.
      const ok = await fetch(`${origin()}/ok`, { headers: bearer })
      expect(ok.status).toBe(200)
      const okBytes = await ok.text()
      const readiness = RunServiceReadinessSchema.parse(JSON.parse(okBytes))
      expect(readiness.hostComposed).toBe(true)
      // 432-21/432-22: no credential can be configured, and the answer carries no such fact.
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

      // (4) D-15, THE RETAINED-RUN REPLAY, on the shipped binary.
      //
      // The run above is OVER. Its session stays attachable for the registry's retention window,
      // and what D-15 promises for a reconnect inside that window is: everything after the resume
      // point, up to `runFinished`, and then a clean close. Resuming one seq short of the end is
      // the sharpest form of that promise — the answer must be EXACTLY the terminal envelope and
      // then the socket must end, which is a fact about the whole production chain (the header
      // reaching the core, the `+ 1`, the bus's own replay of a closed run, and the teardown).
      //
      // Driven on the LOCAL door with no credential, read to completion rather than to the
      // first `runFinished`, and bounded: a stream that held the socket open would hang this cell
      // otherwise, and the aborted read is the failure we want to see instead.
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
      // 403-02's carry-forward: any document this file puts on the wire goes through the sweep and
      // declares its class, or the complete-set census reds.
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
    // THE CONTROL. A sweep whose failing branches are only reachable by breaking the product is a
    // sweep nobody has watched fail, and 393's terminating lesson is that a detector's bar is the
    // implementation it must RED on rather than the suite it passes. Each branch is driven here
    // with bytes shaped exactly like the defect it exists for.
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
