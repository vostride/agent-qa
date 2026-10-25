// The post-run chain's identity, pinned where it is derived.
//
// Two claims about identity: the derivation hands back exactly the analyzeRun and curateMemory
// keys, and the terminal list is not a second opinion about membership — it IS the kind set the
// derivation asks the id source for, so a chain that grows an id without extending the list, or
// extends the list without deriving the id, reds here by name rather than reporting a terminal
// one job early.

import { asJobId, CURRENT_RUN_NOTIFICATION_SCHEMA_VERSION, RECORD_CHANGE_SCHEMA_VERSION, CURATION_SNAPSHOT_SCHEMA_VERSION } from '@vostride/agent-qa-schema'
import type { CurationSnapshot, Job, JobKind } from '@vostride/agent-qa-schema'
import { describe, expect, it } from 'vitest'

import {
  buildChainTerminalNotification,
  chainJobIdsForRun,
  POST_RUN_CHAIN_TERMINAL_KINDS,
  UNKNOWN_VERDICTS_MARKER,
} from '../chain-identity.js'
import type { JobIdSource } from '../engine.js'
import { createRealJobKindRegistry } from '../kinds.js'
import type { JobHandlerContext } from '../kind-registry.js'

const RUN_ID = 'run-1'

/**
 * An id source that records what it was asked for.
 *
 * The derivation calls `jobIdFor` exactly once per id, so the recorded kinds ARE the kind set
 * the chain addresses — read off the CALL rather than off the returned object's keys, because
 * the equivalence below has to compare the derivation against a hand-authored list and a key
 * set could agree with itself.
 */
function recordingIdSource(): {
  asked: { kind: JobKind; key: string }[]
  idSource: JobIdSource
} {
  const asked: { kind: JobKind; key: string }[] = []
  return {
    asked,
    idSource: {
      jobIdFor: (kind, key) => {
        asked.push({ kind, key })
        return asJobId(`${kind}:${key}`)
      },
    },
  }
}

describe('the post-run chain ids', () => {
  it('derives the chain ids keyed analyzeRun and curateMemory', () => {
    const { idSource } = recordingIdSource()

    expect(Object.keys(chainJobIdsForRun(RUN_ID, idSource)).sort()).toEqual([
      'analyzeRun',
      'curateMemory',
    ])
  })

  it('lets every derived chain kind land the terminal — the terminal list equals the derived kind set', () => {
    const { asked, idSource } = recordingIdSource()
    chainJobIdsForRun(RUN_ID, idSource)

    expect([...POST_RUN_CHAIN_TERMINAL_KINDS]).toEqual(['analyze-run', 'curate-memory'])
    expect(asked.map((call) => call.kind).sort()).toEqual([...POST_RUN_CHAIN_TERMINAL_KINDS].sort())
  })

  it('derives distinct ids, the successor key built from its predecessor id', () => {
    const { asked, idSource } = recordingIdSource()
    const ids = chainJobIdsForRun(RUN_ID, idSource)

    // The curate-memory id is not an independent hash of the run, it is addressed FROM the
    // analysis id. A successor key that forgot its predecessor would address a row the engine's
    // own `successorsOf` never mints.
    expect(ids.analyzeRun).not.toBe(ids.curateMemory)
    expect(asked.map((call) => call.key)).toEqual([
      RUN_ID,
      `${String(ids.analyzeRun)}->curate-memory`,
    ])
  })
})

describe('the chain terminal notification', () => {
  it('reads the counts curate-memory published when it lands the terminal', () => {
    const record = buildChainTerminalNotification({
      runId: RUN_ID,
      finishingKind: 'curate-memory',
      finished: 'done',
      payload: { runId: RUN_ID, verdictSummary: { total: 2, byClass: { timeout: 1, unknown: 1 } } },
      publishedValues: new Map([
        ['bundle-committed', { runId: RUN_ID, curated: 4, deprecated: 2 }],
      ]),
    })

    expect(record.schemaVersion).toBe(CURRENT_RUN_NOTIFICATION_SCHEMA_VERSION)
    expect(record.outcome).toBe('done')
    expect(record.verdictSummary).toEqual({ total: 2, byClass: { timeout: 1, unknown: 1 } })
    // Whole-record equality on the stages rather than field spot-checks: a builder that kept the
    // status and dropped the counts would satisfy any per-field check written afterwards.
    expect(record.stages).toEqual({
      analysis: { status: 'done' },
      curation: { status: 'done', curated: 4, deprecated: 2 },
    })
  })

  it('reports a dead analysis from the curate-memory job the fallback reached', () => {
    const record = buildChainTerminalNotification({
      runId: RUN_ID,
      finishingKind: 'curate-memory',
      finished: 'done',
      payload: { runId: RUN_ID, verdicts: UNKNOWN_VERDICTS_MARKER },
      publishedValues: new Map([
        ['bundle-committed', { runId: RUN_ID, curated: 0, deprecated: 0 }],
      ]),
    })

    // The chain proceeded with no verdicts and the record says so, even though the job that
    // reported the terminal is the one that succeeded afterwards.
    expect(record.stages.analysis).toEqual({ status: 'failed' })
    expect(record.verdictSummary).toEqual({ total: 0, byClass: {} })
    expect(record.outcome).toBe('failed')
  })

  it('records a failed fold as a failed curation stage', () => {
    const halted = buildChainTerminalNotification({
      runId: RUN_ID,
      finishingKind: 'curate-memory',
      finished: 'failed',
      payload: { runId: RUN_ID, verdictSummary: { total: 1, byClass: { flake: 1 } } },
      publishedValues: new Map([['candidates-authored', { runId: RUN_ID }]]),
    })

    expect(Object.keys(halted.stages).sort()).toEqual(['analysis', 'curation'])
    expect(halted.stages.curation).toEqual({ status: 'failed' })
    expect(halted.outcome).toBe('failed')
  })
})

