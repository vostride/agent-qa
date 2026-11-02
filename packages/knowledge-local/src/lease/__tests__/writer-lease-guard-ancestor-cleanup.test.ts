// A section removes the empty `memory/queue/` and `memory/` it created, while another thread's
// section may be claiming the guard inside them.
import { existsSync, mkdirSync, mkdtempSync, rmdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { LEASE_GUARD_DIR, acquireWriterLease, heartbeatLease } from '../writer-lease.js'

const fault = vi.hoisted(() => {
  const state: { onMkdir?: (path: string, recursive: boolean) => void } = {}
  return state
})

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  function mkdirSync(
    ...args: Parameters<typeof actual.mkdirSync>
  ): ReturnType<typeof actual.mkdirSync> {
    const [path, options] = args
    const recursive = typeof options === 'object' && options !== null && options.recursive === true
    if (typeof path === 'string') fault.onMkdir?.(path, recursive)
    return actual.mkdirSync(...args)
  }
  return { ...actual, default: { ...actual, mkdirSync }, mkdirSync }
})

function errno(code: string, description: string, path: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: ${description}, mkdir '${path}'`), {
    code,
    syscall: 'mkdir',
    path,
  })
}

describe('a lease-guard claim whose ancestors another section removes', () => {
  let knowledgeRoot: string
  let leaseId: string

  beforeEach(() => {
    knowledgeRoot = mkdtempSync(join(tmpdir(), 'knowledge-lease-guard-ancestors-'))
    const acquired = acquireWriterLease(knowledgeRoot)
    if (acquired.kind !== 'acquired') throw new Error('expected an acquired writer lease')
    leaseId = acquired.leaseId
    fault.onMkdir = undefined
  })

  afterEach(() => {
    fault.onMkdir = undefined
    rmSync(knowledgeRoot, { recursive: true, force: true })
  })

  const queue = (): string => dirname(join(knowledgeRoot, LEASE_GUARD_DIR))

  it('claims the guard and beats when the staging mkdir meets its parent removed, as macOS reports with EINVAL', () => {
    fault.onMkdir = (path, recursive) => {
      if (recursive || !path.includes('lease-guard.tmp-')) return
      fault.onMkdir = undefined
      rmdirSync(queue())
      rmdirSync(dirname(queue()))
      throw errno('EINVAL', 'invalid argument', path)
    }

    expect(heartbeatLease({ knowledgeRoot, leaseId })).toMatchObject({ kind: 'heartbeated' })
    expect(existsSync(join(knowledgeRoot, 'memory'))).toBe(false)
  })

  it('claims the guard and beats when the parent mkdir meets an ancestor removed between its steps', () => {
    fault.onMkdir = (path, recursive) => {
      if (!recursive || path !== queue()) return
      fault.onMkdir = undefined
      throw errno('ENOENT', 'no such file or directory', path)
    }

    expect(heartbeatLease({ knowledgeRoot, leaseId })).toMatchObject({ kind: 'heartbeated' })
    expect(existsSync(join(knowledgeRoot, 'memory'))).toBe(false)
  })

  it('removes the ancestors it recreates after another section removed the ones it found', () => {
    mkdirSync(queue(), { recursive: true })
    fault.onMkdir = (path, recursive) => {
      if (recursive || !path.includes('lease-guard.tmp-')) return
      fault.onMkdir = undefined
      rmdirSync(queue())
      rmdirSync(dirname(queue()))
      throw errno('EINVAL', 'invalid argument', path)
    }

    expect(heartbeatLease({ knowledgeRoot, leaseId })).toMatchObject({ kind: 'heartbeated' })
    expect(existsSync(join(knowledgeRoot, 'memory'))).toBe(false)
  })

  it('pauses before it retries a raced staging mkdir', () => {
    const events: string[] = []
    let raced = false
    fault.onMkdir = (path, recursive) => {
      if (recursive || !path.includes('lease-guard.tmp-')) return
      events.push('stage')
      if (raced) return
      raced = true
      rmdirSync(queue())
      rmdirSync(dirname(queue()))
      throw errno('EINVAL', 'invalid argument', path)
    }
    const wait = vi.spyOn(Atomics, 'wait').mockImplementation(() => {
      events.push('wait')
      return 'timed-out'
    })

    try {
      expect(heartbeatLease({ knowledgeRoot, leaseId })).toMatchObject({ kind: 'heartbeated' })
    } finally {
      wait.mockRestore()
    }
    expect(events).toEqual(['stage', 'wait', 'stage'])
  })

  it('throws an EINVAL from the staging mkdir while its parent still stands', () => {
    fault.onMkdir = (path, recursive) => {
      if (recursive || !path.includes('lease-guard.tmp-')) return
      throw errno('EINVAL', 'invalid argument', path)
    }

    expect(() => heartbeatLease({ knowledgeRoot, leaseId })).toThrow(
      expect.objectContaining({ code: 'EINVAL', syscall: 'mkdir' }),
    )
  })
})
