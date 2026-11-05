import { RemoteRefusalError, type RemoteLeaseEnded } from '@vostride/agent-qa-runner'
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

  it('releases through the restart a session the plugin answered with after its call was refused', async () => {
    const p = host()
    const lab = p.entry('lab', {
      script: { acquire: { delayMs: 300, ignoreCancel: true }, shutdown: { delayMs: 600 } },
    })
    const pool = p.pool([lab], { bounds: { cancelGraceMs: 100, killAfterMs: 1_500 } })

    const refused = await refusalOf(pool.acquire(request('lab-a', 'lab', { deadlineMs: 100 })))

    expect(refused.kind).toBe('timeout')
    await waitFor(() => methodsOf(afterRestart(p.ledger(lab))).length === 3)
    expect(methodsOf(afterRestart(p.ledger(lab)))).toEqual(['initialize', 'release', 'shutdown'])
    expect(afterRestart(p.ledger(lab))[1]?.handle).toEqual({ n: 1 })
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
  it('reaches the debug log masked, and nowhere else', async () => {
    const p = host()
    const lab = p.entry('lab', { stderr: { acquire: 'token=abc123' } })
    const debugLines: string[] = []
    const pool = p.pool([lab], { mask, debugLog: (line) => debugLines.push(line) })

    await pool.acquire(request('lab-a', 'lab'))

    await waitFor(() => debugLines.some((line) => line.includes('token=')))
    expect(debugLines).toContain('token=[secret:LAB_TOKEN]')
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
