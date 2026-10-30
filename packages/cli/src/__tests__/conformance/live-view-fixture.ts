// Planted so a cell can hold the run anywhere; bus, server, mint and registry are the shipped ones.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import type { Server } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

import type { LiveEditorAttachment, LiveEditorSubjects } from '@vostride/agent-qa-dashboard'
import { generateTestId } from '@vostride/agent-qa-ids'
import { createLiveStreamHub, createRunEventBus } from '@vostride/agent-qa-runner'
import type { LiveStreamCapability, RunEventBus } from '@vostride/agent-qa-runner'
import type {
  CompletedRunHandoff,
  LiveFrame,
  LiveFrameEndReason,
  LiveFrameSubscription,
  LiveStreamDeclaration,
  LiveStreamKind,
  RunCompletion,
  RunEventEnvelope,
  RunId,
  RunSession,
  RunStatus,
} from '@vostride/agent-qa-schema'

import { DASHBOARD_FUNCTION_CALLER, composeDashboardDoor, createDashboardRunDoor } from '../../commands/dashboard.js'
import {
  composeLiveView,
  mintEditorLiveUrlThrough,
  mintLiveUrlThrough,
} from '../../composition/live-view-composition.js'
import { createRunServiceSessionRegistry } from '../../composition/run-service-session-registry.js'
import { trackTempRoot } from './spawned-chat.js'

/** How often a planted screencast hands its subscribers a frame. */
export const PLANTED_FRAME_INTERVAL_MS = 200

export interface PlantedLiveRun {
  readonly runId: string
  readonly session: RunSession
  /** The REAL bus behind `subscribe` — publish through this and the door serves it verbatim. */
  readonly bus: RunEventBus
  /** Every frame id this run's subscribers acked, in ack order. */
  ackedFrameIds(): readonly number[]
  /** Every frame id the producer handed out, in mint order. */
  deliveredFrameIds(): readonly number[]
  // How many times `cancel()` is called; no viewer may raise it above 0.
  cancelCalls(): number
  /** How many frame subscriptions are open right now. */
  openFrameSubscriptions(): number
  /** Whether `done` has settled yet — a detach must not settle it. */
  isDone(): boolean
  /** Settle `done`, as the run shell does once the handoff is written. */
  finish(verdict?: RunStatus): void
  /**
   * Declare a DIFFERENT stream capability from this instant on — the production ordering, stated
   * as an EVENT the cell fires rather than a wall clock.
   *
   * WHY THIS IS NOT A `capabilityAfterMs` OPTION. In production the two facts are causally
   * ordered: `registerAdapterLiveStream` runs before the member's first step
   * (`run-composition.ts:602`, `run.ts:4091`). A harness that latched on a timer would leave them
   * unordered relative to every other fixture event, which at k=5 is a coin flip whose losing side
   * is indistinguishable from the defect under test. The cell calls this, so the cell owns the
   * instant. A run whose cell never calls it behaves byte-identically to before.
   */
  latchCapability(next: LiveStreamDeclaration): void
  // Hold the producer frames while the bus keeps its heartbeat: channel alive, picture not.
  stall(): void
  /** Let the producer emit again after `stall()`. */
  resume(): void
  /** How many heartbeat envelopes this run's bus has published so far. */
  heartbeatsSeen(): number
  /** Stop the frame producer and close the bus. Never publishes. */
  close(): void
}

export interface PlantLiveRunInput {
  readonly runId: string
  /** The bus's own heartbeat cadence. 10 s is the shipped default; 60 s makes silence measurable. */
  readonly heartbeatMs?: number
  readonly capability: LiveStreamDeclaration
  /** Real, decodable image bytes. A literal would paint nothing and `data-embed-frames` would stay 0. */
  readonly frameBytes?: Uint8Array
  readonly frameWidth?: number
  readonly frameHeight?: number
  readonly frameIntervalMs?: number
  /** The kind each frame is stamped with. Defaults to the declared capability's kind. */
  readonly frameKind?: LiveStreamKind
}

