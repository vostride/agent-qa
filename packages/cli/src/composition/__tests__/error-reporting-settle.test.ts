// Every settle in the process draws on one budget and races it against a ref'd timer, and the
// transport's request module ends every report request at its deadline, through a proxy too, and
// leaves none open once a settle returns.

import { mkdtempSync, rmSync } from 'node:fs'
import {
  Agent as HttpAgent,
  createServer as createHttpServer,
  request as httpRequest,
} from 'node:http'
import { Agent as HttpsAgent, createServer as createHttpsServer } from 'node:https'
import { connect as netConnect, createServer, type AddressInfo, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSecureContext } from 'node:tls'

import {
  DEFAULT_ANALYTICS_SHUTDOWN_TIMEOUT_MS,
  generateAnalyticsUserId,
} from '@vostride/agent-qa-analytics'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  projectWithPrivacy,
  recordingReportTransport,
  removeReportProjects,
} from '../../__tests__/error-report-recorder.js'
import type { RecordingReportTransport } from '../../__tests__/error-report-recorder.js'
import { inMemoryCertificate } from '../../__tests__/in-memory-certificate.js'
import { createGlobalFailureHandler } from '../../cli-error-handler.js'
import type { GlobalFailureDeps } from '../../cli-error-handler.js'
import {
  ANALYTICS_IDENTITY_TIMEOUT_MS,
  resolveCliAnalyticsIdentity,
} from '../analytics-identity.js'
import {
  closeErrorReporting,
  errorReporter,
  settleReporting,
  startErrorReporting,
} from '../error-reporting.js'
import type { ErrorReporter, SettleReportingInput } from '../error-reporting.js'
import { boundedRequestModule } from '../error-reporting-requests.js'
import type { ReportRequestModule } from '../error-reporting-requests.js'

const INVENTED_DSN = 'http://key@127.0.0.1:9/1'
const BUDGET_MS = 300
// The longest a report request is given in the request module's cells.
const DEADLINE_MS = 300

interface SilentServer {
  readonly port: number
  // The first byte each connection sent: `P` opens a plain POST, 0x16 a TLS handshake.
  readonly firstBytes: number[]
  readonly open: Set<Socket>
  close(): Promise<void>
}

const recorders: RecordingReportTransport[] = []
const servers: SilentServer[] = []
const folders: string[] = []

// No cell reads the auth store in the real home folder.
beforeEach(() => {
  const dataHome = mkdtempSync(join(tmpdir(), 'agent-qa-error-reporting-settle-'))
  folders.push(dataHome)
  vi.stubEnv('XDG_DATA_HOME', dataHome)
})

afterEach(async () => {
  // A settle still waiting on the fake clock returns now, so the next cell's settle never queues
  // behind it.
  if (vi.isFakeTimers()) await vi.runOnlyPendingTimersAsync()
  vi.useRealTimers()
  for (const recorder of recorders.splice(0)) recorder.release()
  await closeErrorReporting()
  for (const server of servers.splice(0)) await server.close()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  removeReportProjects()
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true })
  process.exitCode = undefined
})

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

async function timed(work: () => Promise<unknown>): Promise<number> {
  const started = performance.now()
  await work()
  return performance.now() - started
}

const settle = () => settleReporting({ budgetMs: BUDGET_MS })

// A reporter whose transport keeps every envelope and never settles a send, as on a dead network.
async function reportingOnADeadNetwork(): Promise<{
  readonly reporter: ErrorReporter
  readonly recorder: RecordingReportTransport
}> {
  const recorder = recordingReportTransport({ hang: true })
  recorders.push(recorder)
  const reporter = await startErrorReporting({
    configPath: projectWithPrivacy().configPath,
    dsn: INVENTED_DSN,
    transport: recorder.transport,
  })
  if (reporter === undefined) throw new Error('the reporter did not start')
  return { reporter, recorder }
}

// On real time, since the SDK reads source files before it hands a report to the transport.
async function reportSent(recorder: RecordingReportTransport): Promise<void> {
  await vi.waitFor(() => expect(recorder.envelopes.length).toBeGreaterThan(0), { timeout: 5_000 })
}

// From here on, performance.now() and every timer run on a clock only the cell moves.
function useFakeClock(): void {
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance', 'Date'],
  })
}

interface WatchedSettle {
  // How long after its start, on the fake clock, the settle returned; nothing while it waits.
  returnedAfter(): number | undefined
}

function watchedSettle(input: Omit<SettleReportingInput, 'budgetMs'> = {}): WatchedSettle {
  const began = performance.now()
  let returnedAfter: number | undefined
  void settleReporting({ ...input, budgetMs: BUDGET_MS }).then(() => {
    returnedAfter = performance.now() - began
  })
  return { returnedAfter: () => returnedAfter }
}

