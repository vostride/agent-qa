// 2026-10-17 (443-15, GAP-D5): a failed open stays refused, and a runs.db reached through a symlink is the host's file.

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { DashboardDatabase } from '@vostride/agent-qa-dashboard'
import { generateRunId } from '@vostride/agent-qa-ids'

import { RunRecordUnavailableError, createRunRecord, doorRunAttributes } from '../../commands/run.js'
import type { RunRecordHostBinding } from '../../commands/run.js'
import { composeRunOwnership } from '../run-owner-probe.js'

const roots: string[] = []
const closers: Array<() => void> = []

afterEach(() => {
  for (const close of closers.splice(0).reverse()) close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function tempRoot(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'agent-qa-443-record-open-')))
  roots.push(root)
  return root
}

function record(host?: RunRecordHostBinding) {
  const created = createRunRecord({
    attributes: doorRunAttributes('cli'),
    ...(host === undefined ? {} : { host }),
    warn: () => {},
  })
  closers.push(() => created.close())
  return created
}

const sha256 = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex')

describe('C443-RECORD-OPEN', () => {
  it('a record whose open failed refuses the same run again', async () => {
    const configDir = tempRoot()
    const path = join(configDir, '.agent-qa', 'runs.db')
    mkdirSync(join(configDir, '.agent-qa'), { recursive: true })
    writeFileSync(path, 'not a database')
    const before = sha256(path)
    const runId = generateRunId()
    const subject = record()

    await expect(subject.open({ runId, configDir }), 'the first open').rejects.toBeInstanceOf(
      RunRecordUnavailableError,
    )
    expect(subject.db, 'a handle after the first open').toBeUndefined()

    await expect(subject.open({ runId, configDir }), 'the second open').rejects.toBeInstanceOf(
      RunRecordUnavailableError,
    )
    expect(subject.db, 'a handle after the second open').toBeUndefined()
    expect(sha256(path), 'the corrupt file changed').toBe(before)
  })

  it("a record shares the host's handle when the two paths name one file through a symlink", async () => {
    if (process.platform === 'win32') throw new Error('POSIX run lifecycle required; never skip')
    const root = tempRoot()
    const real = join(root, 'project')
    const link = join(root, 'project-link')
    mkdirSync(real, { recursive: true })
    symlinkSync(real, link, 'dir')
    const hostDb = new DashboardDatabase({
      dbPath: join(link, '.agent-qa', 'runs.db'),
      runOwnership: composeRunOwnership(),
    })
    closers.push(() => hostDb.close())
    const subject = record({ db: hostDb, queueRun: () => undefined })

    await subject.open({ runId: generateRunId(), configDir: real })

    expect(subject.db, 'the record opened a second handle on the host file').toBe(hostDb)
    subject.close()
    expect(hostDb.getRuns(), 'the host handle after the record closed').toEqual([])
  })

  // 2026-10-17 (443-review, IN-07): SQLite removes the -wal file only when the file's last handle closes.
  it('two concurrent opens of one record share one handle', async () => {
    const configDir = tempRoot()
    const wal = join(configDir, '.agent-qa', 'runs.db-wal')
    const runId = generateRunId()
    const subject = record()

    const seen = await Promise.all([
      subject.open({ runId, configDir }).then(() => subject.db),
      subject.open({ runId, configDir }).then(() => subject.db),
    ])

    expect(seen[0], 'the first open saw no handle').toBeInstanceOf(DashboardDatabase)
    expect(seen[1], 'the two opens saw different handles').toBe(seen[0])
    expect(existsSync(wal), 'no handle open before close').toBe(true)
    subject.close()
    expect(existsSync(wal), 'a second handle stayed open after the record closed').toBe(false)

    const first = generateRunId()
    const second = generateRunId()
    const other = record()
    const [bound, rebound] = await Promise.allSettled([
      other.open({ runId: first, configDir }),
      other.open({ runId: second, configDir }),
    ])

    expect(bound.status, 'the first open').toBe('fulfilled')
    expect(rebound.status, 'the open for another run').toBe('rejected')
    expect((rebound as PromiseRejectedResult).reason, 'the open for another run').toBeInstanceOf(Error)
    expect(((rebound as PromiseRejectedResult).reason as Error).message).toBe(
      `This run record belongs to ${first} and cannot open ${second}.`,
    )
    await expect(other.open({ runId: first, configDir }), 'the record after the refusal').resolves.toBeUndefined()
  })
})