// The frame id is the producer's own counter: CDP's `sessionId` stays constant across frames.
export function plantLiveRun(input: PlantLiveRunInput): PlantedLiveRun {
  const bus = createRunEventBus({
    runId: input.runId,
    ...(input.heartbeatMs === undefined ? {} : { heartbeatMs: input.heartbeatMs }),
  })

  const acked: number[] = []
  const delivered: number[] = []
  const subscribers = new Set<(frame: LiveFrame) => void>()
  let cancelCalls = 0
  let frameId = 0
  let producer: ReturnType<typeof setInterval> | undefined
  let settled = false
  // A stall holds the picture only; the bus heartbeat runs on and must not keep the dot green.
  let stalled = false
  let heartbeats = 0
  const endListeners: ((reason: LiveFrameEndReason) => void)[] = []
  bus.subscribe(undefined, (envelope) => {
    if (envelope.type === 'heartbeat') heartbeats += 1
  })
  // Both seams read this, so a capability absent at attach and present a beat later needs no timer.
  let declaredCapability: LiveStreamDeclaration = input.capability

  let settle: (completion: RunCompletion) => void = () => {}
  const done = new Promise<RunCompletion>((resolvePromise) => { settle = resolvePromise })

  const startProducer = (): void => {
    if (producer !== undefined) return
    producer = setInterval(() => {
      if (subscribers.size === 0 || stalled) return
      frameId += 1
      delivered.push(frameId)
      // Stamped as a member's hub stamps them: capture time and the producing kind.
      const kind = input.frameKind ?? (declaredCapability.kind === 'none' ? undefined : declaredCapability.kind)
      const frame: LiveFrame = {
        id: frameId,
        bytes: input.frameBytes ?? new Uint8Array(0),
        metadata: { width: input.frameWidth ?? 640, height: input.frameHeight ?? 400, timestamp: Date.now() },
        ...(kind === undefined ? {} : { kind }),
      }
      for (const onFrame of [...subscribers]) onFrame(frame)
    }, input.frameIntervalMs ?? PLANTED_FRAME_INTERVAL_MS)
    producer.unref?.()
  }

  const session: RunSession = {
    id: input.runId as RunId,
    status: 'running',
    executionContext: 'local-headless',
    subscribe: (fromSeq, handler) => bus.subscribe(fromSeq, handler),
    subscribeFrames: (_handle, onFrame, onEnd): LiveFrameSubscription | undefined => {
      // AN HONEST ABSENCE, never an error: a handle that declares no stream has no subscription to
      // hand out, and the pane renders a sentence rather than a frame that never arrives.
      if (declaredCapability.kind === 'none') return undefined
      // Held for a cell that ends the stream by name; no cell here does yet.
      if (onEnd !== undefined) endListeners.push(onEnd)
      subscribers.add(onFrame)
      startProducer()
      return {
        ack: (id: number) => { acked.push(id) },
        unsubscribe: () => { subscribers.delete(onFrame) },
      }
    },
    streamCapabilityOf: () => declaredCapability,
    cancel: () => { cancelCalls += 1 },
    done,
  }

  return {
    runId: input.runId,
    session,
    bus,
    ackedFrameIds: () => [...acked],
    deliveredFrameIds: () => [...delivered],
    cancelCalls: () => cancelCalls,
    openFrameSubscriptions: () => subscribers.size,
    isDone: () => settled,
    latchCapability: (next: LiveStreamDeclaration) => { declaredCapability = next },
    stall: () => { stalled = true },
    resume: () => { stalled = false },
    heartbeatsSeen: () => heartbeats,
    finish: (verdict: RunStatus = 'passed') => {
      if (settled) return
      settled = true
      settle({ verdict, handoff: {} as CompletedRunHandoff })
    },
    close: () => {
      if (producer !== undefined) clearInterval(producer)
      producer = undefined
      subscribers.clear()
      bus.close()
    },
  }
}

/** Publish one envelope through a planted run's real bus. */
export function publishTo(run: PlantedLiveRun, type: string, payload: Record<string, unknown>): RunEventEnvelope {
  return run.bus.publish(type as Parameters<RunEventBus['publish']>[0], payload)
}

