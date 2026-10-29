import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, expect, it, vi } from 'vitest'
import type { AgentHost } from '../chat/host.js'
import { DashboardDatabase } from '../db/database.js'
import { startServer } from '../server/server.js'
import { createRunServiceRoutes, type RunServicePorts } from '../run-service/run-service-routes.js'

const nativeFetch = globalThis.fetch
// Load the dependency-free UI diagnostic at runtime: it is exercised as shipped source,
// without adding dashboard UI source to the server package's TypeScript compilation.
const probeModule = new URL('../../../dashboard-ui/src/lib/media-error-probe.ts', import.meta.url)
const { probeMediaError } = await import(probeModule.href) as {
  probeMediaError(url: string, signal: AbortSignal): Promise<{ status?: number }>
}
const sha = 'a'.repeat(64)
const closers: Array<() => void | Promise<void>> = []
afterEach(async () => {
  vi.unstubAllGlobals()
  for (const close of closers.splice(0).reverse()) await close()
})

// Real routing (including exact method matching and the remote bearer verdict), with a
// deterministic artifact host. The existing range-route tests cover the real disk binding.
for (const door of ['local', 'remote'] as const) {
  for (const [outcome, status] of [
    ['readable', 206], ['EvidenceBlobAbsentError', 404],
    ['TemporaryReadError', 500], ['FunctionNotBoundError', 503],
  ] as const) {
    it(`media diagnostic reaches ${door} dispatcher: ${outcome}`, async () => {
      const invokeFunction = vi.fn(async () => {
        if (outcome !== 'readable') throw Object.assign(new Error('synthetic failure'), { name: outcome })
        return { sha, contentType: 'video/webm', bytesBase64: 'Gg==', byteLength: 1,
          range: { start: 0, end: 0 }, totalLength: 128 }
      })
      const host = { registry: {}, caller: {}, runsArtifactFunctionId: 'synthetic-artifact',
        invokeFunction } as unknown as AgentHost
      let server: Server
      let path: string
      if (door === 'local') {
        const db = new DashboardDatabase({ dbPath: ':memory:' })
        closers.push(() => db.close())
        const started = await startServer({ declaredSecretMask: (text) => text, db, port: 0, agentHost: host })
        server = started.server
        closers.push(started.close)
        path = `/api/runs/media-probe/artifacts/${sha}`
      } else {
        // 2026-10-01 (432-21, D-12): the run service is tokenless — no `verifyBearer`.
        server = createServer(createRunServiceRoutes({ agentHost: host } as unknown as RunServicePorts))
        await new Promise<void>((resolve, reject) => {
          server.once('error', reject)
          server.listen(0, '127.0.0.1', resolve)
        })
        closers.push(() => new Promise<void>(resolve => {
          server.closeAllConnections(); server.close(() => resolve())
        }))
        path = `/run/media-probe/artifacts/${sha}`
      }
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}${path}`
      if (door === 'remote') {
        // RE-SPELLED 2026-10-01 (432-21, D-12/D-13): the door refuses a cross-site probe, not an
        // unauthenticated one, before anything is dispatched.
        expect((await nativeFetch(url, { headers: { Origin: 'https://evil.example' } })).status).toBe(403)
        expect(invokeFunction).not.toHaveBeenCalled()
      }
      expect(await probeMediaError(url, new AbortController().signal)).toEqual({ status })
      expect(invokeFunction).toHaveBeenCalledOnce()
      expect(invokeFunction.mock.calls[0]).toContainEqual({ runId: 'media-probe', sha, range: { start: 0, end: 0 } })
    })
  }
}
