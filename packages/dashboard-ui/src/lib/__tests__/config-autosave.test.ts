// THE CONFIG PAGE'S SAVE STATE, PROVEN WHERE TIME IS FREE (429 D-19/D-20/D-21/D-24 · SC3).
//
// Every clock is a parameter: `reduceConfigAutosave(state, event, now)` and
// `deriveSaveStatus(state, now)`. The window cells sit on either side of a half-open boundary,
// the shape a wall clock would turn into a flake.

import { describe, expect, it } from 'vitest'

import { SAVED_VISIBLE_MS, UNDO_WINDOW_MS } from '../config-copy'
import type { SaveState } from '../config-tabs'
import {
  configFieldKey,
  createInitialConfigAutosave,
  deriveSaveStatus,
  draftFieldKeys,
  reduceConfigAutosave,
  type ConfigAutosaveEvent,
  type ConfigAutosaveState,
} from '../config-autosave'

const STEP = configFieldKey(['use', 'timeout', 'step'])
const BROWSER = configFieldKey(['use', 'browser', 'name'])

function fold(
  steps: readonly (readonly [ConfigAutosaveEvent, number])[],
  from = createInitialConfigAutosave(),
) {
  return steps.reduce<ConfigAutosaveState>(
    (state, [event, now]) => reduceConfigAutosave(state, event, now),
    from,
  )
}

type Flag = Exclude<SaveState, 'idle'>

const PRECEDENCE: readonly Flag[] = ['failed', 'undo', 'saving', 'draft', 'saved']

function stateWith(flags: ReadonlySet<Flag>, now: number): ConfigAutosaveState {
  return {
    fields: flags.has('draft')
      ? { [STEP]: { raw: '30 parsecs', fieldState: 'draft', error: 'Not a duration' } }
      : { [STEP]: { raw: '30s', fieldState: 'clean' } },
    ...(flags.has('saving') ? { write: { id: 'w1', fieldKeys: [BROWSER] } } : {}),
    ...(flags.has('failed') ? { failure: { fieldKeys: [BROWSER], issues: [] } } : {}),
    ...(flags.has('undo')
      ? { undo: { kind: 'delete-model' as const, name: 'gpt', token: 'u1', expiresAt: now + 1 } }
      : {}),
    ...(flags.has('saved') ? { savedAt: now - 1 } : {}),
  }
}

describe('the save-status precedence (429-15 Task 1)', () => {
  it('STATUS-PRECEDENCE: every combination shows the first of failed, undo, saving, draft, saved, else idle', () => {
    const now = 50_000
    const wrong: string[] = []
    for (let mask = 0; mask < 2 ** PRECEDENCE.length; mask += 1) {
      const flags = new Set(PRECEDENCE.filter((_, bit) => (mask & (1 << bit)) !== 0))
      const expected: SaveState = PRECEDENCE.find((flag) => flags.has(flag)) ?? 'idle'
      const actual = deriveSaveStatus(stateWith(flags, now), now).state
      if (actual !== expected)
        wrong.push(`{${[...flags].join(', ')}} → ${actual}, expected ${expected}`)
    }
    expect(wrong).toEqual([])
  })
})