// ---- Reading the run stream as a CLIENT, not as a fixture --------------------------------------
//
// THE READERS BELOW SPEAK HTTP AND NOTHING ELSE. They open the same door a browser opens, parse
// the same `id:`/`event:` framing an `EventSource` parses, and can be aborted mid-stream — which is
// what makes "a viewer detached" a real socket event rather than a method call on a session.

/** Read one SSE stream until `until` is satisfied (or the budget elapses), then hand back its text. */
export async function readOneStream(
  url: string,
  until: (body: string) => boolean,
  budgetMs = 30_000,
): Promise<string> {
  const controller = new AbortController()
  const timer = setTimeout(() => { controller.abort() }, budgetMs)
  try {
    const response = await fetch(url, { signal: controller.signal })
    if (response.body === null) return await response.text().catch(() => '')
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let body = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      body += decoder.decode(value, { stream: true })
      if (until(body)) break
    }
    await reader.cancel().catch(() => undefined)
    return body
  } catch {
    return ''
  } finally {
    clearTimeout(timer)
  }
}

/** A live SSE reader a cell can watch, abort mid-stream, and question about what it saw. */
export interface IdStreamReader {
  /** Every `id:` the door framed, in delivery order. */
  ids(): readonly number[]
  /** Every `event:` name the door framed, in delivery order. */
  events(): readonly string[]
  readonly status: () => number | undefined
  /** Whether the door closed the socket on its own terms. */
  endedByServer(): boolean
  waitForIdCount(count: number, budgetMs?: number): Promise<void>
  waitForEvent(type: string, budgetMs?: number): Promise<void>
  /** The viewer walks away. NOTHING about the run may change because of this. */
  abort(): void
  /** Settles when the reader stops for any reason. */
  readonly finished: Promise<void>
}

export function openIdStream(url: string, input: { lastEventId?: number } = {}): IdStreamReader {
  const controller = new AbortController()
  const ids: number[] = []
  const events: string[] = []
  let status: number | undefined
  let endedByServer = false
  let aborted = false

  const finished = (async () => {
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        ...(input.lastEventId === undefined
          ? {}
          : { headers: { 'Last-Event-ID': String(input.lastEventId) } }),
      })
      status = response.status
      if (response.body === null) return
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffered = ''
      for (;;) {
        const { done, value } = await reader.read()
        if (done) { endedByServer = !aborted; break }
        buffered += decoder.decode(value, { stream: true })
        const lines = buffered.split('\n')
        buffered = lines.pop() ?? ''
        for (const line of lines) {
          if (line.startsWith('id: ')) ids.push(Number(line.slice(4)))
          else if (line.startsWith('event: ')) events.push(line.slice(7))
        }
      }
    } catch {
      /* an aborted reader is a viewer that walked away, which is this reader's whole subject */
    }
  })()

  const waitUntil = async (predicate: () => boolean, budgetMs: number, what: string): Promise<void> => {
    const deadline = Date.now() + budgetMs
    while (Date.now() < deadline) {
      if (predicate()) return
      await new Promise((tick) => setTimeout(tick, 25))
    }
    throw new Error(`${what} never happened within ${String(budgetMs)}ms; ids=${JSON.stringify(ids)} events=${JSON.stringify(events)}`)
  }

  return {
    ids: () => [...ids],
    events: () => [...events],
    status: () => status,
    endedByServer: () => endedByServer,
    waitForIdCount: async (count, budgetMs = 30_000) =>
      waitUntil(() => ids.length >= count, budgetMs, `${String(count)} ids`),
    waitForEvent: async (type, budgetMs = 30_000) =>
      waitUntil(() => events.includes(type), budgetMs, `event ${type}`),
    abort: () => { aborted = true; controller.abort() },
    finished,
  }
}

export interface LiveViewHarness {
  readonly origin: string
  readonly server: Server
  // Created once beside the run registry and handed to the composition and the server.
  readonly editorSubjects: LiveEditorSubjects
  /** Register a planted run with the session registry the whole composition reads through. */
  plant(run: PlantedLiveRun): void
  /** The run registry's own lookup, the one the run mint and the frame socket's run arm read. */
  attachRun(runId: string): RunSession | undefined
  // The reporter writes rows only for runs the door started, so a planted run's row is put here.
  insertRunRow(input: { readonly runId: string; readonly name: string; readonly status: string }): void
  setRunStatus(runId: string, status: string): void
  close(): Promise<void>
}