// A dead-network reporter holding one report, on the fake clock, with its flush watched.
async function spentOnADeadNetwork() {
  const { reporter, recorder } = await reportingOnADeadNetwork()
  reporter.capture(new Error('an error on a dead network'))
  await reportSent(recorder)
  useFakeClock()
  return { reporter, recorder, flush: vi.spyOn(reporter, 'flush') }
}

describe('the settle step', () => {
  it('returns at its budget against a transport that never settles, and keeps the exit code set before it', async () => {
    const { flush } = await spentOnADeadNetwork()
    process.exitCode = 3

    const settled = watchedSettle()
    await vi.advanceTimersByTimeAsync(BUDGET_MS - 1)
    const beforeTheBudget = settled.returnedAfter()
    await vi.advanceTimersByTimeAsync(1)

    expect(beforeTheBudget).toBeUndefined()
    expect(settled.returnedAfter()).toBe(BUDGET_MS)
    expect(flush.mock.calls).toEqual([[BUDGET_MS]])
    expect(process.exitCode).toBe(3)
  })

  it('takes one budget for two settles started back to back against that transport, the second returning at once', async () => {
    const { flush } = await spentOnADeadNetwork()

    const first = watchedSettle()
    await vi.advanceTimersByTimeAsync(BUDGET_MS)
    const second = watchedSettle()
    await vi.advanceTimersByTimeAsync(0)

    expect(first.returnedAfter()).toBe(BUDGET_MS)
    expect(second.returnedAfter()).toBe(0)
    expect(flush.mock.calls).toEqual([[BUDGET_MS]])
  })

  it('returns a settle that starts while another waits as soon as that one returns, the two taking one budget', async () => {
    const { flush } = await spentOnADeadNetwork()

    const first = watchedSettle()
    await vi.advanceTimersByTimeAsync(BUDGET_MS / 2)
    const second = watchedSettle()
    await vi.advanceTimersByTimeAsync(BUDGET_MS / 2)

    expect(first.returnedAfter()).toBe(BUDGET_MS)
    expect(second.returnedAfter()).toBe(BUDGET_MS / 2)
    expect(flush.mock.calls).toEqual([[BUDGET_MS]])
  })

  it('hands the whole budget to a settle that starts one and a half budgets after one that had nothing to send', async () => {
    const { reporter } = await reportingOnADeadNetwork()
    useFakeClock()
    const flush = vi.spyOn(reporter, 'flush')

    const quiet = watchedSettle()
    await vi.advanceTimersByTimeAsync(1.5 * BUDGET_MS)
    watchedSettle()
    await vi.advanceTimersByTimeAsync(BUDGET_MS)

    expect(quiet.returnedAfter()).toBeLessThan(BUDGET_MS / 10)
    expect(flush.mock.calls).toEqual([[BUDGET_MS], [BUDGET_MS]])
  })

  it('hands half a budget to a settle that starts half a budget after one that used it all', async () => {
    const { flush } = await spentOnADeadNetwork()

    const first = watchedSettle()
    await vi.advanceTimersByTimeAsync(1.5 * BUDGET_MS)
    const second = watchedSettle()
    await vi.advanceTimersByTimeAsync(BUDGET_MS)

    expect(first.returnedAfter()).toBe(BUDGET_MS)
    expect(second.returnedAfter()).toBe(BUDGET_MS / 2)
    expect(flush.mock.calls).toEqual([[BUDGET_MS], [BUDGET_MS / 2]])
  })

  it('hands the whole budget again to a settle that starts a whole budget after the last one returned', async () => {
    const { flush } = await spentOnADeadNetwork()

    const first = watchedSettle()
    await vi.advanceTimersByTimeAsync(2 * BUDGET_MS)
    const second = watchedSettle()
    await vi.advanceTimersByTimeAsync(BUDGET_MS)

    expect(first.returnedAfter()).toBe(BUDGET_MS)
    expect(second.returnedAfter()).toBe(BUDGET_MS)
    expect(flush.mock.calls).toEqual([[BUDGET_MS], [BUDGET_MS]])
  })

  it('never hands the flush less than a millisecond, and with nothing left starts the analytics shutdown without waiting for it', async () => {
    const { flush } = await spentOnADeadNetwork()
    const shutdown = vi.fn(
      () =>
        new Promise<void>((_, reject) => {
          setTimeout(() => reject(new Error('the analytics shutdown failed')), BUDGET_MS)
        }),
    )

    const first = watchedSettle()
    const second = watchedSettle({ analytics: { shutdown } })
    // The shutdown's rejection lands inside the cell, where an unhandled one would fail it.
    await vi.advanceTimersByTimeAsync(2 * BUDGET_MS)

    expect(first.returnedAfter()).toBe(BUDGET_MS)
    expect(second.returnedAfter()).toBe(BUDGET_MS)
    expect(shutdown).toHaveBeenCalledTimes(1)
    expect(flush.mock.calls).toEqual([[BUDGET_MS]])
  })

  it('hands the whole budget again once the reporter is closed', async () => {
    const spent = await spentOnADeadNetwork()
    const first = watchedSettle()
    await vi.advanceTimersByTimeAsync(BUDGET_MS)
    spent.recorder.release()
    const closing = closeErrorReporting()
    await vi.advanceTimersByTimeAsync(10)
    await closing

    const { reporter } = await reportingOnADeadNetwork()
    const flush = vi.spyOn(reporter, 'flush')
    watchedSettle()
    await vi.advanceTimersByTimeAsync(BUDGET_MS)

    expect(first.returnedAfter()).toBe(BUDGET_MS)
    expect(flush.mock.calls).toEqual([[BUDGET_MS]])
  })

  it('returns once an analytics shutdown that takes 50 ms and the report flush finish, calling the shutdown once', async () => {
    const recorder = recordingReportTransport()
    const reporter = await startErrorReporting({
      configPath: projectWithPrivacy().configPath,
      dsn: INVENTED_DSN,
      transport: recorder.transport,
    })
    reporter?.capture(new Error('an error before the exit'))
    await reportSent(recorder)
    useFakeClock()
    let shutDown = false
    const shutdown = vi.fn(async () => {
      await sleep(50)
      shutDown = true
    })

    const settled = watchedSettle({ analytics: { shutdown } })
    await vi.advanceTimersByTimeAsync(BUDGET_MS)

    expect(shutdown).toHaveBeenCalledTimes(1)
    expect(shutDown).toBe(true)
    expect(settled.returnedAfter()).toBe(50)
  })

  it('only awaits the analytics shutdown it is handed when no reporter exists, and starts no timer', async () => {
    const steps: string[] = []
    const timers = vi.spyOn(globalThis, 'setTimeout')

    await settleReporting({
      analytics: {
        shutdown: async () => {
          steps.push('analytics shut down')
        },
      },
      budgetMs: BUDGET_MS,
    })
    steps.push('settled')

    expect(steps).toEqual(['analytics shut down', 'settled'])
    expect(timers).not.toHaveBeenCalled()
  })
})

