import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { tmpdir } from 'node:os'

import type { CassetteScore, JudgeIdentityBlock, LeafReplayResult } from '@vostride/agent-qa-eval'
import { slugBranch } from '@vostride/agent-qa-schema'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  DEFAULT_EVAL_REPLAYS_SUBDIR,
  FsReplayRecordStore,
  REPLAY_RECORD_FILE,
} from '../replay-record-store.js'
import { FsScoreStore, SCORE_FILE } from '../score-store.js'
import type { ScoreRecord } from '../score-store.js'

const CASSETTE_ID = 'run / eval-local::standalone/leaf'

function leafOutcome(overrides: Partial<LeafReplayResult> = {}): LeafReplayResult {
  return {
    granularity: 'leaf',
    briefSource: 'empty',
    cassetteId: CASSETTE_ID,
    samples: [],
    agreement: { k: 0, agreementRate: 0, noConsensus: true, harnessErrorCount: 0 },
    promptDrift: { drift: false, harnessDrift: false, recordedHash: 'a'.repeat(64), recomputedHash: 'a'.repeat(64) },
    replayedModel: { provider: 'null', modelId: 'null-adapter' },
    unconsumedExchanges: [],
    totalDurationMs: 0,
    ...overrides,
  }
}

function leafScore(cassetteId: string, reason = 'no-decision-sample'): CassetteScore {
  return {
    kind: 'leaf',
    cassetteId,
    entry: {
      kind: 'decision',
      decisionOrdinal: 0,
      score: { kind: 'miss-by-failure', reason, matcherVersion: 1 },
    },
  }
}

function scoreRecord(cassetteId = CASSETTE_ID, reason?: string): ScoreRecord {
  return {
    cassetteId,
    matcherVersion: 1,
    score: leafScore(cassetteId, reason),
    diffs: [],
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

describe('FsScoreStore (D-13, Pitfall 5)', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'eval-local-scores-'))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('writes score.json into the SAME slugged dir the record store uses for the cassette', async () => {
    const written = new FsReplayRecordStore({ root }).save(leafOutcome())
    const scored = new FsScoreStore({ root }).save(scoreRecord())

    expect(scored.dir).toBe(written.dir)
    expect(scored.dir).toBe(expectedDir(root, CASSETTE_ID))
    expect(scored.file).toBe(join(written.dir, SCORE_FILE))
    expect(await exists(join(written.dir, REPLAY_RECORD_FILE))).toBe(true)
    expect(await exists(join(written.dir, SCORE_FILE))).toBe(true)
  })

  it('survives the OQ-2 re-run sequence: record → score → record (dir wipe) → score', async () => {
    const recordStore = new FsReplayRecordStore({ root })
    const scoreStore = new FsScoreStore({ root })

    recordStore.save(leafOutcome({ totalDurationMs: 1 }))
    scoreStore.save(scoreRecord(CASSETTE_ID, 'first-run'))

    // The re-run: the record store recreates the dir (rm + mkdir), wiping the first score.
    const rerun = recordStore.save(leafOutcome({ totalDurationMs: 2 }))
    const rescored = scoreStore.save(scoreRecord(CASSETTE_ID, 'second-run'))

    expect(rescored.dir).toBe(rerun.dir)
    const replayRaw = await readFile(join(rerun.dir, REPLAY_RECORD_FILE), 'utf8')
    expect((JSON.parse(replayRaw) as LeafReplayResult).totalDurationMs).toBe(2)
    const scoreRaw = await readFile(join(rerun.dir, SCORE_FILE), 'utf8')
    const persisted = JSON.parse(scoreRaw) as ScoreRecord
    expect(persisted.score.kind).toBe('leaf')
    expect(JSON.stringify(persisted)).toContain('second-run')
  })

  it('overwrites file-scoped and idempotent: byte-identical re-save, replay.json untouched', async () => {
    const recordWritten = new FsReplayRecordStore({ root }).save(leafOutcome())
    const replayBytesBefore = await readFile(join(recordWritten.dir, REPLAY_RECORD_FILE), 'utf8')

    const store = new FsScoreStore({ root })
    const record = scoreRecord()
    const first = store.save(record)
    const firstBytes = await readFile(first.file, 'utf8')

    const second = store.save(record)
    const secondBytes = await readFile(second.file, 'utf8')

    expect(second.file).toBe(first.file)
    expect(secondBytes).toBe(firstBytes)
    expect(firstBytes).toBe(`${JSON.stringify(record, null, 2)}\n`)
    expect(firstBytes.endsWith('\n')).toBe(true)

    // File-scoped write: the sibling replay record is never deleted or truncated.
    const replayBytesAfter = await readFile(join(recordWritten.dir, REPLAY_RECORD_FILE), 'utf8')
    expect(replayBytesAfter).toBe(replayBytesBefore)
  })

  it('contains hostile cassette-id segments inside the output root via slugBranch', async () => {
    const hostileId = '../../escape/..\\evil/.hidden'
    const written = new FsScoreStore({ root }).save(scoreRecord(hostileId))

    const outputRoot = join(root, DEFAULT_EVAL_REPLAYS_SUBDIR)
    expect(relative(outputRoot, written.dir).startsWith('..')).toBe(false)
    expect(written.dir).toBe(expectedDir(root, hostileId))
    expect(await exists(written.file)).toBe(true)

    // Nothing escapes the temp root: it contains only the eval/ staging subtree.
    expect(await readdir(root)).toEqual(['eval'])
  })

  it('round-trips the D-16 judge identity block verbatim under the judge key', async () => {
    const judge: JudgeIdentityBlock = {
      judgeModelId: 'claude-judge-stub',
      judgeFamily: 'claude',
      judgeVersion: 1,
      confidenceThreshold: 'high',
    }
    const written = new FsScoreStore({ root }).save({ ...scoreRecord(), judge })

    const persisted = JSON.parse(await readFile(written.file, 'utf8')) as ScoreRecord
    expect(persisted.judge).toEqual(judge)
  })

  it('persists no judge key when the record carries no judge block (369 byte-compatible)', async () => {
    const written = new FsScoreStore({ root }).save(scoreRecord())

    const raw = await readFile(written.file, 'utf8')
    const persisted = JSON.parse(raw) as Record<string, unknown>
    expect('judge' in persisted).toBe(false)
    expect(raw).not.toContain('"judge"')
  })

  it('writes score.json under the replays subdir of the runtime root', async () => {
    expect(SCORE_FILE).toBe('score.json')

    const written = new FsScoreStore({ root }).save(scoreRecord())

    const expected = join(root, DEFAULT_EVAL_REPLAYS_SUBDIR, ...CASSETTE_ID.split('/').map(s => slugBranch(s)))
    expect(written.dir).toBe(expected)
    expect(written.file).toBe(join(expected, SCORE_FILE))
  })
})
