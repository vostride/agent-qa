import {
  RemoteRefusalError,
  type RemoteLeaseEnded,
  type RemoteProgress,
} from '@vostride/agent-qa-runner'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  createHostProject,
  isAlive,
  methodsOf,
  waitFor,
  webSession,
  type HostProject,
  type LedgerLine,
} from './plugin-host-fixtures.js'
import type { PluginHostProgress } from '../host-pool.js'

let project: HostProject | undefined

function host(): HostProject {
  project = createHostProject()
  return project
}

afterEach(async () => {
  vi.restoreAllMocks()
  await project?.cleanup()
  project = undefined
})

const mask = (text: string) => text.replaceAll('abc123', '[secret:LAB_TOKEN]')

function request(remote: string, entry: string, extra: Record<string, unknown> = {}) {
  return { remote, plugin: { entry }, deadlineMs: 10_000, session: webSession, ...extra }
}

async function refusalOf(work: Promise<unknown>): Promise<RemoteRefusalError> {
  const error = await work.then(
    () => undefined,
    (thrown: unknown) => thrown,
  )
  expect(error).toBeInstanceOf(RemoteRefusalError)
  return error as RemoteRefusalError
}

function initializeLines(lines: readonly LedgerLine[]): LedgerLine[] {
  return lines.filter((line) => line.method === 'initialize')
}

// The ledger from the second initialize on: what the release-only restart did.
function afterRestart(lines: readonly LedgerLine[]): LedgerLine[] {
  const second = lines.findIndex((line, index) => index > 0 && line.method === 'initialize')
  return second === -1 ? [] : lines.slice(second)
}

describe('a plugin process that crashes', () => {
  it('ends its open lease lost, and a release-only restart frees the held session without acquiring again', async () => {
    const p = host()
    const lab = p.entry('lab', { recordProcess: true, script: { check: 'crash' } })
    const pool = p.pool([lab])
    const lease = await pool.acquire(request('lab-a', 'lab'))
    const ended: RemoteLeaseEnded[] = []
    lease.onEnded((value) => ended.push(value))

    const refused = await refusalOf(pool.check('lab', [{ name: 'lab-a' }]))

    expect(refused.kind).toBe('lost')
    expect(refused.message).toBe('Remote lab-a: plugin entry lab stopped unexpectedly.')
    await waitFor(() => ended.length === 1)
    expect(ended).toEqual([
      { kind: 'lost', message: 'Remote lab-a: plugin entry lab stopped unexpectedly.' },
    ])
    await lease.release()
    const ledger = p.ledger(lab)
    expect(methodsOf(ledger)).toEqual([
      'initialize',
      'acquire',
      'check',
      'initialize',
      'release',
      'shutdown',
    ])
    expect(afterRestart(ledger)[1]?.handle).toEqual({ n: 1 })
    const [first, fresh] = initializeLines(ledger)
    expect(fresh?.options).toEqual(first?.options)
    expect(fresh?.pid).not.toBe(first?.pid)
    await waitFor(() => !isAlive(fresh?.pid as number))
  })

  it('refuses every later acquire on the crashed entry as lost and never asks the plugin again', async () => {
    const p = host()
    const lab = p.entry('lab', { script: { check: 'crash' } })
    const pool = p.pool([lab])
    const lease = await pool.acquire(request('lab-a', 'lab'))
    await refusalOf(pool.check('lab', [{ name: 'lab-a' }]))
    await lease.release()

    const again = await refusalOf(pool.acquire(request('lab-b', 'lab')))
    await pool.shutdown()

    expect(again.kind).toBe('lost')
    expect(again.message).toBe('Remote lab-b: plugin entry lab stopped unexpectedly.')
    expect(methodsOf(p.ledger(lab)).filter((method) => method === 'acquire')).toHaveLength(1)
  })

  it('tells a listener added after the end at once', async () => {
    const p = host()
    const lab = p.entry('lab', { script: { check: 'crash' } })
    const pool = p.pool([lab])
    const lease = await pool.acquire(request('lab-a', 'lab'))
    await refusalOf(pool.check('lab', [{ name: 'lab-a' }]))
    await lease.release()

    const ended = await new Promise<RemoteLeaseEnded>((resolve) => lease.onEnded(resolve))

    expect(ended.kind).toBe('lost')
  })

  it('starts no restart when the crashed process held no session', async () => {
    const p = host()
    const lab = p.entry('lab', { script: { check: 'crash' } })
    const pool = p.pool([lab])
    const lease = await pool.acquire(request('lab-a', 'lab'))
    await lease.release()

    const refused = await refusalOf(pool.check('lab', [{ name: 'lab-a' }]))
    await pool.shutdown()

    expect(refused.kind).toBe('lost')
    expect(methodsOf(p.ledger(lab))).toEqual(['initialize', 'acquire', 'release', 'check'])
  })
})

