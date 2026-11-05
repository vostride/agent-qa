import { execFileSync } from 'node:child_process'

import { afterEach, describe, expect, it } from 'vitest'

import { PLUGIN_ENVIRONMENT_NAMES, pluginEnvironment } from '../environment.js'
import {
  createHostProject,
  isAlive,
  methodsOf,
  webAnswer,
  webSession,
  type HostProject,
} from './plugin-host-fixtures.js'

let project: HostProject | undefined

function host(): HostProject {
  project = createHostProject()
  return project
}

afterEach(async () => {
  await project?.cleanup()
  project = undefined
})

function request(remote: string, entry: string, extra: Record<string, unknown> = {}) {
  return { remote, plugin: { entry }, deadlineMs: 10_000, session: webSession, ...extra }
}

describe('the plugin environment', () => {
  it('passes only the allowed names, every LC_ name, and never NODE_OPTIONS', () => {
    const env = pluginEnvironment(
      {
        PATH: '/bin',
        HOME: '/home/a',
        LC_ALL: 'C',
        https_proxy: 'http://proxy:1',
        NODE_OPTIONS: '--require ./steal.js',
        AWS_SECRET_ACCESS_KEY: 'secret',
        SystemRoot: 'C:\\Windows',
      },
      'darwin',
    )

    expect(env).toEqual({
      PATH: '/bin',
      HOME: '/home/a',
      LC_ALL: 'C',
      https_proxy: 'http://proxy:1',
    })
  })

  it('adds the Windows system names on Windows, matching names without case', () => {
    const env = pluginEnvironment(
      { Path: 'C:\\bin', SystemRoot: 'C:\\Windows', APPDATA: 'C:\\a', node_options: '-r x' },
      'win32',
    )

    expect(env).toEqual({ Path: 'C:\\bin', SystemRoot: 'C:\\Windows', APPDATA: 'C:\\a' })
  })
})

