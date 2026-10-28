import { createServer } from 'node:http'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import { Command } from 'commander'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { resolveConfig } = vi.hoisted(() => ({ resolveConfig: vi.fn() }))

vi.mock('../../config.js', () => ({ resolveConfig }))

import { createQueueCommand } from '../queue.js'

let asked: string[]
let server: Server
let port: number

beforeEach(async () => {
  asked = []
  server = createServer((req, res) => {
    asked.push(`${req.method ?? ''} ${req.url ?? ''}`)
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(
      JSON.stringify({
        concurrency: 1,
        activeSlots: 0,
        pending: { jobs: [] },
        running: { jobs: [] },
      }),
    )
  })
  await new Promise<void>((settle) => {
    server.listen(0, 'localhost', settle)
  })
  port = (server.address() as AddressInfo).port
  vi.stubEnv('AGENT_QA_DASHBOARD_URL', '')
})

afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  await new Promise<void>((settle) => {
    server.close(() => {
      settle()
    })
  })
})

describe('agent-qa queue dashboard address', () => {
  it('queue list asks the dashboard on services.dashboard.port', async () => {
    resolveConfig.mockResolvedValue({ services: { dashboard: { port } } })
    vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)

    const program = new Command('agent-qa').exitOverride()
    program.addCommand(createQueueCommand())
    await program.parseAsync(['node', 'agent-qa', 'queue', 'list'])

    expect(asked).toEqual(['GET /api/queue/status?completed=false'])
  })
})