// The SDK's flush looks once a millisecond for a report still in processing, so a settle with none
// returns at its first look.
const FIRST_LOOK_MS = 1

function nextTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

// Made at one place, so the second error's frames are the first's.
function errorsFromOnePlace(label: string): readonly [Error, Error] {
  const [first, second] = ['first', 'second'].map((which) => new Error(`${label}, the ${which}`))
  return [first!, second!]
}

// The first error of a pair reported on real time by a reporter closed after it, so the SDK holds
// the source lines the second error needs and reads no file for it on the fake clock.
async function errorWithItsSourceRead(label: string): Promise<Error> {
  const recorder = recordingReportTransport()
  recorders.push(recorder)
  const reporter = await startErrorReporting({
    configPath: projectWithPrivacy().configPath,
    dsn: INVENTED_DSN,
    transport: recorder.transport,
  })
  if (reporter === undefined) throw new Error('the reporter did not start')
  const [first, second] = errorsFromOnePlace(label)
  reporter.capture(first)
  await reportSent(recorder)
  await closeErrorReporting()
  return second
}

// A reporter whose identity resolution never settles behind the shipped cut-off, started on the
// fake clock, so the cut-off runs on it from the reporter's start.
async function reportingWithThePendingIdentity(): Promise<{
  readonly reporter: ErrorReporter
  readonly startedAt: number
}> {
  // Loaded before the clock is faked, so the resolution's import resolves from the cache.
  await import('@vostride/agent-qa-agent-local')
  useFakeClock()
  const startedAt = performance.now()
  const recorder = recordingReportTransport()
  recorders.push(recorder)
  let asked = false
  const reporter = await startErrorReporting({
    configPath: projectWithPrivacy().configPath,
    dsn: INVENTED_DSN,
    transport: recorder.transport,
    identity: () =>
      resolveCliAnalyticsIdentity({
        env: {},
        resolve: () => {
          asked = true
          return new Promise(() => {})
        },
      }),
  })
  if (reporter === undefined) throw new Error('the reporter did not start')
  for (let turn = 0; !asked && turn < 1000; turn += 1) await nextTurn()
  if (!asked) throw new Error('the identity was never asked for')
  await systemFactsRead()
  return { reporter, startedAt }
}