describe('the plugin host pool', () => {
  it('starts nothing until a remote asks for its entry', async () => {
    const p = host()
    const lab = p.entry('lab')
    p.pool([lab])

    await new Promise((resolve) => setTimeout(resolve, 300))

    expect(p.ledger(lab)).toEqual([])
  })

  it('starts one process for two remotes that name the same entry', async () => {
    const p = host()
    const lab = p.entry('lab')
    const pool = p.pool([lab])

    const [first, second] = await Promise.all([
      pool.acquire(request('lab-a', 'lab')),
      pool.acquire(request('lab-b', 'lab')),
    ])

    const ledger = p.ledger(lab)
    expect(methodsOf(ledger).filter((method) => method === 'initialize')).toHaveLength(1)
    expect(ledger.filter((line) => line.method === 'acquire').map((line) => line.remote)).toEqual(
      expect.arrayContaining(['lab-a', 'lab-b']),
    )
    expect(first.connection).toEqual(webAnswer)
    expect(second.plugin).toEqual({
      entry: 'lab',
      path: './plugins/lab',
      version: '1.0.0',
      protocol: 1,
      origin: 'path',
    })
  })

  it("runs the plugin with agent-qa's Node in its own process group and only the allowed environment", async () => {
    const p = host()
    const lab = p.entry('lab', { recordProcess: true })
    const pool = p.pool([lab])
    const before = { options: process.env.NODE_OPTIONS, hostOnly: process.env.AGENT_QA_HOST_ONLY }
    process.env.NODE_OPTIONS = '--no-warnings'
    process.env.AGENT_QA_HOST_ONLY = 'host-only-value'
    try {
      await pool.acquire(request('lab-a', 'lab'))
    } finally {
      if (before.options === undefined) delete process.env.NODE_OPTIONS
      else process.env.NODE_OPTIONS = before.options
      if (before.hostOnly === undefined) delete process.env.AGENT_QA_HOST_ONLY
      else process.env.AGENT_QA_HOST_ONLY = before.hostOnly
    }

    const initialize = p.ledger(lab).find((line) => line.method === 'initialize')
    expect(initialize?.execPath).toBe(process.execPath)
    const envKeys = initialize?.envKeys as string[]
    const allowed = new Set<string>(PLUGIN_ENVIRONMENT_NAMES)
    // macOS sets __CF_USER_TEXT_ENCODING inside every process it starts.
    const passed = envKeys.filter((key) => key !== '__CF_USER_TEXT_ENCODING')
    expect(passed.filter((key) => !allowed.has(key) && !key.startsWith('LC_'))).toEqual([])
    expect(envKeys).not.toContain('NODE_OPTIONS')
    expect(envKeys).not.toContain('AGENT_QA_HOST_ONLY')
    expect(initialize?.host).toEqual({
      pid: process.pid,
      agentQaVersion: '0.2.6',
      playwrightVersion: '1.63.0',
      webdriverioVersion: '9.20.0',
    })

    const pid = initialize?.pid as number
    const pgid = Number(execFileSync('ps', ['-o', 'pgid=', '-p', String(pid)], { encoding: 'utf8' }))
    expect(pgid).toBe(pid)
  })

  it("sends the entry's options with their secret references resolved", async () => {
    const p = host()
    const lab = p.entry('lab', { recordProcess: true, apiKey: '{{secret:LAB_KEY}}' })
    const pool = p.pool([lab])

    await pool.acquire(request('lab-a', 'lab'))

    const initialize = p.ledger(lab).find((line) => line.method === 'initialize')
    expect((initialize?.options as Record<string, unknown>).apiKey).toBe('lab-key-value')
  })

  it('sends the run id only to a plugin whose manifest declares it', async () => {
    const p = host()
    const declares = p.entry('declares', { recordProcess: true }, { runFacts: ['runId'] })
    const silent = p.entry('silent', { recordProcess: true })
    const pool = p.pool([declares, silent], { runFacts: { runId: 'run-7' } })

    await pool.acquire(request('lab-a', 'declares'))
    await pool.acquire(request('lab-b', 'silent'))

    const initializeOf = (entry: typeof declares) =>
      p.ledger(entry).find((line) => line.method === 'initialize')
    expect(initializeOf(declares)?.runFacts).toEqual({ runId: 'run-7' })
    expect(initializeOf(silent)).not.toHaveProperty('runFacts')
  })

  it('calls started and end only when the plugin declares them', async () => {
    const p = host()
    const marks = p.entry('marks', {}, { methods: ['started', 'end'] })
    const bare = p.entry('bare', {}, { methods: [] })
    const pool = p.pool([marks, bare])

    for (const entry of [marks, bare]) {
      const lease = await pool.acquire(request(`${entry.name}-remote`, entry.name))
      await lease.started({ sessionId: 'session-1' })
      await lease.end('passed')
    }

    expect(methodsOf(p.ledger(marks))).toEqual(['initialize', 'acquire', 'started', 'end'])
    expect(methodsOf(p.ledger(bare))).toEqual(['initialize', 'acquire'])
    expect(p.ledger(marks).find((line) => line.method === 'end')?.handle).toEqual({ n: 1 })
  })

  it('releases a lease once, then shuts the plugin down, and the process exits', async () => {
    const p = host()
    const lab = p.entry('lab', { recordProcess: true })
    const pool = p.pool([lab])

    const lease = await pool.acquire(request('lab-a', 'lab'))
    await lease.release()
    await lease.release()
    await pool.shutdown()

    const ledger = p.ledger(lab)
    expect(methodsOf(ledger)).toEqual(['initialize', 'acquire', 'release', 'shutdown'])
    expect(ledger[2]?.handle).toEqual({ n: 1 })
    expect(isAlive(ledger[0]?.pid as number)).toBe(false)
  })

  it('releases every open lease before it shuts the plugin down', async () => {
    const p = host()
    const lab = p.entry('lab')
    const pool = p.pool([lab])

    await pool.acquire(request('lab-a', 'lab'))
    await pool.acquire(request('lab-b', 'lab'))
    await pool.shutdown()

    expect(methodsOf(p.ledger(lab))).toEqual([
      'initialize',
      'acquire',
      'acquire',
      'release',
      'release',
      'shutdown',
    ])
  })
})
