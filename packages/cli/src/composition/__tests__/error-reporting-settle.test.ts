// Every settle in the process draws on one budget and races it against a ref'd timer, and the
// transport's request module destroys a report request that gets no answer.

import { mkdtempSync, rmSync } from 'node:fs'
import { Agent as HttpAgent, request as httpRequest } from 'node:http'
import { Agent as HttpsAgent } from 'node:https'
import { createServer, type AddressInfo, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  projectWithPrivacy,
  recordingReportTransport,
  removeReportProjects,
} from '../../__tests__/error-report-recorder.js'
import type { RecordingReportTransport } from '../../__tests__/error-report-recorder.js'
import {
  boundedRequestModule,
  closeErrorReporting,
  settleReporting,
  startErrorReporting,
} from '../error-reporting.js'
import type { ErrorReporter, ReportRequestModule } from '../error-reporting.js'

const INVENTED_DSN = 'http://key@127.0.0.1:9/1'
const BUDGET_MS = 300
const SOCKET_TIMEOUT_MS = 200

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

// Timing cells assert ranges, never exact figures.
function expectAboutOneBudget(ms: number): void {
  expect(ms).toBeGreaterThanOrEqual(0.7 * BUDGET_MS)
  expect(ms).toBeLessThan(1.7 * BUDGET_MS)
}

function expectAlmostAtOnce(ms: number): void {
  expect(ms).toBeLessThan(BUDGET_MS / 3)
}

function expectAboutHalfABudget(ms: number): void {
  expect(ms).toBeGreaterThan(BUDGET_MS / 5)
  expect(ms).toBeLessThan(0.9 * BUDGET_MS)
}

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