// A client reads the system facts with a child process as it starts, on real time, and a report
// waits for them, so they are read before the fake clock moves.
async function systemFactsRead(): Promise<void> {
  const sdk = await import('@sentry/node')
  const client = sdk.getClient()
  const facts = client?.getIntegrationByName('Context')
  if (facts?.processEvent === undefined) throw new Error('the client reads no system facts')
  await facts.processEvent({}, {}, client!)
}

// A reporter whose identity resolved, with a first report sent on real time, so the SDK holds the
// source lines and system facts the second error needs. The second error goes out in the tick it
// is captured in, and the clock is faked after that first report.
async function reportingWithTheResolvedIdentity(label: string): Promise<{ readonly next: Error }> {
  const recorder = recordingReportTransport()
  recorders.push(recorder)
  const reporter = await startErrorReporting({
    configPath: projectWithPrivacy().configPath,
    dsn: INVENTED_DSN,
    transport: recorder.transport,
    identity: async () => ({ distinctId: generateAnalyticsUserId(), runtimeContext: 'user' }),
  })
  if (reporter === undefined) throw new Error('the reporter did not start')
  const [first, next] = errorsFromOnePlace(label)
  reporter.capture(first)
  await reportSent(recorder)
  useFakeClock()
  return { next }
}

// A settle on the default 2-second budget, or the one given, with when it returned on the fake
// clock.
function settleWatchedFrom(
  began: number,
  budgetMs?: number,
): { returnedAfter(): number | undefined } {
  let returnedAfter: number | undefined
  void settleReporting(budgetMs === undefined ? {} : { budgetMs }).then(() => {
    returnedAfter = performance.now() - began
  })
  return { returnedAfter: () => returnedAfter }
}

// The reporter is closed on real time once its identity settled, so the next arm starts afresh.
async function closeOnRealTime(): Promise<void> {
  await vi.advanceTimersByTimeAsync(ANALYTICS_IDENTITY_TIMEOUT_MS)
  vi.useRealTimers()
  await closeErrorReporting()
}

describe('a settle after an error captured while the identity is pending', () => {
  it('returns when the identity cut-off passes, one second after the reporter started, and at its first look once the identity is resolved, inside the 2-second budget', async () => {
    const error = await errorWithItsSourceRead('an error while the identity is pending')
    const pending = await reportingWithThePendingIdentity()
    pending.reporter.capture(error)
    const waiting = settleWatchedFrom(pending.startedAt)
    await vi.advanceTimersByTimeAsync(ANALYTICS_IDENTITY_TIMEOUT_MS - 1)
    const beforeTheCutOff = waiting.returnedAfter()
    await vi.advanceTimersByTimeAsync(1)
    const withThePendingIdentity = waiting.returnedAfter()
    await closeOnRealTime()

    const resolved = await reportingWithTheResolvedIdentity('an error once the identity resolved')
    errorReporter()?.capture(resolved.next)
    const sent = settleWatchedFrom(performance.now())
    await vi.advanceTimersByTimeAsync(FIRST_LOOK_MS)
    const withTheResolvedIdentity = sent.returnedAfter()

    expect(beforeTheCutOff).toBeUndefined()
    expect(withThePendingIdentity).toBe(ANALYTICS_IDENTITY_TIMEOUT_MS)
    expect(withTheResolvedIdentity).toBe(FIRST_LOOK_MS)
    expect(Number(withThePendingIdentity) - Number(withTheResolvedIdentity)).toBeLessThanOrEqual(
      ANALYTICS_IDENTITY_TIMEOUT_MS,
    )
    expect(withThePendingIdentity).toBeLessThanOrEqual(DEFAULT_ANALYTICS_SHUTDOWN_TIMEOUT_MS)
  })

  it('returns at a budget shorter than what is left of the cut-off, and no later', async () => {
    const error = await errorWithItsSourceRead('an error before a short settle')
    const pending = await reportingWithThePendingIdentity()
    pending.reporter.capture(error)
    const waiting = settleWatchedFrom(pending.startedAt, BUDGET_MS)
    await vi.advanceTimersByTimeAsync(BUDGET_MS - 1)
    const beforeTheBudget = waiting.returnedAfter()
    await vi.advanceTimersByTimeAsync(1)

    expect(BUDGET_MS).toBeLessThan(ANALYTICS_IDENTITY_TIMEOUT_MS)
    expect(beforeTheBudget).toBeUndefined()
    expect(waiting.returnedAfter()).toBe(BUDGET_MS)
  })

  it('returns with the identity pending and no error captured when it would with no identity', async () => {
    const pending = await reportingWithThePendingIdentity()
    const waiting = settleWatchedFrom(pending.startedAt)
    await vi.advanceTimersByTimeAsync(FIRST_LOOK_MS)
    const withThePendingIdentity = waiting.returnedAfter()
    await closeOnRealTime()

    useFakeClock()
    const startedAt = performance.now()
    const recorder = recordingReportTransport()
    recorders.push(recorder)
    await startErrorReporting({
      configPath: projectWithPrivacy().configPath,
      dsn: INVENTED_DSN,
      transport: recorder.transport,
    })
    const plain = settleWatchedFrom(startedAt)
    await vi.advanceTimersByTimeAsync(FIRST_LOOK_MS)

    expect(withThePendingIdentity).toBe(plain.returnedAfter())
    expect(withThePendingIdentity).toBe(FIRST_LOOK_MS)
  })
})

