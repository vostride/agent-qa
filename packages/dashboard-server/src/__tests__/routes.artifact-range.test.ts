import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  createFunctionRegistry, invokeFunction, RUNS_ARTIFACT_FUNCTION_ID,
  type FunctionDeps, type FunctionRegistry,
} from '@vostride/agent-qa-agent'
import { createEvidenceBlobReader } from '@vostride/agent-qa-agent-local'
import { FsEvidenceArtifactStore } from '@vostride/agent-qa-runner-local'
import { asRunId, type FunctionCaller } from '@vostride/agent-qa-schema'
import type { AgentHost, AgentRegistryHandle } from '../chat/host.js'
import { DashboardDatabase } from '../db/database.js'
import { startServer } from '../server/server.js'

const runId = asRunId('range-route-fixture')
const bytes = Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3, ...Array.from({ length: 60 }, (_, i) => i)])
let root: string
let sha: string
let origin: string
let url: string
let db: DashboardDatabase
let close: (() => void) | undefined

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'artifact-range-route-'))
  sha = new FsEvidenceArtifactStore({ root, runId }).persistDecisionScreenshot(bytes).sha
  const registry = createFunctionRegistry({
    deps: { evidenceBlobs: createEvidenceBlobReader({ agentQaRoot: root }) } as FunctionDeps,
  })
  // no `resolveExecutionContext` registry option and no `grantedScopes`
  // or `safeMode` on the caller; the registry reads none of them.
  const host = {
    registry, caller: { surface: 'dashboard', origin: 'human' },
    runsArtifactFunctionId: RUNS_ARTIFACT_FUNCTION_ID,
    invokeFunction: (handle: AgentRegistryHandle, id: string, input: unknown, caller: FunctionCaller) =>
      invokeFunction(handle as unknown as FunctionRegistry, id, input, caller),
  } as unknown as AgentHost
  db = new DashboardDatabase({ dbPath: ':memory:' })
  const started = await startServer({ declaredSecretMask: (text) => text, db, port: 0, agentHost: host })
  close = started.close
  origin = `http://127.0.0.1:${(started.server.address() as AddressInfo).port}`
  url = `${origin}/api/runs/${runId}/artifacts/${sha}`
})

afterEach(() => {
  close?.()
  close = undefined
  db?.close()
  if (root) rmSync(root, { recursive: true, force: true })
  vi.restoreAllMocks()
})

function commonHeaders(response: Response) {
  expect(response.headers.get('etag')).toBe(`"${sha}"`)
  expect(response.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
  expect(response.headers.get('x-content-type-options')).toBe('nosniff')
  expect(response.headers.get('accept-ranges')).toBe('bytes')
}

it.each([
  ['ROUTE-RANGE-206', 'bytes=10-19', 10, 19],
  ['ROUTE-RANGE-TAIL-BYTE', 'bytes=63-', 63, 63],
  ['ROUTE-RANGE-END-CLAMPED', 'bytes=60-64', 60, 63],
  ['ROUTE-RANGE-END-CLAMPED beyond total', 'bytes=60-999', 60, 63],
] as const)('%s', async (_name, range, start, end) => {
  const wholeRead = vi.spyOn(FsEvidenceArtifactStore.prototype, 'getBlob')
  const response = await fetch(url, { headers: { Range: range } })
  expect(response.status).toBe(206)
  commonHeaders(response)
  expect(response.headers.get('content-range')).toBe(`bytes ${start}-${end}/64`)
  expect(response.headers.get('content-length')).toBe(String(end - start + 1))
  expect(response.headers.get('content-type')).toBe('video/webm')
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes.slice(start, end + 1))
  expect(wholeRead).not.toHaveBeenCalled()
})

it('ROUTE-RANGE-416', async () => {
  const response = await fetch(url, { headers: { Range: 'bytes=64-' } })
  expect(response.status).toBe(416)
  commonHeaders(response)
  expect(response.headers.get('content-range')).toBe('bytes */64')
  expect(response.headers.get('content-length')).toBe('0')
  expect(await response.text()).toBe('')
})

it.each(['bytes=5-2', 'items=0-1', 'bytes=a-b', 'bytes=-5', 'bytes=0-1 trailing', 'bytes=9007199254740992-'])(
  'ROUTE-RANGE-MALFORMED-IS-200 %s', async Range => {
    const response = await fetch(url, { headers: { Range } })
    expect(response.status).toBe(200)
    commonHeaders(response)
    expect(response.headers.get('content-range')).toBeNull()
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes)
  },
)

it('ROUTE-RANGE-MULTI-IS-200', async () => {
  const response = await fetch(url, { headers: { Range: 'bytes=0-1,4-5' } })
  expect(response.status).toBe(200)
  commonHeaders(response)
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes)
})

it.each([undefined, 'bytes=10-19', 'bytes=64-'])(
  'ROUTE-RANGE-304-KEPT %s', async Range => {
    const response = await fetch(url, { headers: {
      'If-None-Match': `"${sha}"`, ...(Range === undefined ? {} : { Range }),
    } })
    expect(response.status).toBe(304)
    commonHeaders(response)
    expect(await response.text()).toBe('')
  },
)

it('ROUTE-RANGE-HEADERS-EVERY-ARM', async () => {
  for (const [headers, status] of [
    [{}, 200], [{ Range: 'bytes=0-1' }, 206],
    [{ 'If-None-Match': `"${sha}"` }, 304], [{ Range: 'bytes=64-' }, 416],
  ] as const) {
    const response = await fetch(url, { headers })
    expect(response.status).toBe(status)
    commonHeaders(response)
    await response.arrayBuffer()
  }
})

it('ROUTE-RANGE-NO-SHA-ECHO', async () => {
  for (const [id, address, status, error] of [
    [runId, 'z'.repeat(64), 400, 'malformed_sha'],
    ['%2e%2e%2fescape', sha, 400, 'invalid_run_id'],
    [runId, 'b'.repeat(64), 404, 'blob_absent'],
    ['missing-range-run', sha, 404, 'unknown_run'],
  ] as const) {
    const response = await fetch(`${origin}/api/runs/${id}/artifacts/${address}`, {
      headers: { Range: 'bytes=64-' },
    })
    expect(response.status).toBe(status)
    const body = await response.text()
    expect(JSON.parse(body)).toEqual({ error })
    expect(body).not.toContain(address)
  }
})