describe('a plugin that stays silent after a cancel', () => {
  it('is stopped after the grace: the call is refused as timeout and its other lease ends lost', async () => {
    const p = host()
    const lab = p.entry('lab', { recordProcess: true, script: { acquire: ['ok', 'ignoreCancel'] } })
    const pool = p.pool([lab], { bounds: { cancelGraceMs: 200, killAfterMs: 500 } })
    const lease = await pool.acquire(request('lab-a', 'lab'))
    const ended: RemoteLeaseEnded[] = []
    lease.onEnded((value) => ended.push(value))

    const refused = await refusalOf(pool.acquire(request('lab-b', 'lab', { deadlineMs: 200 })))

    expect(refused.kind).toBe('timeout')
    expect(refused.message).toBe(
      'Remote lab-b: plugin entry lab did not answer within 200ms and was stopped.',
    )
    await waitFor(() => ended.length === 1)
    expect(ended).toEqual([
      {
        kind: 'lost',
        message: 'Remote lab-a: plugin entry lab did not answer within 200ms and was stopped.',
      },
    ])
    await lease.release()
    const ledger = p.ledger(lab)
    expect(isAlive(ledger[0]?.pid as number)).toBe(false)
    expect(methodsOf(afterRestart(ledger))).toEqual(['initialize', 'release', 'shutdown'])
    expect(afterRestart(ledger)[1]?.handle).toEqual({ n: 1 })
  })

  it('still releases a session a kit plugin creates after its call was refused, as it leaves', async () => {
    const p = host()
    const lab = p.entry('lab', {
      script: { acquire: { delayMs: 300, ignoreCancel: true }, shutdown: { delayMs: 600 } },
    })
    const pool = p.pool([lab], { bounds: { cancelGraceMs: 100, killAfterMs: 1_500 } })

    const refused = await refusalOf(pool.acquire(request('lab-a', 'lab', { deadlineMs: 100 })))

    expect(refused.kind).toBe('timeout')
    await waitFor(() => methodsOf(p.ledger(lab)).includes('shutdown'))
    expect(methodsOf(p.ledger(lab))).toEqual(['initialize', 'acquire', 'release', 'shutdown'])
    expect(p.ledger(lab)[2]?.handle).toEqual({ n: 1 })
  })
})

describe('work that arrives around shutdown', () => {
  it('releases a session the plugin answers once shutdown has begun, and refuses its acquire', async () => {
    const p = host()
    const lab = p.entry('lab', {
      script: { acquire: { delayMs: 300, ignoreCancel: true }, shutdown: { delayMs: 600 } },
    })
    const pool = p.pool([lab])

    const acquiring = pool.acquire(request('lab-a', 'lab'))
    await waitFor(() => methodsOf(p.ledger(lab)).includes('acquire'))
    const closing = pool.shutdown()
    const refused = await refusalOf(acquiring)
    await closing

    expect(refused.kind).toBe('ended')
    expect(refused.message).toBe('Remote lab-a: the plugin host has shut down.')
    const releases = p.ledger(lab).filter((line) => line.method === 'release')
    expect(releases.map((line) => line.handle)).toEqual([{ n: 1 }])
  })

  it('refuses a check that comes after shutdown, and starts nothing', async () => {
    const p = host()
    const lab = p.entry('lab', {}, { methods: ['check'] })
    const pool = p.pool([lab])

    await pool.shutdown()
    const refused = await refusalOf(pool.check('lab', [{ name: 'lab-a' }]))

    expect(refused.kind).toBe('ended')
    expect(p.ledger(lab)).toEqual([])
  })
})