interface HandledError {
  readonly holds: ReadonlyArray<{ readonly code: number; readonly after: number }>
  readonly exits: ReadonlyArray<{ readonly code: number; readonly after: number }>
}

// agent-qa's handler for an uncaught error over the real capture and the real settle, with each
// exit code it holds and each exit it calls kept with when it came on the fake clock.
function handleUncaught(error: Error, began: number): HandledError {
  const holds: Array<{ readonly code: number; readonly after: number }> = []
  const exits: Array<{ readonly code: number; readonly after: number }> = []
  const deps: GlobalFailureDeps = {
    print: () => {},
    printFixed: () => {},
    mask: (text) => text,
    setExitCode: () => {},
    holdExitCode: (code) => {
      holds.push({ code, after: performance.now() - began })
    },
    capture: (caught) => {
      errorReporter()?.capture(caught)
    },
    settle: () => settleReporting(),
    flush: async () => {},
    exit: (code) => {
      exits.push({ code, after: performance.now() - began })
    },
    env: {},
  }
  void createGlobalFailureHandler(deps)(error)
  return { holds, exits }
}

describe('the uncaught-error handler after an error while the identity is pending', () => {
  it('holds exit 1 at once and exits 1 when the cut-off passes, and at its first look once the identity is resolved', async () => {
    const error = await errorWithItsSourceRead('an uncaught error while the identity is pending')
    const pending = await reportingWithThePendingIdentity()
    const uncaught = handleUncaught(error, pending.startedAt)
    const heldAtOnce = [...uncaught.holds]
    await vi.advanceTimersByTimeAsync(ANALYTICS_IDENTITY_TIMEOUT_MS - 1)
    const exitsBeforeTheCutOff = [...uncaught.exits]
    await vi.advanceTimersByTimeAsync(1)
    const exitsWithThePendingIdentity = [...uncaught.exits]
    await closeOnRealTime()

    const resolved = await reportingWithTheResolvedIdentity('an uncaught error, identity resolved')
    const afterResolution = handleUncaught(resolved.next, performance.now())
    await vi.advanceTimersByTimeAsync(FIRST_LOOK_MS)

    expect(heldAtOnce).toEqual([{ code: 1, after: 0 }])
    expect(exitsBeforeTheCutOff).toEqual([])
    expect(exitsWithThePendingIdentity).toEqual([{ code: 1, after: ANALYTICS_IDENTITY_TIMEOUT_MS }])
    expect(afterResolution.exits).toEqual([{ code: 1, after: FIRST_LOOK_MS }])
  })
})

