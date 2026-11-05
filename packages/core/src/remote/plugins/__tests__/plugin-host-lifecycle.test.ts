import { RemoteRefusalError, type RemoteLeaseEnded } from '@vostride/agent-qa-runner'
import { afterEach, describe, expect, it } from 'vitest'

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
  await project?.cleanup()
  project = undefined
})

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
