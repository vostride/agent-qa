import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { materializePolicy, PolicyTextRefusedError, policyShelfPath } from '../materialize.js'
import { acquireWriterLease, releaseLease, WriterAuthorityLostError } from '../../lease/writer-lease.js'

// 441-41: the stage open is the seam inside the transaction now that no audit sink is called.
const stageHook = vi.hoisted(() => ({ beforeStage: undefined as (() => void) | undefined }))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  const openSync = ((...args: Parameters<typeof actual.openSync>) => {
    if (String(args[0]).endsWith('.pending')) stageHook.beforeStage?.()
    return actual.openSync(...args)
  }) as typeof actual.openSync
  return { ...actual, openSync, default: { ...actual, openSync } }
})

describe('materializePolicy sovereign authored shelf', () => {
  let root: string
  let writerAuthority: { leaseId: string; epoch: number }
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'policy-materialize-'))
    const lease = acquireWriterLease(root)
    if (lease.kind !== 'acquired') throw new Error('lease unavailable')
    writerAuthority = lease
  })
  afterEach(() => {
    stageHook.beforeStage = undefined
    rmSync(root, { recursive: true, force: true })
  })
  function input(ruleText = 'Dismiss the cookie banner first') {
    return { knowledgeRoot: root, recordId: 'policy-fixture', scope: 'shop', ruleText,
      writerAuthority }
  }
  it.each([
    '<!-- agent-qa:policy policy-fixture -->\nunfinished',
    '<!-- /agent-qa:policy policy-fixture -->',
    '<!-- agent-qa:policy policy-fixture -->\n<!-- /agent-qa:policy other -->',
    '<!-- agent-qa:policy policy-fixture -->\n<!-- /agent-qa:policy policy-fixture -->\n<!-- agent-qa:policy policy-fixture -->\n<!-- /agent-qa:policy policy-fixture -->',
  ])('refuses incomplete or ambiguous sections without changing human bytes: %s', text => {
    mkdirSync(join(root, 'policies'))
    writeFileSync(policyShelfPath(root, 'shop'), text)
    expect(() => materializePolicy(input())).toThrow(PolicyTextRefusedError)
    expect(readFileSync(policyShelfPath(root, 'shop'), 'utf8')).toBe(text)
  })
  it.each(['stale', 'released'])('refuses %s authority before creating or changing shelf bytes', state => {
    if (state === 'released') releaseLease({ knowledgeRoot: root, leaseId: writerAuthority.leaseId })
    else writerAuthority = { ...writerAuthority, epoch: writerAuthority.epoch + 1 }
    expect(() => materializePolicy(input())).toThrow(WriterAuthorityLostError)
    expect(existsSync(join(root, 'policies'))).toBe(false)
    mkdirSync(join(root, 'policies'))
    writeFileSync(policyShelfPath(root, 'shop'), 'Human text\r\n')
    expect(() => materializePolicy(input())).toThrow(WriterAuthorityLostError)
    expect(readFileSync(policyShelfPath(root, 'shop'), 'utf8')).toBe('Human text\r\n')
  })
  it('holds the current authority transaction throughout the actual read/check/write', () => {
    // The contender is started and imported before the transaction, so the bound inside it covers
    // only the busy wait and never a cold process start.
    const barrier = mkdtempSync(join(tmpdir(), 'policy-materialize-contender-'))
    const ready = join(barrier, 'ready')
    const go = join(barrier, 'go')
    const done = join(barrier, 'done')
    const child = spawn(process.execPath, ['--input-type=module', '-e', `
      import { existsSync, renameSync, writeFileSync } from 'node:fs'
      import { releaseLease } from './dist/index.js'
      const [ready, go, done, credentials] = process.argv.slice(1)
      const report = (body) => {
        writeFileSync(done + '.tmp', JSON.stringify(body))
        renameSync(done + '.tmp', done)
      }
      writeFileSync(ready, '')
      const orphanAt = Date.now() + 30_000
      while (!existsSync(go)) {
        if (Date.now() > orphanAt) process.exit(3)
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10)
      }
      try {
        report({ outcome: releaseLease(JSON.parse(credentials)) })
      } catch (error) {
        report({ name: error.name, message: error.message })
        process.exit(1)
      }`, ready, go, done, JSON.stringify({ knowledgeRoot: root, leaseId: writerAuthority.leaseId })],
    { cwd: new URL('../../..', import.meta.url), stdio: 'ignore' })
    const abandon = (): void => {
      child.kill('SIGKILL')
      rmSync(barrier, { recursive: true, force: true })
    }
    const closed = new Promise<number | null>((settle) => { child.once('close', settle) })
    const until = (path: string, budgetMs: number, what: string): void => {
      const deadline = Date.now() + budgetMs
      while (!existsSync(path)) {
        if (Date.now() > deadline) throw new Error(`${what} not seen within ${budgetMs}ms`)
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10)
      }
    }

    let attempted = false
    let contended: { name?: string; message?: string; outcome?: unknown } | undefined
    stageHook.beforeStage = () => {
      attempted = true
      // A second process with the exact current credentials cannot release the lease
      // between the shelf read and publication: it must contend on the same transaction.
      writeFileSync(go, '')
      until(done, 5000, 'contender outcome')
      contended = JSON.parse(readFileSync(done, 'utf8'))
      expect(contended?.name, JSON.stringify(contended)).toBe('MutationLockBusyError')
    }
    try {
      until(ready, 10_000, 'contender ready')
      expect(materializePolicy(input('Contact owner@example.com')).kind).toBe('written')
    } catch (error) {
      abandon()
      throw error
    }
    expect(attempted).toBe(true)
    expect(contended?.name).toBe('MutationLockBusyError')
    expect(readFileSync(policyShelfPath(root, 'shop'), 'utf8')).toContain('Contact owner@example.com')
    expect(releaseLease({ knowledgeRoot: root, leaseId: writerAuthority.leaseId }).kind).toBe('released')
    return closed.then((status) => {
      rmSync(barrier, { recursive: true, force: true })
      expect(status).not.toBe(0)
    })
  })
  it('creates the shelf with a heading and an idempotent fenced section', () => {
    expect(materializePolicy(input()).kind).toBe('written')
    const path = policyShelfPath(root, 'shop')
    const bytes = readFileSync(path, 'utf8')
    expect(bytes).toBe('# Policies — shop\n\n<!-- agent-qa:policy policy-fixture -->\nDismiss the cookie banner first\n<!-- /agent-qa:policy policy-fixture -->\n')
    expect(materializePolicy(input()).kind).toBe('unchanged')
    expect(materializePolicy(input('Automation must never replace this body')).kind).toBe('unchanged')
    expect(readFileSync(path, 'utf8')).toBe(bytes)
  })
  it('preserves every pre-existing human byte', () => {
    mkdirSync(join(root, 'policies'))
    const human = 'Human text\r\n  preserve these spaces  '
    writeFileSync(policyShelfPath(root, 'shop'), human)
    materializePolicy(input())
    expect(readFileSync(policyShelfPath(root, 'shop'), 'utf8').startsWith(human + '\n')).toBe(true)
  })
  it.each(['<!--', '-->'])('refuses delimiter %s before a file changes', delimiter => {
    expect(() => materializePolicy(input(`A rule ${delimiter} hidden`))).toThrow(PolicyTextRefusedError)
    expect(existsSync(join(root, 'policies'))).toBe(false)
    expect(() => materializePolicy({ ...input(), title: delimiter })).toThrow(PolicyTextRefusedError)
    expect(() => materializePolicy({ ...input(), recordId: delimiter })).toThrow(PolicyTextRefusedError)
  })
})