describe('a failed write (429-15 Task 1)', () => {
  it('FAILED-WRITE-NEVER-SAVED: after write-failed the status is failed at every later now until a write succeeds', () => {
    const failed = fold([
      [{ type: 'edit', fieldKey: BROWSER, raw: 'firefox', valid: true }, 100],
      [{ type: 'write-started', id: 'w0', fieldKeys: [BROWSER] }, 100],
      [{ type: 'write-succeeded', id: 'w0' }, 900],
      [{ type: 'edit', fieldKey: STEP, raw: '30s', valid: true }, 1_000],
      [{ type: 'write-started', id: 'w1', fieldKeys: [STEP] }, 1_000],
      [
        {
          type: 'write-failed',
          id: 'w1',
          issues: [],
          message: 'The config file could not be written',
        },
        1_200,
      ],
    ])
    for (const now of [1_200, 1_201, 900 + SAVED_VISIBLE_MS - 1, 3_200, 60_000, 10_000_000]) {
      expect(deriveSaveStatus(failed, now).state, `now ${now}`).toBe('failed')
    }

    const retrying = fold(
      [
        [{ type: 'retry' }, 5_000],
        [{ type: 'write-started', id: 'w2', fieldKeys: [STEP] }, 5_000],
      ],
      failed,
    )
    expect(deriveSaveStatus(retrying, 5_050).state).toBe('failed')

    const landed = reduceConfigAutosave(retrying, { type: 'write-succeeded', id: 'w2' }, 5_100)
    expect(deriveSaveStatus(landed, 5_100).state).toBe('saved')

    // An earlier success must not resurface as Saved once the failed drafts are dropped.
    const dropped = reduceConfigAutosave(failed, { type: 'draft-cleared', fieldKey: STEP }, 1_300)
    expect(deriveSaveStatus(dropped, 1_300).state).toBe('idle')
  })

  it('FAILED-WRITE-KEEPS-DRAFT: every carried field keeps its raw value, named fields failed and the rest draft', () => {
    const edited = fold([
      [{ type: 'edit', fieldKey: STEP, raw: '30s', valid: true }, 1_000],
      [{ type: 'edit', fieldKey: BROWSER, raw: 'chromium', valid: true }, 1_000],
      [{ type: 'write-started', id: 'w1', fieldKeys: [STEP, BROWSER] }, 1_000],
    ])

    const named = reduceConfigAutosave(
      edited,
      {
        type: 'write-failed',
        id: 'w1',
        issues: [{ fieldKey: STEP, message: 'Must be at most 10m' }],
      },
      1_100,
    )
    expect(named.fields[STEP]).toEqual({
      raw: '30s',
      fieldState: 'failed',
      error: 'Must be at most 10m',
    })
    expect(named.fields[BROWSER]).toEqual({ raw: 'chromium', fieldState: 'draft' })
    expect(draftFieldKeys(named)).toEqual([STEP, BROWSER])
    expect(deriveSaveStatus(named, 1_100)).toMatchObject({
      state: 'failed',
      failingFieldKeys: [STEP],
    })

    const whole = reduceConfigAutosave(
      edited,
      { type: 'write-failed', id: 'w1', issues: [], message: 'The merged config is not valid' },
      1_100,
    )
    expect(whole.fields[STEP]).toEqual({ raw: '30s', fieldState: 'draft' })
    expect(whole.fields[BROWSER]).toEqual({ raw: 'chromium', fieldState: 'draft' })
    expect(deriveSaveStatus(whole, 1_100)).toMatchObject({ state: 'failed', failingFieldKeys: [] })
  })

  it('FOREIGN-FAILURE-KEEPS-WRITE: a failure for another id leaves the in-flight write to land', () => {
    for (const foreign of ['explicit-action', 'undo']) {
      const s = fold([
        [{ type: 'edit', fieldKey: STEP, raw: '30s', valid: true }, 1_000],
        [{ type: 'write-started', id: 'w1', fieldKeys: [STEP] }, 1_000],
        [{ type: 'write-failed', id: foreign, issues: [], message: 'auth store locked' }, 1_050],
      ])
      expect(s.write, foreign).toEqual({ id: 'w1', fieldKeys: [STEP] })
      expect(s.fields[STEP], foreign).toEqual({ raw: '30s', fieldState: 'saving' })

      const landed = reduceConfigAutosave(s, { type: 'write-succeeded', id: 'w1' }, 1_100)
      expect(landed.write, foreign).toBeUndefined()
      expect(landed.fields[STEP], foreign).toEqual({ raw: '30s', fieldState: 'clean' })
    }
  })
})