describe('a plugin that writes to stdout outside the protocol', () => {
  it('is stopped with one line, its lease ends lost and the restart releases its session', async () => {
    const p = host()
    const lab = p.entry('lab', { recordProcess: true, script: { check: 'noise' } })
    const pool = p.pool([lab])
    const lease = await pool.acquire(request('lab-a', 'lab'))
    const ended: RemoteLeaseEnded[] = []
    lease.onEnded((value) => ended.push(value))

    const refused = await refusalOf(pool.check('lab', [{ name: 'lab-a' }]))

    const line =
      'Remote lab-a: plugin entry lab wrote to stdout outside the protocol and was stopped.'
    expect(refused.kind).toBe('lost')
    expect(refused.message).toBe(line)
    await waitFor(() => ended.length === 1)
    expect(ended).toEqual([{ kind: 'lost', message: line }])
    await lease.release()
    const ledger = p.ledger(lab)
    expect(isAlive(ledger[0]?.pid as number)).toBe(false)
    expect(methodsOf(afterRestart(ledger))).toEqual(['initialize', 'release', 'shutdown'])
    expect(afterRestart(ledger)[1]?.handle).toEqual({ n: 1 })
    const later = await refusalOf(pool.acquire(request('lab-b', 'lab')))
    expect(later.message).toBe(
      'Remote lab-b: plugin entry lab wrote to stdout outside the protocol and was stopped.',
    )
  })
})

describe("a plugin's stderr", () => {
  it("reaches the debug log masked, under its entry's name, and nowhere else", async () => {
    const p = host()
    const lab = p.entry('lab', { stderr: { acquire: 'token=abc123' } })
    const debugLines: string[] = []
    const pool = p.pool([lab], { mask, debugLog: (line) => debugLines.push(line) })

    await pool.acquire(request('lab-a', 'lab'))

    await waitFor(() => debugLines.some((line) => line.includes('token=')))
    expect(debugLines).toContain('plugin lab: token=[secret:LAB_TOKEN]')
    expect(debugLines.join('\n')).not.toContain('abc123')
  })

  it('reaches nothing when no debug log is given', async () => {
    const p = host()
    const lab = p.entry('lab', { stderr: { acquire: 'token=abc123' } })
    const written: string[] = []
    const capture = (chunk: unknown) => {
      written.push(String(chunk))
      return true
    }
    vi.spyOn(process.stderr, 'write').mockImplementation(capture)
    vi.spyOn(process.stdout, 'write').mockImplementation(capture)
    const pool = p.pool([lab], { mask })

    const lease = await pool.acquire(request('lab-a', 'lab'))
    await lease.release()
    await pool.shutdown()

    expect(written.join('').includes('token=')).toBe(false)
  })

  it('gives a call that fails without a reason its first line, masked', async () => {
    const p = host()
    const lab = p.entry('lab', {
      stderr: { acquire: 'token=abc123 has no free browser\nsecond line' },
      script: { acquire: { error: { kind: 'capacity', message: '' } } },
    })
    const pool = p.pool([lab], { mask })

    const refused = await refusalOf(pool.acquire(request('lab-a', 'lab')))

    expect(refused.kind).toBe('capacity')
    expect(refused.message).toBe('Remote lab-a: token=[secret:LAB_TOKEN] has no free browser.')
  })

  it("names a crashed plugin's first line in the line its leases end with", async () => {
    const p = host()
    const lab = p.entry('lab', {
      stderr: { check: 'tunnel died for token=abc123' },
      script: { check: 'crash' },
    })
    const pool = p.pool([lab], { mask })
    const lease = await pool.acquire(request('lab-a', 'lab'))
    const ended: RemoteLeaseEnded[] = []
    lease.onEnded((value) => ended.push(value))

    await refusalOf(pool.check('lab', [{ name: 'lab-a' }]))

    await waitFor(() => ended.length === 1)
    expect(ended[0]?.message).toBe(
      'Remote lab-a: plugin entry lab stopped unexpectedly: '
        + 'tunnel died for token=[secret:LAB_TOKEN].',
    )
  })
})

