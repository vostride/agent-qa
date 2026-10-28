import { createServer } from 'node:http'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import { Command } from 'commander'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../config.js', () => ({ resolveConfig: vi.fn().mockResolvedValue({}) }))

import { createQueueCommand } from '../queue.js'

const PAIR = /^::stop-commands::([0-9a-f]{32})\n[\s\S]*\n::\1::\n$/u
const ESC = String.fromCharCode(27)
const ANSI = new RegExp(`${ESC}\\[[0-9;]*m`, 'gu')
const plain = (text: string): string => text.replace(ANSI, '')

let answer: { status: number; body: unknown }
let server: Server
let origin: string
let logs: string[]
let errors: string[]
let writes: string[]
let exits: unknown[]

function statusBody(name: string): unknown {
  return {
    concurrency: 2,
    activeSlots: 0,
    pending: {
      jobs: [{ id: 'job-1', name, priority: 0, source: 'cli' }],
    },
    running: { jobs: [] },
  }
}

async function runQueue(...args: string[]): Promise<void> {
  const program = new Command('agent-qa').exitOverride()
  program.addCommand(createQueueCommand())
  await program.parseAsync(['node', 'agent-qa', 'queue', ...args, '--server', origin])
}

beforeEach(async () => {
  logs = []
  errors = []
  writes = []
  exits = []
  server = createServer((_req, res) => {
    res.writeHead(answer.status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(answer.body))
  })
  await new Promise<void>((settle) => { server.listen(0, '127.0.0.1', settle) })
  origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    logs.push(args.map(String).join(' '))
  })
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    errors.push(args.map(String).join(' '))
  })
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    writes.push(String(chunk))
    return true
  })
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    exits.push(code)
  }) as never)
})

afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  await new Promise<void>((settle) => { server.close(() => { settle() }) })
})

describe('queue prints job names as text under GitHub Actions and names a refusal word', () => {
  it('writes the pending rows inside one pair, with the status header outside it', async () => {
    vi.stubEnv('GITHUB_ACTIONS', 'true')
    answer = { status: 200, body: statusBody('::set-output name=x::y') }

    await runQueue('list')

    const blocks = writes.filter((write) => write.includes('::stop-commands::'))
    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toMatch(PAIR)
    expect(blocks[0]).toContain('::set-output name=')
    expect(blocks[0]).toContain('job-1')
    expect(blocks[0]).not.toContain('Run Queue Status')
    const printed = logs.map(plain).join('\n')
    expect(printed).toContain('Run Queue Status')
    expect(printed).toContain('Concurrency: 2 slots (0 active)')
    expect(printed).toContain('Pending (1 jobs):')
    expect(printed).not.toContain('::set-output')
  })

  it('prints the --json document with no # and the same value', async () => {
    vi.stubEnv('GITHUB_ACTIONS', 'true')
    const body = statusBody('##[error]x')
    answer = { status: 200, body }

    await runQueue('list', '--json')

    expect(logs).toHaveLength(1)
    expect(logs[0]).not.toContain('#')
    expect(JSON.parse(logs[0] ?? '')).toEqual(body)
    expect(writes.filter((write) => write.includes('::stop-commands::'))).toEqual([])
  })

  it('names the dashboard refusal word after the status line', async () => {
    answer = { status: 403, body: { error: 'cross_site_refused' } }

    await runQueue('list')

    expect(errors.map(plain)[0]).toBe('Server returned 403: Forbidden (cross_site_refused)')
    expect(exits[0]).toBe(1)
  })

  it('prints the table rows as plain lines off GitHub Actions', async () => {
    vi.stubEnv('GITHUB_ACTIONS', '')
    answer = { status: 200, body: statusBody('checkout flow') }

    await runQueue('list')

    expect(writes.filter((write) => write.includes('::stop-commands::'))).toEqual([])
    const printed = logs.map(plain).join('\n')
    expect(printed).toContain(
      `  1   ${'job-1'.padEnd(12)}  ${'checkout flow'.padEnd(18)}  ${'0'.padEnd(8)}  ${'cli'.padEnd(10)}  `,
    )
  })
})
