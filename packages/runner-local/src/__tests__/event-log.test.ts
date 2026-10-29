// One JSON line per event under the run's slugged dir, complete up to the last emitted event.
import { mkdtemp, rm, readFile, appendFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { FsEventLog, RUNS_SUBDIR } from '../event-log.js'
import { slugBranch } from '../branch-resolver.js'
import type { RunEventEnvelope } from '@vostride/agent-qa-schema'

function envelope(seq: number): RunEventEnvelope {
  return {
    seq,
    ts: 1_700_000_000_000 + seq,
    runId: 'run-1',
    type: 'runWarning',
    payload: { code: `c${seq}`, message: `w${seq}` },
  }
}

describe('FsEventLog', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'fs-event-log-'))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('appends one JSON line per envelope to runs/<slug(runId)>/events.jsonl', async () => {
    const log = new FsEventLog({ root, runId: 'run-1' })
    await log.append(envelope(1))
    await log.append(envelope(2))

    const file = join(root, RUNS_SUBDIR, slugBranch('run-1'), 'events.jsonl')
    const contents = await readFile(file, 'utf8')
    const lines = contents.split('\n').filter(line => line.length > 0)
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[0])).toEqual(envelope(1))
    expect(JSON.parse(lines[1])).toEqual(envelope(2))
  })

  it('neutralizes a traversal-shaped runId via slugBranch — the file stays inside runs/', async () => {
    const evilRunId = '../../evil'
    const log = new FsEventLog({ root, runId: evilRunId })
    await log.append(envelope(1))

    const runsDir = resolve(root, RUNS_SUBDIR)
    const written = resolve(runsDir, slugBranch(evilRunId), 'events.jsonl')
    expect(written.startsWith(runsDir + sep)).toBe(true)
    expect(written).not.toContain('..')
    await expect(readFile(written, 'utf8')).resolves.toContain('c1')
  })

  it('read() returns parsed envelopes in seq order and tolerates a corrupt trailing line', async () => {
    const log = new FsEventLog({ root, runId: 'run-1' })
    await log.append(envelope(1))
    await log.append(envelope(2))

    // Simulate a torn final write (crash mid-append).
    const file = join(root, RUNS_SUBDIR, slugBranch('run-1'), 'events.jsonl')
    await appendFile(file, '{ "seq": 3, "ts": ', 'utf8')

    const read = await log.read(1)
    expect(read.map(e => e.seq)).toEqual([1, 2])
  })
})