describe("a plugin's progress", () => {
  it('never extends a deadline: an acquire reporting every 100ms is cancelled at its deadline', async () => {
    const p = host()
    const lab = p.entry('lab', {
      script: { acquire: { delayMs: 2_000 } },
      progress: [{ message: 'queued, 3 ahead', queued: 3 }],
      progressEveryMs: 100,
    })
    const pool = p.pool([lab])
    await pool.check('lab', [{ name: 'lab-a' }])
    const seen: RemoteProgress[] = []
    const started = Date.now()

    const refused = await refusalOf(
      pool.acquire(
        request('lab-a', 'lab', {
          deadlineMs: 500,
          onProgress: (progress: RemoteProgress) => seen.push(progress),
        }),
      ),
    )

    const elapsed = Date.now() - started
    expect(refused.kind).toBe('timeout')
    expect(refused.message).toBe(
      'Remote lab-a: plugin entry lab did not answer acquire within 500ms.',
    )
    expect(elapsed).toBeGreaterThanOrEqual(450)
    expect(elapsed).toBeLessThan(1_500)
    expect(seen.length).toBeGreaterThanOrEqual(3)
    expect(seen[0]).toEqual({ message: 'queued, 3 ahead', queued: 3 })
  })

  it("reaches only the request that sent it, while the pool's listener hears every request", async () => {
    const p = host()
    const lab = p.entry('lab', {
      script: { acquire: { delayMs: 300 } },
      progressByRemote: {
        'lab-a': [{ message: 'queued, 3 ahead', queued: 3 }],
        'lab-b': [{ message: 'uploading app (12 MB)', percent: 40 }],
      },
    })
    const heard: PluginHostProgress[] = []
    const pool = p.pool([lab], { onProgress: (event) => heard.push(event) })
    const seenA: RemoteProgress[] = []
    const seenB: RemoteProgress[] = []

    await Promise.all([
      pool.acquire(
        request('lab-a', 'lab', { onProgress: (update: RemoteProgress) => seenA.push(update) }),
      ),
      pool.acquire(
        request('lab-b', 'lab', { onProgress: (update: RemoteProgress) => seenB.push(update) }),
      ),
    ])

    expect(seenA).toEqual([{ message: 'queued, 3 ahead', queued: 3 }])
    expect(seenB).toEqual([{ message: 'uploading app (12 MB)', percent: 40 }])
    expect(heard).toHaveLength(2)
    expect(heard).toEqual(
      expect.arrayContaining([
        { remote: 'lab-a', entry: 'lab', message: 'queued, 3 ahead', queued: 3 },
        { remote: 'lab-b', entry: 'lab', message: 'uploading app (12 MB)', percent: 40 },
      ]),
    )
  })

  it('reaches every listener without escape sequences or control characters', async () => {
    const p = host()
    const titled = '\u001b]0;owned title\u0007\u001b[2Jqueued\rfor 3s'
    const coloured = '\u001b[31m red\u001b[0m\u009b'
    const lab = p.entry('lab', {
      progress: [{ message: titled + coloured }, { message: 'abc\u001b[0m123 is next' }],
    })
    const heard: PluginHostProgress[] = []
    const pool = p.pool([lab], { mask, onProgress: (event) => heard.push(event) })
    const seen: RemoteProgress[] = []

    await pool.acquire(
      request('lab-a', 'lab', { onProgress: (update: RemoteProgress) => seen.push(update) }),
    )

    expect(seen).toEqual([
      { message: 'queued for 3s red' },
      { message: '[secret:LAB_TOKEN] is next' },
    ])
    expect(heard.map((event) => event.message)).toEqual(seen.map((event) => event.message))
  })

  it('is masked and cut to its first line of at most 200 characters', async () => {
    const p = host()
    const long = 'x'.repeat(300)
    const lab = p.entry('lab', {
      progress: [{ message: 'waiting for pool token=abc123\nsecond line' }, { message: long }],
    })
    const heard: PluginHostProgress[] = []
    const pool = p.pool([lab], { mask, onProgress: (event) => heard.push(event) })
    const seen: RemoteProgress[] = []

    await pool.acquire(
      request('lab-a', 'lab', { onProgress: (update: RemoteProgress) => seen.push(update) }),
    )

    expect(seen).toEqual([
      { message: 'waiting for pool token=[secret:LAB_TOKEN]' },
      { message: 'x'.repeat(200) },
    ])
    expect(heard.map((event) => event.message)).toEqual(seen.map((event) => event.message))
  })
})
