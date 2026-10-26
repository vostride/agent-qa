import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { extractRunCassettes } from '@vostride/agent-qa-eval'
import { asRunId, slugBranch } from '@vostride/agent-qa-schema'
import { afterEach, describe, expect, it, vi } from 'vitest'

import * as evalLocal from '../index.js'
import { makeLocalV2Handoff } from './fixtures/local-handoff-fixture.js'
import {
  actionGenerateResult,
  capturingStub,
  memArtifacts,
  noneAuth,
  stubProfile,
} from './fixtures/replay-fixtures.js'

const tempRoots: string[] = []

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'replay-sweep-'))
  tempRoots.push(root)
  return root
}

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(tempRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

function writeLeaves(root: string, count = 2): string[] {
  const store = new evalLocal.FsCassetteStore({ root })
  return Array.from({ length: count }, (_, index) => {
    const handoff = makeLocalV2Handoff({ runId: asRunId(`replay-sweep-${index}`) })
    const extracted = extractRunCassettes({ handoff, artifacts: memArtifacts() }).cassettes.find(
      entry => entry.cassette.granularity === 'leaf',
    )
    if (extracted === undefined) throw new Error('expected a fixture leaf')
    store.write(extracted)
    return extracted.cassette.id
  })
}

const cassettesUnder = (root: string) => join(root, evalLocal.DEFAULT_EVAL_CASSETTES_SUBDIR)
const replaysUnder = (root: string) => join(root, evalLocal.DEFAULT_EVAL_REPLAYS_SUBDIR)

function stores(root: string) {
  return {
    recordStore: new evalLocal.FsReplayRecordStore({ root }),
    scoreStore: new evalLocal.FsScoreStore({ root }),
  }
}

describe('loadCassetteBundles', () => {
  it('counts every bundle and folds load refusals without dropping healthy leaves', async () => {
    expect(evalLocal.loadCassetteBundles).toBeTypeOf('function')
    const root = await tempRoot()
    const ids = writeLeaves(root)
    const corrupt = join(cassettesUnder(root), 'corrupt')
    mkdirSync(corrupt)
    writeFileSync(join(corrupt, 'cassette.json'), '{invalid')

    const result = evalLocal.loadCassetteBundles(cassettesUnder(root))

    expect(result.swept).toBe(3)
    expect(result.loaded.map(entry => entry.cassette.id)).toEqual(ids)
    expect(result.loadRefusals).toEqual({ 'parse-failed': 1 })
  })

  it('returns an empty sweep for an absent root', async () => {
    expect(evalLocal.loadCassetteBundles).toBeTypeOf('function')
    expect(evalLocal.loadCassetteBundles(join(await tempRoot(), 'absent'))).toEqual({
      swept: 0,
      loaded: [],
      loadRefusals: {},
    })
  })
})

describe('sweepCassetteReplays', () => {
  it('persists both leaves and their scores under the replays root in the selected order', async () => {
    expect(evalLocal.sweepCassetteReplays).toBeTypeOf('function')
    const root = await tempRoot()
    const ids = writeLeaves(root).reverse()
    const selected = evalLocal.loadCassetteBundles(cassettesUnder(root)).loaded.reverse()
    const replaysRoot = replaysUnder(root)
    const stub = capturingStub(() => actionGenerateResult())
    const progress: string[] = []
    const mask = vi.fn((text: string) => text)

    const result = await evalLocal.sweepCassetteReplays({
      selected,
      profile: stubProfile(),
      auth: noneAuth,
      modelOverrides: { languageModels: stub.languageModels },
      k: 1,
      seed: 17,
      mask,
      ...stores(root),
      replaysRoot,
      onProgress: id => progress.push(id),
    })

    expect(result).toEqual({
      replayed: 2,
      replayRefusals: {},
      replayedDirs: ids.map(id => join(replaysRoot, ...id.split('/').map(slugBranch))),
      recordedDirs: ids.map(id => join(replaysRoot, ...id.split('/').map(slugBranch))),
      notices: [],
    })
    expect(progress).toEqual(ids)
    expect(stub.captured).toHaveLength(2)
    expect(stub.captured.every(call => call.seed === 17)).toBe(true)
    expect(mask).toHaveBeenCalled()
    for (const dir of result.replayedDirs) {
      expect(evalLocal.loadReplayRecord(dir).kind).toBe('loaded')
      expect(evalLocal.loadScoreRecord(dir).kind).toBe('loaded')
    }
  })

  it('counts a second-cassette harness error and still replays the following cassette', async () => {
    expect(evalLocal.sweepCassetteReplays).toBeTypeOf('function')
    const root = await tempRoot()
    const ids = writeLeaves(root, 3)
    const replaysRoot = replaysUnder(root)
    const persistence = stores(root)
    const save = persistence.recordStore.save.bind(persistence.recordStore)
    // Provider errors become planner samples inside the engine. A store failure exercises the
    // outer harness-error boundary while retaining real replay/model/safety execution.
    vi.spyOn(persistence.recordStore, 'save').mockImplementation(outcome => {
      if (outcome.cassetteId === ids[1]) throw new Error('record write failed')
      return save(outcome)
    })
    const stub = capturingStub(() => actionGenerateResult())

    const result = await evalLocal.sweepCassetteReplays({
      selected: evalLocal.loadCassetteBundles(cassettesUnder(root)).loaded,
      profile: stubProfile(),
      auth: noneAuth,
      modelOverrides: { languageModels: stub.languageModels },
      mask: (text: string) => text,
      ...persistence,
      replaysRoot,
    })

    expect(result.replayed).toBe(2)
    expect(result.replayRefusals).toEqual({ 'harness-error': 1 })
    expect(result.notices).toEqual([`harness error replaying ${ids[1]}: record write failed`])
    expect(result.replayedDirs.map(dir => evalLocal.loadReplayRecord(dir))).toEqual(
      [ids[0], ids[2]].map(cassetteId => ({
        kind: 'loaded',
        outcome: expect.objectContaining({ cassetteId }),
      })),
    )
    expect(stub.captured).toHaveLength(3)
  })

  it('preserves first-sweep records and scores through a second sweep with distinct roots (isolation)', async () => {
    expect(evalLocal.sweepCassetteReplays).toBeTypeOf('function')
    const root = await tempRoot()
    writeLeaves(root)
    const selected = evalLocal.loadCassetteBundles(cassettesUnder(root)).loaded
    const stub = capturingStub(() => actionGenerateResult())
    const input = {
      selected,
      profile: stubProfile(),
      auth: noneAuth,
      modelOverrides: { languageModels: stub.languageModels },
      mask: (text: string) => text,
    }
    const first = await evalLocal.sweepCassetteReplays({
      ...input,
      ...stores(join(root, 'repeat-a')),
      replaysRoot: replaysUnder(join(root, 'repeat-a')),
    })
    expect(first.replayed).toBe(2)
    const files = first.replayedDirs.flatMap(dir =>
      [evalLocal.REPLAY_RECORD_FILE, evalLocal.SCORE_FILE].map(name => join(dir, name)),
    )
    const before = files.map(file => readFileSync(file, 'utf8'))
    const secondRoot = replaysUnder(join(root, 'repeat-b'))

    const second = await evalLocal.sweepCassetteReplays({
      ...input,
      ...stores(join(root, 'repeat-b')),
      replaysRoot: secondRoot,
    })

    expect(second.replayed).toBe(2)
    expect(second.replayedDirs.every(dir => dir.startsWith(`${secondRoot}/`))).toBe(true)
    expect(second.replayedDirs.every(dir => existsSync(join(dir, 'replay.json')))).toBe(true)
    expect(files.map(file => readFileSync(file, 'utf8'))).toEqual(before)
    expect(stub.captured).toHaveLength(4)
  })
})