/**
 * A hermetic project the dashboard door can open. The three empty files are the ones
 * `requireExistingFiles: true` refuses a project without.
 */
function harnessWorkspace(label: string): string {
  const root = trackTempRoot(mkdtempSync(join(tmpdir(), `agent-qa-${label}-`)))
  const configPath = join(root, 'agent-qa.config.yaml')
  writeFileSync(
    configPath,
    `${JSON.stringify({
      workspace: {
        testMatch: ['tests/**/*.test.yaml'],
        suiteMatch: ['suites/**/*.suite.yaml'],
        hooksFile: 'hooks.yaml',
        envFile: '.env',
        secretsFile: '.env.secrets.local',
      },
      use: { mobile: { appState: 'reset' } },
      registry: {
        targets: {
          conformance: { platform: 'web', url: 'https://conformance.invalid', environment: 'local' },
        },
      },
      services: { dashboard: {} },
    })}\n`,
    'utf8',
  )
  writeFileSync(join(root, 'hooks.yaml'), 'hooks: []\n', 'utf8')
  writeFileSync(join(root, '.env'), '', 'utf8')
  writeFileSync(join(root, '.env.secrets.local'), '', 'utf8')
  mkdirSync(join(root, '.agent-qa'), { recursive: true })
  mkdirSync(join(root, 'tests'), { recursive: true })
  writeFileSync(
    join(root, 'tests', 'probe.test.yaml'),
    'name: The live-view surface probe\n'
    + `test-id: ${generateTestId()}\n`
    + 'target: conformance\n'
    + 'steps:\n'
    + '  - Do nothing this run will ever reach\n',
    'utf8',
  )
  return configPath
}

/**
 * The PRODUCTION server frame, composed exactly as `live-view-tracer.test.ts` composes it, plus a
 * `uiDir`.
 *
 * `uiDir` IS WHAT MAKES THIS A SURFACE AND NOT AN API. The tracer composes without one on purpose
 * — it drives the embed document directly — so every claim about what a PERSON sees needs the
 * static/SPA arm mounted and the built bundle behind it. That is also why the freshness guard is
 * the caller's first assertion: a DOM cell against yesterday's bundle passes and certifies the
 * wrong artifact.
 */
export async function startLiveViewHarness(input: {
  readonly label: string
  /** Absent serves no UI — the API-only posture the process cells use. */
  readonly uiDir?: string
}): Promise<LiveViewHarness> {
  const configPath = harnessWorkspace(input.label)
  const configDir = dirname(resolve(configPath))

  const { DashboardDatabase, createLiveEditorSubjects, startServer } = await import('@vostride/agent-qa-dashboard')
  const db = new DashboardDatabase({ dbPath: join(configDir, 'dashboard.db') })
  const runDoor = await createDashboardRunDoor({ db })
  let boundOrigin: string | undefined

  let publishSession: ((session: RunSession) => void) | undefined
  const sessions = createRunServiceSessionRegistry({
    observeSessions: (observer) => { publishSession = observer; return () => { publishSession = undefined } },
  })
  const editorSubjects = createLiveEditorSubjects()

  const liveView = composeLiveView({
    sessions,
    origin: () => boundOrigin,
    editorCapabilityOf: editorSubjects.capabilityOf,
  })

  const { agentHost, host } = composeDashboardDoor({
    agentQaRoot: join(configDir, '.agent-qa'),
    configPath,
    boundOrigin: () => boundOrigin,
    liveView: liveView.liveView,
    runBridge: runDoor.runBridge,
  })
  runDoor.bindHost(host)

  const started = await startServer({
    declaredSecretMask: (text) => text,
    db,
    port: 0,
    configPath,
    ...(input.uiDir === undefined ? {} : { uiDir: input.uiDir }),
    agentHost,
    executionBackend: runDoor.backend,
    runServiceAttach: sessions.attach,
    liveEditorSubjects: editorSubjects,
    liveView: {
      validate: liveView.validate,
      // THE SHIPPED MINT, BY REFERENCE — the same function both doors call, so a cell that got a
      // liveUrl got it through the op-level gate and not around it.
      mintLiveUrl: mintLiveUrlThrough(host.registry, DASHBOARD_FUNCTION_CALLER),
      // The editor subject's mint, through the same dispatcher under the same caller.
      mintEditorLiveUrl: mintEditorLiveUrlThrough(host.registry, DASHBOARD_FUNCTION_CALLER),
    },
  })

  const address = (started.server as Server).address()
  if (address === null || typeof address === 'string') throw new TypeError('the harness server bound no port')
  boundOrigin = `http://127.0.0.1:${String(address.port)}`

  return {
    origin: boundOrigin,
    server: started.server as Server,
    editorSubjects,
    attachRun: (runId: string) => sessions.attach(runId),
    plant: (run: PlantedLiveRun) => {
      if (publishSession === undefined) throw new Error('the session registry is not observing')
      publishSession(run.session)
    },
    insertRunRow: (row) => {
      db.insertRun({
        id: row.runId,
        name: row.name,
        filePath: 'tests/probe.test.yaml',
        status: row.status,
        duration: 0,
        startedAt: new Date().toISOString(),
        endedAt: new Date().toISOString(),
        platform: 'web',
      })
    },
    setRunStatus: (runId, status) => { db.updateRun(runId, { status }) },
    close: async () => {
      started.close()
      sessions.dispose()
      await host.close()
      db.close()
      rmSync(configDir, { recursive: true, force: true })
    },
  }
}

