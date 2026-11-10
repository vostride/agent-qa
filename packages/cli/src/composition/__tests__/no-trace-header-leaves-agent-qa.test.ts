// No request agent-qa makes, to a tested app, a model provider, a remote or a device, carries a
// trace header, even while the reporter's client is current and a span is active.

import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, request as httpRequest } from 'node:http'
import type { IncomingHttpHeaders, Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  projectWithPrivacy,
  recordingReportTransport,
  removeReportProjects,
} from '../../__tests__/error-report-recorder.js'
import { closeErrorReporting, startErrorReporting } from '../error-reporting.js'

const INVENTED_DSN = 'http://key@127.0.0.1:9/1'
const TRACE_HEADERS = ['sentry-trace', 'baggage', 'traceparent'] as const

interface HeaderSink {
  readonly url: string
  readonly arrived: IncomingHttpHeaders[]
  close(): Promise<void>
}

const tempDirs: string[] = []
const sinks: HeaderSink[] = []

// No cell reads the auth store in the real home folder.
beforeEach(() => {
  const dataHome = mkdtempSync(join(tmpdir(), 'agent-qa-trace-header-auth-'))
  tempDirs.push(dataHome)
  vi.stubEnv('XDG_DATA_HOME', dataHome)
})

afterEach(async () => {
  for (const sink of sinks.splice(0)) await sink.close()
  vi.unstubAllEnvs()
  await closeErrorReporting()
  removeReportProjects()
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

// A real server on loopback, keeping the headers of each request that reaches it.
async function startHeaderSink(): Promise<HeaderSink> {
  const arrived: IncomingHttpHeaders[] = []
  const server: Server = createServer((req, res) => {
    arrived.push(req.headers)
    req.resume()
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('ok')
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  const sink: HeaderSink = {
    url: `http://127.0.0.1:${port}/probe`,
    arrived,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
  sinks.push(sink)
  return sink
}

function httpGet(url: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const outgoing = httpRequest(url, (response) => {
      response.resume()
      response.on('end', () => resolve())
    })
    outgoing.on('error', reject)
    outgoing.end()
  })
}

describe('trace headers', () => {
  it('sends no sentry-trace, baggage or traceparent header on a fetch or an http.request made inside an active span', async () => {
    const reporter = await startErrorReporting({
      configPath: projectWithPrivacy().configPath,
      dsn: INVENTED_DSN,
      transport: recordingReportTransport().transport,
    })
    expect(reporter, 'the reporter did not start, so no client is current').toBeDefined()
    const Sentry = await import('@sentry/node')
    const sink = await startHeaderSink()
    let traceInScope: string | undefined
    let activeSpan: unknown

    await Sentry.startSpan({ name: 'outgoing requests', op: 'agent_qa.step' }, async () => {
      activeSpan = Sentry.getActiveSpan()
      traceInScope = Sentry.getTraceData()['sentry-trace']
      // Both requests start while the span is the active one.
      await Promise.all([fetch(sink.url).then((response) => response.text()), httpGet(sink.url)])
    })

    expect(Sentry.getClient()).toBeDefined()
    expect(activeSpan).toBeDefined()
    expect(traceInScope).toMatch(/^[0-9a-f]{32}-[0-9a-f]{16}/)
    expect(sink.arrived).toHaveLength(2)
    for (const headers of sink.arrived) {
      for (const name of TRACE_HEADERS) expect(headers).not.toHaveProperty(name)
    }
  })
})
