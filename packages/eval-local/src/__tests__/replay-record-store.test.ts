import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import type { LeafReplayResult, ReplayRefusal, ReplayResult } from '@vostride/agent-qa-eval'
import { slugBranch } from '@vostride/agent-qa-schema'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  DEFAULT_EVAL_REPLAYS_SUBDIR,
  FsReplayRecordStore,
  REPLAY_RECORD_FILE,
} from '../replay-record-store.js'

function leafResult(overrides: Partial<LeafReplayResult> = {}): LeafReplayResult {
  return {
    granularity: 'leaf',
    briefSource: 'empty',
    cassetteId: 'run / eval-local::standalone/leaf',
    samples: [],
    agreement: { k: 0, agreementRate: 0, noConsensus: true, harnessErrorCount: 0 },
    promptDrift: { drift: false, harnessDrift: false, recordedHash: 'a'.repeat(64), recomputedHash: 'a'.repeat(64) },
    replayedModel: { provider: 'null', modelId: 'null-adapter' },
    unconsumedExchanges: [],
    totalDurationMs: 0,
    ...overrides,
  }
}

function refusal(): ReplayRefusal {
  return {
    kind: 'integrity-refusal',
    cassetteId: 'run / eval-local::standalone/broken',
    reason: 'guard-failed',
    detail: 'Cassette structural validation failed',
  }
}

function expectedDir(root: string, cassetteId: string): string {
  return join(
    root,
    DEFAULT_EVAL_REPLAYS_SUBDIR,
    ...cassetteId.split('/').map(segment => slugBranch(segment)),
  )
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

describe('FsReplayRecordStore', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'eval-local-replays-'))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('persists a leaf result under slugged id segments as pretty replay.json', async () => {
    const outcome = leafResult()
    const written = new FsReplayRecordStore({ root }).save(outcome)

    const dir = expectedDir(root, outcome.cassetteId)
    expect(written.dir).toBe(dir)
    expect(written.file).toBe(join(dir, REPLAY_RECORD_FILE))

    const raw = await readFile(join(dir, REPLAY_RECORD_FILE), 'utf8')
    expect(raw).toBe(`${JSON.stringify(outcome, null, 2)}\n`)
    expect(JSON.parse(raw)).toEqual(outcome)
  })

  it('overwrites idempotently — recreates the dir, no stale file survives, second content wins', async () => {
    const store = new FsReplayRecordStore({ root })
    const first = store.save(leafResult({ totalDurationMs: 1 }))
    await writeFile(join(first.dir, 'stale.txt'), 'must not survive', 'utf8')

    const second = store.save(leafResult({ totalDurationMs: 2 }))

    expect(second.dir).toBe(first.dir)
    expect(await exists(join(second.dir, 'stale.txt'))).toBe(false)
    const raw = await readFile(join(second.dir, REPLAY_RECORD_FILE), 'utf8')
    expect((JSON.parse(raw) as ReplayResult).totalDurationMs).toBe(2)
  })

  it('persists a refusal as a record too — refusals are never silent', async () => {
    const outcome = refusal()
    const written = new FsReplayRecordStore({ root }).save(outcome)

    expect(written.dir).toBe(expectedDir(root, outcome.cassetteId))
    const raw = await readFile(written.file, 'utf8')
    expect(JSON.parse(raw)).toEqual(outcome)
  })

  it('writes replay.json under root/eval/replays', async () => {
    expect(DEFAULT_EVAL_REPLAYS_SUBDIR).toBe('eval/replays')
    expect(REPLAY_RECORD_FILE).toBe('replay.json')

    const outcome = leafResult()
    const written = new FsReplayRecordStore({ root }).save(outcome)

    expect(written.file).toBe(join(expectedDir(root, outcome.cassetteId), REPLAY_RECORD_FILE))
  })
})