// A fake producer over the shipped `createLiveStreamHub`, which emits only while subscribed.

export interface PlantEditorSubjectInput {
  readonly sessionId: string
  readonly kind: LiveStreamKind
  readonly frameIntervalMs?: number
  readonly frameBytes?: Uint8Array
}

export interface PlantedEditorSubject {
  readonly sessionId: string
  /** End the session as the session manager does: forget the subject, close its hub, settle `ended`. */
  end(): Promise<void>
  /** Tear down without ending by name. Idempotent. */
  close(): Promise<void>
}

/** A few bytes that are a complete, if empty, JPEG: SOI then EOI. */
const PLANTED_EDITOR_FRAME_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xd9])

export function plantEditorSubject(
  harness: LiveViewHarness,
  input: PlantEditorSubjectInput,
): PlantedEditorSubject {
  let producer: ReturnType<typeof setInterval> | undefined
  let frameId = 0
  const capability: LiveStreamCapability = {
    kind: input.kind,
    start: async (onFrame: (frame: LiveFrame) => void) => {
      if (producer !== undefined) return
      producer = setInterval(() => {
        frameId += 1
        onFrame({
          id: frameId,
          bytes: input.frameBytes ?? PLANTED_EDITOR_FRAME_BYTES,
          metadata: { width: 640, height: 400, timestamp: Date.now() },
        })
      }, input.frameIntervalMs ?? PLANTED_FRAME_INTERVAL_MS)
      producer.unref?.()
    },
    ack: async () => {},
    stop: async () => {
      if (producer !== undefined) clearInterval(producer)
      producer = undefined
    },
  }
  const hub = createLiveStreamHub()
  hub.register(0, capability)

  let settle: () => void = () => {}
  const ended = new Promise<void>((resolvePromise) => { settle = resolvePromise })
  const attachment: LiveEditorAttachment = {
    streamCapabilityOf: (handle) => hub.capabilityOf(handle),
    subscribeFrames: (handle, onFrame, onEnd) => hub.subscribe(handle, onFrame, onEnd),
    ended,
  }
  harness.editorSubjects.register(input.sessionId, attachment)

  let over = false
  const finish = async (): Promise<void> => {
    if (over) return
    over = true
    if (harness.editorSubjects.attach(input.sessionId) === attachment) {
      harness.editorSubjects.unregister(input.sessionId)
    }
    await hub.close()
    settle()
  }

  return {
    sessionId: input.sessionId,
    end: finish,
    close: async () => {
      await finish()
      if (producer !== undefined) clearInterval(producer)
      producer = undefined
    },
  }
}