describe('a partial write (429-15 Task 1)', () => {
  it('PARTIAL-SHOWS-NOT-SAVED: a write that lands beside a remaining draft shows Not saved until the draft clears', () => {
    const landed = fold([
      [{ type: 'edit', fieldKey: BROWSER, raw: 'firefox', valid: true }, 1_000],
      [
        { type: 'edit', fieldKey: STEP, raw: '30 parsecs', valid: false, error: 'Not a duration' },
        1_000,
      ],
      [{ type: 'write-started', id: 'w1', fieldKeys: [BROWSER] }, 1_000],
      [{ type: 'write-succeeded', id: 'w1' }, 1_100],
    ])
    expect(landed.fields[BROWSER]).toEqual({ raw: 'firefox', fieldState: 'clean' })
    expect(landed.fields[STEP]).toEqual({
      raw: '30 parsecs',
      fieldState: 'draft',
      error: 'Not a duration',
    })
    for (const now of [1_100, 1_500, 1_100 + SAVED_VISIBLE_MS - 1, 1_100 + SAVED_VISIBLE_MS]) {
      expect(deriveSaveStatus(landed, now).state, `now ${now}`).toBe('draft')
    }

    const cleared = reduceConfigAutosave(landed, { type: 'draft-cleared', fieldKey: STEP }, 1_500)
    expect(deriveSaveStatus(cleared, 1_500).state).toBe('saved')
  })

  it('WRITE-SUCCEEDED-CLEANS-ONLY-CARRIED: a field edited again while its write was out stays unsaved', () => {
    const landed = fold([
      [{ type: 'edit', fieldKey: STEP, raw: '30s', valid: true }, 1_000],
      [{ type: 'write-started', id: 'w1', fieldKeys: [STEP] }, 1_000],
      [
        { type: 'edit', fieldKey: STEP, raw: '3 parsecs', valid: false, error: 'Not a duration' },
        1_050,
      ],
      [{ type: 'write-succeeded', id: 'w1' }, 1_100],
    ])
    expect(landed.fields[STEP]).toEqual({
      raw: '3 parsecs',
      fieldState: 'draft',
      error: 'Not a duration',
    })
    expect(deriveSaveStatus(landed, 1_100).state).toBe('draft')
  })
})

describe('the windows (429-15 Task 1)', () => {
  it('SAVED-FADES: Saved shows for SAVED_VISIBLE_MS after the write lands, then idle', () => {
    const t = 5_000
    const landed = fold([
      [{ type: 'edit', fieldKey: BROWSER, raw: 'firefox', valid: true }, t - 10],
      [{ type: 'write-started', id: 'w1', fieldKeys: [BROWSER] }, t - 10],
      [{ type: 'write-succeeded', id: 'w1' }, t],
    ])
    expect(SAVED_VISIBLE_MS).toBe(2_000)
    expect(deriveSaveStatus(landed, t).state).toBe('saved')
    expect(deriveSaveStatus(landed, t + 1_999).state).toBe('saved')
    expect(deriveSaveStatus(landed, t + 2_000).state).toBe('idle')
  })

  it('UNDO-WINDOW: an Undo line holds for UNDO_WINDOW_MS, then yields to the draft beneath it', () => {
    const t = 2_000
    const offered = fold([
      [
        { type: 'edit', fieldKey: STEP, raw: '30 parsecs', valid: false, error: 'Not a duration' },
        1_000,
      ],
      [
        {
          type: 'undo-offered',
          kind: 'delete-target',
          name: 'staging',
          token: 'u1',
          expiresAt: t + UNDO_WINDOW_MS,
        },
        t,
      ],
    ])
    expect(deriveSaveStatus(offered, t)).toMatchObject({
      state: 'undo',
      undo: { line: 'Deleted target staging', name: 'staging', token: 'u1' },
    })
    expect(deriveSaveStatus(offered, t + UNDO_WINDOW_MS - 1).state).toBe('undo')
    expect(deriveSaveStatus(offered, t + UNDO_WINDOW_MS).state).toBe('draft')

    const finished = reduceConfigAutosave(offered, { type: 'undo-finished' }, t + 10)
    expect(deriveSaveStatus(finished, t + 10).state).toBe('draft')
  })

  it('NEWER-UNDO-REPLACES: a second explicit action replaces the Undo line and the first is final', () => {
    const t = 3_000
    const first = reduceConfigAutosave(
      createInitialConfigAutosave(),
      {
        type: 'undo-offered',
        kind: 'delete-target',
        name: 'staging',
        token: 'first',
        expiresAt: t + 60_000,
      },
      t,
    )
    const second = reduceConfigAutosave(
      first,
      {
        type: 'undo-offered',
        kind: 'delete-model',
        name: 'gpt',
        token: 'second',
        expiresAt: t + 100 + UNDO_WINDOW_MS,
      },
      t + 100,
    )
    expect(second.undo?.token).toBe('second')
    expect(deriveSaveStatus(second, t + 100)).toMatchObject({
      state: 'undo',
      undo: { line: 'Deleted gpt', name: 'gpt', token: 'second' },
    })
    const afterSecond = t + 100 + UNDO_WINDOW_MS
    expect(deriveSaveStatus(second, afterSecond).state).toBe('idle')
    expect(deriveSaveStatus(second, afterSecond).undo).toBeUndefined()
  })
})