// Accepts every connection on loopback and never answers.
async function silentServer(): Promise<SilentServer> {
  const firstBytes: number[] = []
  const open = new Set<Socket>()
  const server = createServer((socket) => {
    open.add(socket)
    socket.once('data', (chunk: Buffer) => {
      firstBytes.push(chunk[0] ?? -1)
    })
    socket.on('error', () => {})
    socket.on('close', () => {
      open.delete(socket)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const { port } = server.address() as AddressInfo
  const silent: SilentServer = {
    port,
    firstBytes,
    open,
    close: () => {
      for (const socket of open) socket.destroy()
      return new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
  servers.push(silent)
  return silent
}

// Answers each connection with a CONNECT's 200 once `delayMs` has passed, then says nothing more.
async function slowProxy(delayMs: number): Promise<SilentServer> {
  const open = new Set<Socket>()
  const server = createServer((socket) => {
    open.add(socket)
    socket.on('error', () => {})
    // Read and dropped, so the server sees the client close.
    socket.resume()
    const answer = setTimeout(() => {
      socket.write('HTTP/1.1 200 Connection established\r\n\r\n')
    }, delayMs)
    socket.on('close', () => {
      clearTimeout(answer)
      open.delete(socket)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const { port } = server.address() as AddressInfo
  const slow: SilentServer = {
    port,
    firstBytes: [],
    open,
    close: () => {
      for (const socket of open) socket.destroy()
      return new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
  servers.push(slow)
  return slow
}

// A loopback port nothing listens on, so a connection to it is refused.
async function refusingServer(): Promise<SilentServer> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const { port } = server.address() as AddressInfo
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return { port, firstBytes: [], open: new Set(), close: async () => {} }
}

interface ForwardingProxy {
  readonly port: number
  // The authority each CONNECT asked for, in order.
  readonly tunnels: string[]
}

// Opens each CONNECT to the host and port it names and pipes both ways.
async function forwardingProxy(): Promise<ForwardingProxy> {
  const tunnels: string[] = []
  const open = new Set<Socket>()
  const server = createServer((socket) => {
    open.add(socket)
    socket.on('error', () => {})
    socket.on('close', () => open.delete(socket))
    let head = ''
    const read = (chunk: Buffer) => {
      head += chunk.toString('latin1')
      const end = head.indexOf('\r\n\r\n')
      if (end === -1) return
      socket.off('data', read)
      const authority = /^CONNECT (\S+) HTTP\/1\.1\r\n/u.exec(head)?.[1] ?? ''
      tunnels.push(authority)
      const separator = authority.lastIndexOf(':')
      const upstream = netConnect(
        Number(authority.slice(separator + 1)),
        authority.slice(0, separator),
        () => {
          socket.write('HTTP/1.1 200 Connection established\r\n\r\n')
          socket.pipe(upstream)
          upstream.pipe(socket)
        },
      )
      open.add(upstream)
      upstream.on('error', () => socket.destroy())
      upstream.on('close', () => open.delete(upstream))
    }
    socket.on('data', read)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const { port } = server.address() as AddressInfo
  servers.push({
    port,
    firstBytes: [],
    open,
    close: () => {
      for (const socket of open) socket.destroy()
      return new Promise<void>((resolve) => server.close(() => resolve()))
    },
  })
  return { port, tunnels }
}

interface RecordingSink {
  readonly port: number
  readonly bodies: string[]
}

// Keeps each request's body and answers 200.
async function recordingSink(): Promise<RecordingSink> {
  const bodies: string[] = []
  const open = new Set<Socket>()
  const server = createHttpServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      bodies.push(Buffer.concat(chunks).toString('utf8'))
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end('{}')
    })
  })
  server.on('connection', (socket: Socket) => {
    open.add(socket)
    socket.on('close', () => open.delete(socket))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const { port } = server.address() as AddressInfo
  servers.push({
    port,
    firstBytes: [],
    open,
    close: () => {
      for (const socket of open) socket.destroy()
      return new Promise<void>((resolve) => server.close(() => resolve()))
    },
  })
  return { port, bodies }
}

interface TlsIngest {
  readonly port: number
  readonly cert: string
  // The name each client sent for SNI, in order; a client that sent none adds nothing.
  readonly serverNames: string[]
}

// An https ingest on loopback with a certificate for `hostNames` alone, answering each report 200.
async function tlsIngest(hostNames: readonly string[]): Promise<TlsIngest> {
  const { key, cert } = inMemoryCertificate(hostNames)
  const serverNames: string[] = []
  const open = new Set<Socket>()
  const server = createHttpsServer(
    {
      key,
      cert,
      SNICallback: (name, answer) => {
        serverNames.push(name)
        answer(null, createSecureContext({ key, cert }))
      },
    },
    (request, response) => {
      request.resume()
      request.on('end', () => {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end('{}')
      })
    },
  )
  server.on('tlsClientError', () => {})
  server.on('connection', (socket: Socket) => {
    open.add(socket)
    socket.on('close', () => open.delete(socket))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const { port } = server.address() as AddressInfo
  servers.push({
    port,
    firstBytes: [],
    open,
    close: () => {
      for (const socket of open) socket.destroy()
      return new Promise<void>((resolve) => server.close(() => resolve()))
    },
  })
  return { port, cert, serverNames }
}

const proxyUrl = (port: number) => `http://127.0.0.1:${port}`

// The variables the SDK's proxy rule reads; any left out are unset, whatever the shell holds.
function proxyVariables(names: {
  readonly http_proxy?: string
  readonly https_proxy?: string
}): void {
  vi.stubEnv('http_proxy', names.http_proxy)
  vi.stubEnv('https_proxy', names.https_proxy)
  vi.stubEnv('no_proxy', undefined)
}

type SendOutcome = 'sent' | 'failed' | 'still open'

// Sent by the SDK's own transport, as the reporter sends; gives up waiting after five deadlines.
async function sendWithSdk(
  url: string,
  module: ReportRequestModule,
  trusted?: string,
): Promise<SendOutcome> {
  const { makeNodeTransport } = await import('@sentry/node')
  const transport = makeNodeTransport({
    url,
    recordDroppedEvent: () => {},
    httpModule: module,
    ...(trusted === undefined ? {} : { caCerts: trusted }),
  })
  const report = [
    { sent_at: '2026-01-01T00:00:00.000Z' },
    [[{ type: 'event' }, { message: 'a report through the module' }]],
  ] as unknown as Parameters<typeof transport.send>[0]
  return await Promise.race([
    Promise.resolve(transport.send(report)).then(
      (): SendOutcome => 'sent',
      (): SendOutcome => 'failed',
    ),
    sleep(5 * DEADLINE_MS).then((): SendOutcome => 'still open'),
  ])
}

interface RequestEnd {
  readonly error?: Error
  readonly closed: boolean
  readonly socketDestroyed: boolean
}

// Sent as the SDK's transport sends a report: a POST through a keep-alive agent that sets no socket
// timeout. Waits three deadlines for the request to close.
async function sendThrough(
  module: ReportRequestModule,
  protocol: 'http:' | 'https:',
  port: number,
): Promise<RequestEnd> {
  const agentOptions = { keepAlive: true }
  const agent = protocol === 'https:' ? new HttpsAgent(agentOptions) : new HttpAgent(agentOptions)
  try {
    const seen: { error?: Error; socket?: Socket } = {}
    const request = module.request(
      { method: 'POST', agent, hostname: '127.0.0.1', port, path: '/api/1/envelope/', protocol },
      () => {},
    )
    request.once('socket', (socket) => {
      seen.socket = socket
    })
    request.on('error', (error) => {
      seen.error = error
    })
    const closed = new Promise<boolean>((resolve) => {
      request.once('close', () => resolve(true))
    })
    request.end('{}')
    const ended = await Promise.race([closed, sleep(3 * DEADLINE_MS).then(() => false)])
    return {
      ...(seen.error === undefined ? {} : { error: seen.error }),
      closed: ended,
      socketDestroyed: seen.socket?.destroyed === true,
    }
  } finally {
    agent.destroy()
  }
}

describe('the request module handed to the transport', () => {
  it('ends a request the ingest never answers at its deadline, though the agent it is handed sets no socket timeout, through node:http for an http: DSN and node:https for an https: one', async () => {
    const server = await silentServer()
    const bounded = (protocol: 'http:' | 'https:') =>
      boundedRequestModule(protocol, { timeoutMs: DEADLINE_MS, env: {} })

    const unbounded = await sendThrough({ request: httpRequest }, 'http:', server.port)
    const overHttp = await sendThrough(bounded('http:'), 'http:', server.port)
    const overHttps = await sendThrough(bounded('https:'), 'https:', server.port)

    expect(unbounded).toEqual({ closed: false, socketDestroyed: false })
    for (const end of [overHttp, overHttps]) {
      expect(end.closed).toBe(true)
      expect(end.socketDestroyed).toBe(true)
      expect(end.error).toBeInstanceOf(Error)
    }
    expect(server.firstBytes).toEqual([0x50, 0x50, 0x16])
  }, 10_000)

  it.each([
    { name: 'never answers', start: silentServer },
    { name: 'answers four deadlines late', start: () => slowProxy(4 * DEADLINE_MS) },
    { name: 'refuses the connection', start: refusingServer },
  ])(
    'fails a report sent through a proxy that $name by its deadline and leaves the proxy no open socket',
    async ({ start }) => {
      const proxy = await start()
      proxyVariables({ http_proxy: proxyUrl(proxy.port) })

      const outcome = await sendWithSdk(
        'http://127.0.0.1:9/api/1/envelope/',
        boundedRequestModule('http:', { timeoutMs: DEADLINE_MS }),
      )

      expect(outcome).toBe('failed')
      await vi.waitFor(() => expect(proxy.open.size).toBe(0), { timeout: 3 * DEADLINE_MS })
    },
    10_000,
  )

  it('sends a report through a proxy that opens the tunnel, and tunnels an https: report the same way', async () => {
    const proxy = await forwardingProxy()
    const sink = await recordingSink()
    const ingest = await silentServer()
    proxyVariables({ http_proxy: proxyUrl(proxy.port), https_proxy: proxyUrl(proxy.port) })

    const plain = await sendWithSdk(
      `http://127.0.0.1:${sink.port}/api/1/envelope/`,
      boundedRequestModule('http:', { timeoutMs: DEADLINE_MS }),
    )
    const secure = await sendWithSdk(
      `https://127.0.0.1:${ingest.port}/api/1/envelope/`,
      boundedRequestModule('https:', { timeoutMs: DEADLINE_MS }),
    )

    expect(plain).toBe('sent')
    expect(sink.bodies.join('\n')).toContain('a report through the module')
    // No TLS server answers the tunnelled handshake, so that report ends at its deadline.
    expect(secure).toBe('failed')
    expect(ingest.firstBytes).toEqual([0x16])
    expect(proxy.tunnels).toEqual([`127.0.0.1:${sink.port}`, `127.0.0.1:${ingest.port}`])
  }, 10_000)

  it("checks an https: ingest's certificate against the ingest's own host through a proxy as a direct report does, and sends SNI for a host name only", async () => {
    const ingest = await tlsIngest(['localhost'])
    const proxy = await forwardingProxy()
    const sent = (host: string, path: 'direct' | 'through the proxy', trusted?: string) => {
      proxyVariables(path === 'direct' ? {} : { https_proxy: proxyUrl(proxy.port) })
      return sendWithSdk(
        `https://${host}:${ingest.port}/api/1/envelope/`,
        boundedRequestModule('https:', { timeoutMs: DEADLINE_MS }),
        trusted,
      )
    }

    const outcomes = {
      byNameDirect: await sent('localhost', 'direct', ingest.cert),
      byNameThroughTheProxy: await sent('localhost', 'through the proxy', ingest.cert),
      byAddressDirect: await sent('127.0.0.1', 'direct', ingest.cert),
      byAddressThroughTheProxy: await sent('127.0.0.1', 'through the proxy', ingest.cert),
      untrustedThroughTheProxy: await sent('localhost', 'through the proxy'),
    }

    expect(outcomes).toEqual({
      byNameDirect: 'sent',
      byNameThroughTheProxy: 'sent',
      byAddressDirect: 'failed',
      byAddressThroughTheProxy: 'failed',
      untrustedThroughTheProxy: 'failed',
    })
    expect(ingest.serverNames).toEqual(['localhost', 'localhost', 'localhost'])
    expect(proxy.tunnels).toEqual([
      `localhost:${ingest.port}`,
      `127.0.0.1:${ingest.port}`,
      `localhost:${ingest.port}`,
    ])
  }, 15_000)

  it('fails a tunnelled report at once with the error its TLS start throws, closes the tunnel, clears its deadline and lets nothing escape', async () => {
    const proxy = await forwardingProxy()
    const ingest = await silentServer()
    proxyVariables({ https_proxy: proxyUrl(proxy.port) })
    const escaped: unknown[] = []
    const record = (error: unknown) => {
      escaped.push(error)
    }
    const deadlineMs = 10 * DEADLINE_MS
    const throwing = boundedRequestModule('https:', {
      timeoutMs: deadlineMs,
      connectTls: () => {
        throw new Error('the TLS layer refused to start')
      },
    })
    const timers = vi.spyOn(globalThis, 'setTimeout')
    const cleared = vi.spyOn(globalThis, 'clearTimeout')

    process.on('uncaughtException', record)
    const end = await sendThrough(throwing, 'https:', ingest.port).finally(() => {
      process.off('uncaughtException', record)
    })

    expect(end.error?.message).toBe('the TLS layer refused to start')
    expect(escaped).toEqual([])
    expect(proxy.tunnels).toEqual([`127.0.0.1:${ingest.port}`])
    await vi.waitFor(() => expect(ingest.open.size).toBe(0), { timeout: 3 * DEADLINE_MS })
    const deadline = timers.mock.calls.findIndex(([, ms]) => ms === deadlineMs)
    expect(deadline, 'the request set its deadline').toBeGreaterThanOrEqual(0)
    expect(cleared).toHaveBeenCalledWith(timers.mock.results[deadline]?.value)
  }, 10_000)

  it("is the one the reporter's transport uses, so a report the ingest never answers is closed at its deadline", async () => {
    const server = await silentServer()
    proxyVariables({})
    const reporter = await startErrorReporting({
      configPath: projectWithPrivacy().configPath,
      dsn: `http://key@127.0.0.1:${server.port}/1`,
    })

    reporter?.capture(new Error('a report nobody answers'))
    await vi.waitFor(() => expect(server.firstBytes).toEqual([0x50]), { timeout: 2_000 })
    const held = await timed(() =>
      vi.waitFor(() => expect(server.open.size).toBe(0), { timeout: 5_000, interval: 50 }),
    )

    expect(held).toBeLessThan(4_000)
  }, 10_000)

  it('leaves no report request of the reporter open once a settle returns at its budget', async () => {
    const server = await silentServer()
    proxyVariables({})
    const reporter = await startErrorReporting({
      configPath: projectWithPrivacy().configPath,
      dsn: `http://key@127.0.0.1:${server.port}/1`,
    })
    reporter?.capture(new Error('a report nobody answers'))
    await vi.waitFor(() => expect(server.firstBytes).toEqual([0x50]), { timeout: 2_000 })

    await settle()

    // Well inside the request's own deadline, which is the whole default budget.
    await vi.waitFor(() => expect(server.open.size).toBe(0), { timeout: 1_000, interval: 20 })
  }, 10_000)
})