describe('the settle step', () => {
  it('returns inside its budget against a transport that never settles, and keeps the exit code set before it', async () => {
    const { reporter, recorder } = await reportingOnADeadNetwork()
    reporter.capture(new Error('an error on a dead network'))
    process.exitCode = 3

    const waited = await timed(settle)

    expect(recorder.envelopes.length).toBeGreaterThan(0)
    expect(waited).toBeLessThan(1_000)
    expectAboutOneBudget(waited)
    expect(process.exitCode).toBe(3)
  }, 5_000)

  it('takes about one budget for two settles started back to back against that transport, the second returning almost at once', async () => {
    const { reporter } = await reportingOnADeadNetwork()
    reporter.capture(new Error('an error on a dead network'))

    let second = Number.NaN
    const both = await timed(async () => {
      await settle()
      second = await timed(settle)
    })

    expectAboutOneBudget(both)
    expectAlmostAtOnce(second)
  }, 5_000)

  it('returns a settle that starts while another waits almost at once after it, the two taking about one budget', async () => {
    const { reporter } = await reportingOnADeadNetwork()
    reporter.capture(new Error('an error on a dead network'))
    const began = performance.now()
    const returned = () => performance.now() - began

    const first = settle().then(returned)
    await sleep(BUDGET_MS / 2)
    const second = settle().then(returned)
    const [firstReturned, secondReturned] = await Promise.all([first, second])

    expectAboutOneBudget(secondReturned)
    expect(secondReturned).toBeGreaterThanOrEqual(firstReturned)
    expectAlmostAtOnce(secondReturned - firstReturned)
  }, 5_000)

  it('waits a whole budget in a settle that starts one and a half budgets after one that had nothing to send', async () => {
    const { reporter } = await reportingOnADeadNetwork()
    const began = performance.now()

    const quiet = await timed(settle)
    await sleep(1.5 * BUDGET_MS - (performance.now() - began))
    reporter.capture(new Error('an error after a quiet settle'))
    const waited = await timed(settle)

    expectAlmostAtOnce(quiet)
    expectAboutOneBudget(waited)
  }, 5_000)

  it('waits about half a budget in a settle that starts half a budget after one that used it all', async () => {
    const { reporter } = await reportingOnADeadNetwork()
    reporter.capture(new Error('an error on a dead network'))

    const first = await timed(settle)
    await sleep(BUDGET_MS / 2)
    const second = await timed(settle)

    expectAboutOneBudget(first)
    expectAboutHalfABudget(second)
  }, 5_000)

  it('waits a whole budget again in a settle that starts a whole budget after the last one returned', async () => {
    const { reporter } = await reportingOnADeadNetwork()
    reporter.capture(new Error('an error on a dead network'))

    const first = await timed(settle)
    await sleep(BUDGET_MS)
    const second = await timed(settle)

    expectAboutOneBudget(first)
    expectAboutOneBudget(second)
  }, 5_000)

  it('never hands the flush less than a millisecond, and with nothing left starts the analytics shutdown without waiting for it', async () => {
    const { reporter } = await reportingOnADeadNetwork()
    reporter.capture(new Error('an error on a dead network'))
    const flush = vi.spyOn(reporter, 'flush')
    const shutdown = vi.fn(
      () =>
        new Promise<void>((_, reject) => {
          setTimeout(() => reject(new Error('the analytics shutdown failed')), BUDGET_MS)
        }),
    )
    const began = performance.now()
    const returned = () => performance.now() - began

    const first = settle().then(returned)
    const second = settleReporting({ analytics: { shutdown }, budgetMs: BUDGET_MS }).then(returned)
    const [firstReturned, secondReturned] = await Promise.all([first, second])
    // The shutdown's rejection lands inside the cell, where an unhandled one would fail it.
    await sleep(BUDGET_MS + 100)

    expectAlmostAtOnce(secondReturned - firstReturned)
    expect(shutdown).toHaveBeenCalledTimes(1)
    expect(flush).toHaveBeenCalled()
    expect(flush.mock.calls.every(([ms]) => ms >= 1)).toBe(true)
  }, 5_000)

  it('has a whole budget again once the reporter is closed', async () => {
    const spent = await reportingOnADeadNetwork()
    spent.reporter.capture(new Error('an error on a dead network'))
    expectAboutOneBudget(await timed(settle))
    spent.recorder.release()
    await closeErrorReporting()

    const { reporter } = await reportingOnADeadNetwork()
    reporter.capture(new Error('an error on another dead network'))
    const waited = await timed(settle)

    expectAboutOneBudget(waited)
  }, 5_000)

  it('finishes an analytics shutdown that takes 50 ms and the report flush inside one budget, calling the shutdown once', async () => {
    const recorder = recordingReportTransport()
    const reporter = await startErrorReporting({
      configPath: projectWithPrivacy().configPath,
      dsn: INVENTED_DSN,
      transport: recorder.transport,
    })
    reporter?.capture(new Error('an error before the exit'))
    let shutDown = false
    const shutdown = vi.fn(async () => {
      await sleep(50)
      shutDown = true
    })

    const waited = await timed(() =>
      settleReporting({ analytics: { shutdown }, budgetMs: BUDGET_MS }),
    )

    expect(shutdown).toHaveBeenCalledTimes(1)
    expect(shutDown).toBe(true)
    expect(recorder.envelopes.length).toBeGreaterThan(0)
    expect(waited).toBeLessThan(BUDGET_MS)
  }, 5_000)

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

interface RequestEnd {
  readonly error?: Error
  readonly closed: boolean
  readonly socketDestroyed: boolean
}

// Sent as the SDK's transport sends a report: a POST through a keep-alive agent whose sockets time
// out. Waits three socket timeouts for the request to close.
async function sendThrough(
  module: ReportRequestModule,
  protocol: 'http:' | 'https:',
  port: number,
): Promise<RequestEnd> {
  const agentOptions = { keepAlive: true, timeout: SOCKET_TIMEOUT_MS }
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
    const ended = await Promise.race([closed, sleep(3 * SOCKET_TIMEOUT_MS).then(() => false)])
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
  it('destroys a request the server never answers on its socket timeout, through node:http for an http: DSN and node:https for an https: one', async () => {
    const server = await silentServer()

    const unbounded = await sendThrough({ request: httpRequest }, 'http:', server.port)
    const overHttp = await sendThrough(boundedRequestModule('http:'), 'http:', server.port)
    const overHttps = await sendThrough(boundedRequestModule('https:'), 'https:', server.port)

    expect(unbounded).toEqual({ closed: false, socketDestroyed: false })
    for (const bounded of [overHttp, overHttps]) {
      expect(bounded.closed).toBe(true)
      expect(bounded.socketDestroyed).toBe(true)
      expect(bounded.error).toBeInstanceOf(Error)
    }
    expect(server.firstBytes).toEqual([0x50, 0x50, 0x16])
  }, 10_000)

  it("is the one the reporter's transport uses, so a report the ingest never answers is closed on the SDK's socket timeout", async () => {
    const server = await silentServer()
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
})