// Historical identities and deliberately unrelated legacy counts are authored independently of
// the fold. Two events for one row must remain two events and one unit.
function committedSnapshot(): CurationSnapshot {
  return { schemaVersion: CURATION_SNAPSHOT_SCHEMA_VERSION, rows: [{ recordId: 'record-fixed', bucket: 'confirmed', changes: [
    { bucket: 'confirmed', change: { schemaVersion: RECORD_CHANGE_SCHEMA_VERSION, recordId: 'record-fixed', change: 'confirmed',
      atOrdinal: 7, evidenceToken: 'synthetic-first' } },
    { bucket: 'confirmed', change: { schemaVersion: RECORD_CHANGE_SCHEMA_VERSION, recordId: 'record-fixed', change: 'confirmed',
      atOrdinal: 8, evidenceToken: 'synthetic-second' } },
  ] }], breakdown: { added: 0, confirmed: 1, superseded: 0, deprecated: 0, proposed: 0 } }
}

async function completedFold(snapshot: CurationSnapshot | undefined) {
  const published = new Map<string, unknown>()
  const counts = { curated: 17, deprecated: 9, complete: true,
    ...(snapshot === undefined ? {} : { snapshot }) }
  const context: JobHandlerContext = {
    job: { id: asJobId('synthetic-curation-job') } as Job,
    payload: { runId: RUN_ID, verdictSummary: { total: 0, byClass: {} } },
    publishCheckpoint: async (id, value) => { published.set(id, structuredClone(value)) },
    recordLlmAuthorship: async () => { throw new Error('curation must not invoke a model') },
  }
  const result = await createRealJobKindRegistry({
    loadCompletedRunHandoff: () => { throw new Error('must not re-read run') },
    curateRun: async () => counts,
    persistAnalysis: () => { throw new Error('must not re-analyze') },
  }).require('curate-memory').handler(context)
  expect(result).toEqual({ status: 'complete', next: [] })
  expect([...published.keys()]).toEqual(['candidates-authored', 'bundle-committed'])
  return { published }
}

describe('the notification copies the committed curation snapshot', () => {
  it('copies the exact checkpoint snapshot from the real curate-memory handler', async () => {
    const source = committedSnapshot()
    const before = JSON.stringify(source)
    const { published } = await completedFold(source)
    const checkpoint = published.get('bundle-committed')
    expect(checkpoint).toHaveProperty('curationSnapshot', source)
    const record = buildChainTerminalNotification({ runId: RUN_ID,
      finishingKind: 'curate-memory', finished: 'done', payload: {}, publishedValues: published })
    // Simulate later knowledge changes. The notification may not reconstruct membership or
    // counts from this current object.
    source.rows[0]!.changes[0]!.change.atOrdinal = 999
    source.breakdown.confirmed = 99
    expect(record.stages.curation).toHaveProperty('curationSnapshot', JSON.parse(before))
    expect(JSON.stringify(Reflect.get(record.stages.curation, 'curationSnapshot'))).toBe(before)
    expect(record.stages.curation.curated).toBe(17)
    expect(record.stages.curation.deprecated).toBe(9)
    expect(record.outcome).toBe('done')
  })

  it('direct completed curation detaches the authoritative snapshot', () => {
    const snapshot = committedSnapshot()
    const before = JSON.stringify(snapshot)
    const record = buildChainTerminalNotification({ runId: RUN_ID,
      finishingKind: 'curate-memory', finished: 'done', payload: {},
      publishedValues: new Map([['bundle-committed', { runId: RUN_ID, curationSnapshot: snapshot }]]) })
    expect(record.stages.curation).toHaveProperty('curationSnapshot', snapshot)
    snapshot.rows[0]!.changes[0]!.change.atOrdinal = 999
    expect(JSON.stringify(Reflect.get(record.stages.curation, 'curationSnapshot'))).toBe(before)
    expect(Object.keys(record.stages).sort()).toEqual(['analysis', 'curation'])
  })

  it('complete and failed partial curation never invent a snapshot', async () => {
    const { published } = await completedFold(undefined)
    expect(published.get('bundle-committed')).not.toHaveProperty('curationSnapshot')
    const record = buildChainTerminalNotification({ runId: RUN_ID,
      finishingKind: 'curate-memory', finished: 'done', payload: {}, publishedValues: published })
    expect(record.stages.curation).toEqual({ status: 'done', curated: 17, deprecated: 9 })
    const failed = buildChainTerminalNotification({ runId: RUN_ID,
      finishingKind: 'curate-memory', finished: 'failed', payload: {}, publishedValues: new Map() })
    expect(failed.stages.curation).toEqual({ status: 'failed' })
  })

  it('a present invalid snapshot fails generically rather than disappearing', () => {
    const bad = { ...committedSnapshot(), syntheticSecretKey: true }
    let thrown: unknown
    try {
      buildChainTerminalNotification({ runId: RUN_ID,
        finishingKind: 'curate-memory', finished: 'done', payload: {},
        publishedValues: new Map([['bundle-committed', { curationSnapshot: bad }]]) })
    } catch (error) {
      thrown = error
    }
    expect(String(thrown)).toMatch(/curation snapshot/)
    expect(String(thrown)).not.toContain('syntheticSecretKey')
  })
})