describe('C441-COMMITTED', () => {
  let root: string
  let writerAuthority: { leaseId: string; epoch: number }
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'policy-c441-committed-'))
    const lease = acquireWriterLease(root)
    if (lease.kind !== 'acquired') throw new Error('lease unavailable')
    writerAuthority = lease
  })
  afterEach(() => { rmSync(root, { recursive: true, force: true }) })

  it('a policy file with credential-shaped text is materialized as written', () => {
    const ruleText = 'Pay with 4242 4242 4242 4242 and send Bearer abc123def456ghi789'
    const outcome = materializePolicy({ knowledgeRoot: root, recordId: 'policy-c441', scope: 'shop',
      ruleText, title: 'Card 4111 1111 1111 1111', writerAuthority })
    expect(outcome).toMatchObject({ kind: 'written', relPath: join('policies', 'shop.md') })
    expect(readFileSync(policyShelfPath(root, 'shop'), 'utf8')).toBe('# Policies — shop\n\n'
      + '<!-- agent-qa:policy policy-c441 -->\n### Card 4111 1111 1111 1111\n'
      + `${ruleText}\n<!-- /agent-qa:policy policy-c441 -->\n`)
    expect(releaseLease({ knowledgeRoot: root, leaseId: writerAuthority.leaseId }).kind).toBe('released')
  })
})
