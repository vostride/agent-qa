// THE PROJECTION, HELD TOTAL AND PURE.
//
// `projectPostProcessingView` is the whole distance between "what the route said" and "what a
// person reads". It takes a `PostProcessingRead` and returns a view; it has no I/O, no clock and
// no envelope type in its signature — which is the structural half of D-17. These cells fix the
// PUBLISHED SENTENCES by their exported constants rather than by literal prose, so
// a copy change moves one line here and one line in the module, and never silently diverges.
//
// THE CELL THAT MATTERS MOST is the `failed`-with-no-envelope one. D-21 as narrowed in 404-03 put
// the masked reason on the in-process `*Failed` chip envelope and NOT on the durable notification
// row, because the daemon's pump folds with no masking context. So a daemon-drained failure has no
// reason anywhere, and the only honest renderings are "failed, reason not recorded — drained by the
// daemon" and a lie. Blank is a lie by omission; `pending` is a lie outright.

import { describe, expect, it } from 'vitest'
import { POST_PROCESSING_SKIP_REASONS, VERDICT_CLASSES, CURATION_SNAPSHOT_SCHEMA_VERSION } from '@vostride/agent-qa-schema'
import type { CurationBreakdown, PostProcessingStatus } from '@vostride/agent-qa-schema'

import type { PostProcessingRead } from '@/lib/api'
import {
  ANALYSIS_COMPLETE_NO_ISSUES_TEXT,
  ANALYSIS_RUNNING_TEXT,
  BREAKDOWN_NOT_RECORDED_TEXT,
  BREAKDOWN_WITHHELD_TEXT,
  CHIPS_UNAVAILABLE_TEXT,
  COUNTS_NOT_RECORDED_TEXT,
  CURATION_RUNNING_TEXT,
  FAILED_REASON_ABSENT_TEXT,
  NO_MEMORY_CHANGES_TEXT,
  OPEN_KNOWLEDGE_TAB_TEXT,
  OPEN_VERDICT_TEXT,
  PENDING_POSTURE_TEXT,
  POST_PROCESSING_LOADING_LABEL,
  POST_PROCESSING_UNAVAILABLE_WORD,
  STAGE_INDICATOR_WORDS,
  STAGE_PRESENTATION_STATES,
  STAGE_SKIPPED_TEXT,
  WILL_RETRY_TEXT,
  analysisCompleteWithVerdictsText,
  curationBreakdownLine,
  curationChipAccessibleName,
  formatClockTime,
  legacyCurationPairText,
  projectPostProcessingView,
  stageFailedText,
  stageIndicatorAccessibleName,
  stageQueuedText,
  stageTimingLine,
  verdictClassLabel,
} from '@/lib/post-processing-view'

const RUN_ID = 'run_view'

function status(
  analysis: string,
  curation: string,
  notification?: unknown,
  extra: Record<string, unknown> = {},
): PostProcessingStatus {
  return {
    runId: RUN_ID,
    chips: { analysis, curation },
    ...(notification === undefined ? {} : { notification }),
    ...extra,
  } as unknown as PostProcessingStatus
}

function breakdown(counts: Partial<CurationBreakdown> = {}): CurationBreakdown {
  return { added: 0, confirmed: 0, superseded: 0, deprecated: 0, proposed: 0, ...counts }
}

function notification(
  curation: Record<string, unknown>,
  verdictSummary: unknown = { total: 1, byClass: {} },
): unknown {
  return {
    schemaVersion: 2,
    runId: RUN_ID,
    outcome: 'complete',
    verdictSummary,
    stages: {
      analysis: { status: 'complete' },
      curation,
    },
  }
}

function read(body: Partial<Extract<PostProcessingRead, { kind: 'read' }>>): PostProcessingRead {
  return { kind: 'read', status: status('pending', 'pending'), ...body }
}

/** The chips arm, narrowed — every cell below reads two chips, and none of them may be a refusal. */
function chips(view: ReturnType<typeof projectPostProcessingView>) {
  if (view.kind !== 'chips') throw new Error(`expected chips, got ${view.kind}`)
  return view
}

describe('a refusal is its own state, never a pending chip', () => {
  it('carries the refusal name and reason through, with no chips at all', () => {
    const view = projectPostProcessingView({
      kind: 'unavailable',
      error: 'job_store_schema_version',
      reason: 'the queue database is stamped by another build',
    })
    expect(view).toEqual({
      kind: 'unavailable',
      error: 'job_store_schema_version',
      reason: 'the queue database is stamped by another build',
    })
  })

  it('publishes the unavailable sentence as an exported constant, not as prose in a component', () => {
    expect(CHIPS_UNAVAILABLE_TEXT.length).toBeGreaterThan(0)
    expect(CHIPS_UNAVAILABLE_TEXT).toContain('unavailable')
  })
})

describe('a pending chip carries the run posture, read off the record', () => {
  it('has NO posture while the run has not reached runFinished — no disposition is not a guess', () => {
    const view = chips(projectPostProcessingView(read({})))
    expect(view.analysis).toEqual({
      status: 'pending',
      state: 'pending',
      word: STAGE_INDICATOR_WORDS.analysis.pending,
      card: { outcome: 'Analysis queued' },
    })
    expect(view.curation).toEqual({
      status: 'pending',
      state: 'pending',
      word: STAGE_INDICATOR_WORDS.curation.pending,
      card: { outcome: 'Curation queued' },
    })
  })

  it('names each of the three postures by its published sentence', () => {
    for (const disposition of ['drained', 'handedOff', 'detached'] as const) {
      const view = chips(projectPostProcessingView(read({ disposition })))
      expect(view.analysis.card?.outcome)
        .toBe(stageQueuedText('analysis', PENDING_POSTURE_TEXT[disposition]))
    }
    expect(PENDING_POSTURE_TEXT.handedOff).toBe('daemon draining')
    expect(PENDING_POSTURE_TEXT.detached).toContain('not queued for drain')
  })
})

describe('a running chip says one word and nothing else', () => {
  it('carries no posture and no counts even with a disposition on the read', () => {
    const view = chips(projectPostProcessingView(read({
      status: status('running', 'running'),
      disposition: 'drained',
    })))
    expect(view.analysis).toEqual({
      status: 'running',
      state: 'running',
      word: STAGE_INDICATOR_WORDS.analysis.running,
      card: { outcome: ANALYSIS_RUNNING_TEXT },
    })
    expect(view.curation).toEqual({
      status: 'running',
      state: 'running',
      word: STAGE_INDICATOR_WORDS.curation.running,
      card: { outcome: CURATION_RUNNING_TEXT },
    })
  })
})

describe('a terminal curation card says what it committed, in its wording of record', () => {
  it('reads the breakdown off the snapshot on the same read — five buckets, zeros omitted', () => {
    const view = chips(projectPostProcessingView(read({
      status: status('complete', 'complete', notification({ status: 'complete' }), {
        curationSnapshot: { schemaVersion: CURATION_SNAPSHOT_SCHEMA_VERSION, rows: [], breakdown: breakdown({ added: 4, deprecated: 2 }) },
      }),
      disposition: 'drained',
    })))
    expect(view.curation.card?.outcome).toBe('Curation complete — 4 added · 2 deprecated')
    expect(view.curation.card?.note).toBeUndefined()
  })

  it('says `counts not recorded for this run` when the row committed no counts — never a zero', () => {
    const view = chips(projectPostProcessingView(read({
      status: status('complete', 'complete', notification({ status: 'complete' })),
    })))
    expect(view.curation.card?.outcome).toBe(`Curation complete — ${COUNTS_NOT_RECORDED_TEXT}`)
    expect(COUNTS_NOT_RECORDED_TEXT).toBe('counts not recorded for this run')
  })

  it('says the counts-absent line when only ONE of the pair was recorded — half a pair is no pair', () => {
    const view = chips(projectPostProcessingView(read({
      status: status('complete', 'complete', notification({ status: 'complete', curated: 4 })),
    })))
    expect(view.curation.card?.outcome).toBe(`Curation complete — ${COUNTS_NOT_RECORDED_TEXT}`)
  })

  it('keeps a bare `complete` when there is no notification row at all — nothing to say counts about', () => {
    const view = chips(projectPostProcessingView(read({ status: status('complete', 'complete') })))
    expect(view.curation)
      .toEqual({ status: 'complete', state: 'complete', word: STAGE_INDICATOR_WORDS.curation.complete })
  })

  it('renders an all-zero breakdown as `no memory changes` rather than as five zeros', () => {
    const view = chips(projectPostProcessingView(read({
      status: status('complete', 'complete', notification({ status: 'complete' }), {
        curationSnapshot: { schemaVersion: CURATION_SNAPSHOT_SCHEMA_VERSION, rows: [], breakdown: breakdown() },
      }),
    })))
    expect(view.curation.card?.outcome).toBe(`Curation complete — ${NO_MEMORY_CHANGES_TEXT}`)
  })

  // RE-SPELLED 425-08. The claim is unchanged — curation's counts never reach the analysis card —
  // but the analysis card is no longer absent on a verdict-bearing run, so the cell now
  // measures what that card SAYS rather than that it does not exist.
  it('never invents a card for the analysis chip from curation counts', () => {
    const view = chips(projectPostProcessingView(read({
      status: status('complete', 'complete', notification({ status: 'complete' }, { total: 1, byClass: { app_bug: 1 } }), {
        curationSnapshot: { schemaVersion: CURATION_SNAPSHOT_SCHEMA_VERSION, rows: [], breakdown: breakdown({ added: 4 }) },
      }),
    })))
    expect(view.analysis.state).toBe('complete')
    expect(view.analysis.word).toBe(STAGE_INDICATOR_WORDS.analysis.complete)
    expect(view.analysis.card?.outcome).not.toContain('added')
    expect(view.analysis.card?.outcome).not.toContain('curated')

    // A run whose chain recorded NO terminal row has nothing to say about either stage.
    const bare = chips(projectPostProcessingView(read({ status: status('complete', 'complete') })))
    expect(bare.analysis)
      .toEqual({ status: 'complete', state: 'complete', word: STAGE_INDICATOR_WORDS.analysis.complete })
  })
})

// FIVE BUCKETS ARE NEVER SYNTHESIZED FROM TWO. A pre-423 row carries a pair and nothing
// else; a withheld snapshot carries a reason and nothing else. Each renders what EXISTS, labelled,
// rather than a breakdown the run never recorded.
describe('the curation breakdown is one function, and legacy rows say what they are', () => {
  it('lists only the non-zero buckets, in the schema order, joined by a middle dot', () => {
    expect(curationBreakdownLine(breakdown({
      added: 1, confirmed: 1, superseded: 1, deprecated: 1, proposed: 1,
    }))).toBe('1 added · 1 confirmed · 1 superseded · 1 deprecated · 1 proposed')
    expect(curationBreakdownLine(breakdown({ added: 1, superseded: 1, proposed: 2 })))
      .toBe('1 added · 1 superseded · 2 proposed')
    expect(curationBreakdownLine(breakdown())).toBe(NO_MEMORY_CHANGES_TEXT)
    expect(NO_MEMORY_CHANGES_TEXT).toBe('no memory changes')
  })

  it('renders a legacy pair verbatim and labels it as the absence of a breakdown', () => {
    expect(legacyCurationPairText(2, 0)).toBe('2 curated · 0 deprecated')
    const view = chips(projectPostProcessingView(read({
      status: status('complete', 'complete', notification({ status: 'complete', curated: 2, deprecated: 0 })),
    })))
    expect(view.curation.card?.outcome).toBe('Curation complete — 2 curated · 0 deprecated')
    expect(view.curation.card?.note).toBe(BREAKDOWN_NOT_RECORDED_TEXT)
    expect(BREAKDOWN_NOT_RECORDED_TEXT).toBe('Breakdown not recorded for this run')
  })

  it('names the withheld category rather than inventing counts for it', () => {
    for (const reason of ['masking-unavailable', 'projection-refused'] as const) {
      const view = chips(projectPostProcessingView(read({
        status: status('complete', 'complete', notification({ status: 'complete' }), {
          curationSnapshotWithheld: { reason },
        }),
      })))
      expect(view.curation.card?.outcome).toBe('Curation complete')
      expect(view.curation.card?.note).toBe(BREAKDOWN_WITHHELD_TEXT[reason])
    }
    expect(BREAKDOWN_WITHHELD_TEXT['masking-unavailable'])
      .toBe('Breakdown not available for this run — masking unavailable')
    expect(BREAKDOWN_WITHHELD_TEXT['projection-refused'])
      .toBe('Breakdown not available for this run — projection refused')
  })

  it('prefers the snapshot over the legacy pair — a snapshot-bearing row never says `curated`', () => {
    const view = chips(projectPostProcessingView(read({
      status: status('complete', 'complete', notification({ status: 'complete', curated: 2, deprecated: 0 }), {
        curationSnapshot: { schemaVersion: CURATION_SNAPSHOT_SCHEMA_VERSION, rows: [], breakdown: breakdown({ added: 2 }) },
      }),
    })))
    expect(view.curation.card?.outcome).toBe('Curation complete — 2 added')
    expect(view.curation.card?.note).toBeUndefined()
  })
})

// EVERY STATE HAS AN HONEST FIRST LINE. A card that could open blank is a hover that rewards
// the reader with nothing — which is the failure the whole card exists to fix.
describe('running, queued and failed stages each read their own sentence', () => {
  it('names a running stage in its own words', () => {
    const view = chips(projectPostProcessingView(read({ status: status('running', 'running') })))
    expect(view.analysis.card?.outcome).toBe(ANALYSIS_RUNNING_TEXT)
    expect(view.curation.card?.outcome).toBe(CURATION_RUNNING_TEXT)
    expect(ANALYSIS_RUNNING_TEXT).toBe('Analysis running')
    expect(CURATION_RUNNING_TEXT).toBe('Curation running')
  })

  it('puts the drain posture in the CARD, and says the bare word when no posture was recorded', () => {
    const withPosture = chips(projectPostProcessingView(read({ disposition: 'handedOff' })))
    expect(withPosture.analysis.card?.outcome)
      .toBe(stageQueuedText('analysis', PENDING_POSTURE_TEXT.handedOff))
    expect(withPosture.analysis.card?.outcome)
      .toBe(`Analysis queued — ${PENDING_POSTURE_TEXT.handedOff}`)

    const bare = chips(projectPostProcessingView(read({})))
    expect(bare.analysis.card?.outcome).toBe('Analysis queued')
    expect(bare.curation.card?.outcome).toBe('Curation queued')
  })

  it('carries the masked failure reason, or the posture-qualified absence, plus the retry line', () => {
    const withReason = chips(projectPostProcessingView(read({
      status: status('failed', 'pending'),
      disposition: 'drained',
      failures: { analysis: { error: 'analysis stage blew up on step 3', willRetry: true } },
    })))
    expect(withReason.analysis.card?.outcome)
      .toBe(stageFailedText('analysis', 'analysis stage blew up on step 3'))
    expect(withReason.analysis.card?.outcome)
      .toBe('Analysis failed — analysis stage blew up on step 3')
    expect(withReason.analysis.card?.retry).toBe(WILL_RETRY_TEXT)
    expect(WILL_RETRY_TEXT).toBe('Will retry')

    const noReason = chips(projectPostProcessingView(read({
      status: status('failed', 'pending'),
      disposition: 'handedOff',
      failures: {},
    })))
    expect(noReason.analysis.card?.outcome)
      .toBe(stageFailedText('analysis', FAILED_REASON_ABSENT_TEXT.handedOff))
    expect(noReason.analysis.card?.retry).toBeUndefined()
  })
})

describe('a failed chip says why, or says honestly that nobody recorded why', () => {
  it('renders the producer masked text VERBATIM — the page slices nothing', () => {
    const long = `a${'b'.repeat(480)}`
    const view = chips(projectPostProcessingView(read({
      status: status('failed', 'pending'),
      disposition: 'drained',
      failures: { analysis: { error: long, willRetry: false } },
    })))
    expect(view.analysis.card?.outcome).toBe(stageFailedText('analysis', long))
    expect(view.analysis.card?.retry).toBeUndefined()
  })

  it('a handedOff failure with no envelope says so by posture, and names no reason', () => {
    const view = chips(projectPostProcessingView(read({
      status: status('failed', 'pending'),
      disposition: 'handedOff',
      failures: {},
    })))
    expect(view.analysis.status).toBe('failed')
    expect(view.analysis.card?.outcome)
      .toBe(stageFailedText('analysis', FAILED_REASON_ABSENT_TEXT.handedOff))
    expect(FAILED_REASON_ABSENT_TEXT.handedOff).toContain('drained by the daemon')
  })

  it('a detached failure with no envelope names the later drainer instead', () => {
    const view = chips(projectPostProcessingView(read({
      status: status('pending', 'failed'),
      disposition: 'detached',
      failures: {},
    })))
    expect(view.curation.card?.outcome)
      .toBe(stageFailedText('curation', FAILED_REASON_ABSENT_TEXT.detached))
    expect(FAILED_REASON_ABSENT_TEXT.detached).toContain('later process')
  })

  it('a failure on a read whose `failures` key is ABSENT falls back without a disposition word', () => {
    const view = chips(projectPostProcessingView(read({ status: status('failed', 'pending') })))
    expect(view.analysis.card?.outcome)
      .toBe(stageFailedText('analysis', FAILED_REASON_ABSENT_TEXT.unknown))
  })

  it('is never blank: every failed chip carries an outcome sentence, on all four postures', () => {
    const postures = [undefined, 'drained', 'handedOff', 'detached'] as const
    for (const disposition of postures) {
      const view = chips(projectPostProcessingView(read({
        status: status('failed', 'failed'),
        ...(disposition === undefined ? {} : { disposition }),
        failures: {},
      })))
      for (const chip of [view.analysis, view.curation]) {
        expect(chip.status).toBe('failed')
        expect(chip.card?.outcome).toBeTruthy()
      }
    }
  })
})

// RETIRED 425-06. The two cells that stood here pinned the legacy pair's folded sentence,
// whose last reader — the Knowledge tab's Learned heading — now calls `curationBreakdownLine` and
// `legacyCurationPairText` instead. Both of those are pinned in this file's breakdown cells, so
// retiring the function retired its cells rather than leaving them asserting over nothing.
describe('the count line is the wording of record, in one place', () => {
  it('publishes the curation door name as a thin call into the one accessible-name function', () => {
    const settled = { status: 'complete', state: 'complete', word: STAGE_INDICATOR_WORDS.curation.complete } as const
    expect(curationChipAccessibleName(settled)).toBe('Curation: complete — open Knowledge tab')
    expect(curationChipAccessibleName({ ...settled, card: { outcome: 'Curation complete — 2 added' } }))
      .toBe('Curation: complete, 2 added — open Knowledge tab')
    expect(OPEN_KNOWLEDGE_TAB_TEXT).toBe('Open Knowledge tab')
    expect(OPEN_VERDICT_TEXT).toBe('Open verdict')
  })
})

// THE PASSING RUN EXPLAINS ITSELF (425-01 · D-13, roadmap SC3). The sentence a person reads on the
// one run shape that ships every day — analysis settled, nothing to report — is the phase's copy
// cell, and it is a CONSTANT so the card, the accessible name and this cell cannot drift apart.
describe('a settled analysis with nothing to report says so in one sentence', () => {
  it('ANALYSIS-COMPLETE-COPY: publishes the sentence and projects it onto a no-verdict pass', () => {
    expect(ANALYSIS_COMPLETE_NO_ISSUES_TEXT).toBe('Analysis complete — no issues found')

    const view = chips(projectPostProcessingView(read({
      status: status('complete', 'complete', notification({ status: 'complete' }, { total: 0, byClass: {} })),
      disposition: 'drained',
    })))

    expect(view.analysis.state).toBe('complete')
    expect(view.analysis.word).toBe(STAGE_INDICATOR_WORDS.analysis.complete)
    expect(view.analysis.card?.outcome).toBe(ANALYSIS_COMPLETE_NO_ISSUES_TEXT)
    expect(stageIndicatorAccessibleName('analysis', 'complete', ANALYSIS_COMPLETE_NO_ISSUES_TEXT))
      .toBe('Analysis: complete, no issues found')
  })
})

// THE VISIBLE WORD. A settled stage is quiet — the name alone. Every other state
// says itself, because those are the states a person can act on. The set is six and the order is
// the one the never-bar pins; a cell that only walked the reachable ones would not see a gap.
describe('an indicator says the stage, and says the state when it needs attention', () => {
  it('STAGE-INDICATOR-WORDS: the stage name alone for complete, name plus state word otherwise', () => {
    expect(STAGE_PRESENTATION_STATES).toEqual([
      'complete',
      'running',
      'pending',
      'failed',
      'skipped',
      'unavailable',
    ])
    expect(STAGE_PRESENTATION_STATES).toHaveLength(6)

    expect(STAGE_INDICATOR_WORDS.analysis).toEqual({
      complete: 'Analysis',
      running: 'Analysis running',
      pending: 'Analysis pending',
      failed: 'Analysis failed',
      skipped: 'Analysis skipped',
    })
    expect(STAGE_INDICATOR_WORDS.curation).toEqual({
      complete: 'Curation',
      running: 'Curation running',
      pending: 'Curation pending',
      failed: 'Curation failed',
      skipped: 'Curation skipped',
    })
    expect(POST_PROCESSING_UNAVAILABLE_WORD).toBe('Post-processing unavailable')
    expect(POST_PROCESSING_LOADING_LABEL).toBe('Post-processing status loading')
  })
})

describe('the word each stage chip shows', () => {
  it('the dashboard presents complete for a complete chip', () => {
    const view = chips(projectPostProcessingView(read({ status: status('complete', 'complete') })))
    expect(view.analysis).toEqual({
      status: 'complete',
      state: 'complete',
      word: STAGE_INDICATOR_WORDS.analysis.complete,
    })
    expect(view.curation).toEqual({
      status: 'complete',
      state: 'complete',
      word: STAGE_INDICATOR_WORDS.curation.complete,
    })
  })
})

const SKIPPED_SENTENCES = {
  'gate-run': {
    analysis: 'Analysis skipped — gate runs are not analysed',
    curation: 'Curation skipped — gate runs are not curated',
  },
  'outcome-excluded': {
    analysis: 'Analysis skipped — runs excluded from outcomes are not analysed',
    curation: 'Curation skipped — runs excluded from outcomes are not curated',
  },
  'no-verdict': {
    analysis: 'Analysis skipped — the run ended before it reached a verdict',
    curation: 'Curation skipped — the run ended before it reached a verdict',
  },
} as const

describe('a skipped stage and its reason', () => {
  it("the dashboard indicator reads Analysis skipped with the reason's own sentence", () => {
    expect(POST_PROCESSING_SKIP_REASONS.length).toBeGreaterThan(0)
    for (const reason of POST_PROCESSING_SKIP_REASONS) {
      const view = chips(projectPostProcessingView(read({
        status: status('pending', 'pending', undefined, { skipped: { reason } }),
      })))
      expect(view.skipped, reason).toEqual({ reason })
      expect(view).not.toHaveProperty('excluded')
      expect(view.analysis).toEqual({
        status: 'pending',
        state: 'skipped',
        word: 'Analysis skipped',
        card: { outcome: SKIPPED_SENTENCES[reason].analysis },
      })
      expect(view.curation).toEqual({
        status: 'pending',
        state: 'skipped',
        word: 'Curation skipped',
        card: { outcome: SKIPPED_SENTENCES[reason].curation },
      })
    }
  })
})

describe('a run with no verdict skips analysis and curation', () => {
  it('the dashboard reads Analysis skipped and Curation skipped with the no-verdict sentence', () => {
    expect(POST_PROCESSING_SKIP_REASONS).toContain('no-verdict')
    const view = chips(projectPostProcessingView(read({
      status: status('pending', 'pending', undefined, { skipped: { reason: 'no-verdict' } }),
      disposition: 'handedOff',
    })))
    expect(view.skipped).toEqual({ reason: 'no-verdict' })
    expect(view.analysis).toEqual({
      status: 'pending',
      state: 'skipped',
      word: 'Analysis skipped',
      card: { outcome: 'Analysis skipped — the run ended before it reached a verdict' },
    })
    expect(view.curation).toEqual({
      status: 'pending',
      state: 'skipped',
      word: 'Curation skipped',
      card: { outcome: 'Curation skipped — the run ended before it reached a verdict' },
    })
    expect(JSON.stringify(view)).not.toContain(PENDING_POSTURE_TEXT.handedOff)
  })
})

// THE SKIPPED STATE COMES FROM THE READ'S OWN FIELD.
//
// The op folds `skipped` from the run's durable `gateRun` / `excludedFromOutcomes` markers — the
// same markers the post-verdict enqueue skip reads — so the dashboard, the CLI exit line and the
// digest say ONE thing (law 6). The projection therefore reads the FIELD and nothing else: not the
// absence of job rows, not the run's own status, not a settled chip word. The negative arm below is
// the half that matters, because a fold that guessed would still pass every positive assertion.
describe('a skipped chain reads skipped because the read said so, never because rows are missing', () => {
  it('EXCLUDED-FROM-FIELD: paints BOTH indicators skipped while the chip words stay verbatim', () => {
    for (const reason of POST_PROCESSING_SKIP_REASONS) {
      const view = chips(projectPostProcessingView(read({
        status: status('pending', 'pending', undefined, { skipped: { reason } }),
      })))

      expect(view.skipped).toEqual({ reason })
      expect(view.analysis).toEqual({
        status: 'pending',
        state: 'skipped',
        word: STAGE_INDICATOR_WORDS.analysis.skipped,
        card: { outcome: STAGE_SKIPPED_TEXT[reason].analysis },
      })
      expect(view.curation).toEqual({
        status: 'pending',
        state: 'skipped',
        word: STAGE_INDICATOR_WORDS.curation.skipped,
        card: { outcome: STAGE_SKIPPED_TEXT[reason].curation },
      })
    }

    expect(STAGE_SKIPPED_TEXT).toEqual(SKIPPED_SENTENCES)
  })

  it('EXCLUDED-FROM-FIELD: outranks the chip words — a settled read carrying the field is still skipped', () => {
    const view = chips(projectPostProcessingView(read({
      status: status('complete', 'complete', notification({ status: 'complete' }, { total: 0, byClass: {} }), {
        skipped: { reason: 'gate-run' },
      }),
      disposition: 'drained',
    })))

    expect(view.skipped).toEqual({ reason: 'gate-run' })
    expect(view.analysis.status).toBe('complete')
    expect(view.analysis.state).toBe('skipped')
    expect(view.analysis.card?.outcome).toBe(STAGE_SKIPPED_TEXT['gate-run'].analysis)
    expect(view.curation.status).toBe('complete')
    expect(view.curation.state).toBe('skipped')
    expect(view.curation.card?.outcome).toBe(STAGE_SKIPPED_TEXT['gate-run'].curation)
  })

  it('EXCLUDED-FROM-FIELD: a pending read WITHOUT the field is queued — the absence of rows proves nothing', () => {
    const view = chips(projectPostProcessingView(read({ disposition: 'handedOff' })))

    expect(view.skipped).toBeUndefined()
    expect(view.analysis.state).toBe('pending')
    expect(view.analysis.card?.outcome)
      .toBe(stageQueuedText('analysis', PENDING_POSTURE_TEXT.handedOff))
    expect(view.curation.state).toBe('pending')
    expect(view.curation.card?.outcome)
      .toBe(stageQueuedText('curation', PENDING_POSTURE_TEXT.handedOff))
  })
})

// PURE AND TOTAL, MEASURED RATHER THAN ASSERTED. A re-read arriving while a card is
// open repaints that card from the NEW read alone, which is only safe if projecting a read twice
// says the same thing and leaves the read's own bytes where it found them.
describe('the projection is pure and total', () => {
  it('PROJECTION-IDEMPOTENT: the same read projects deep-equal twice, and is never mutated', () => {
    const reads: PostProcessingRead[] = [
      read({ status: status('pending', 'pending', undefined, { skipped: { reason: 'outcome-excluded' } }) }),
      read({ status: status('failed', 'failed'), disposition: 'handedOff', failures: {} }),
      read({
        status: status('complete', 'complete', notification({ status: 'complete' }, { total: 0, byClass: {} }), {
          curationSnapshot: { schemaVersion: CURATION_SNAPSHOT_SCHEMA_VERSION, rows: [], breakdown: breakdown({ added: 1 }) },
        }),
        disposition: 'drained',
      }),
      { kind: 'unavailable', error: 'function_not_bound' },
    ]

    for (const subject of reads) {
      const before = JSON.stringify(subject)
      const first = projectPostProcessingView(subject)
      const second = projectPostProcessingView(subject)
      expect(second).toEqual(first)
      expect(JSON.stringify(subject)).toBe(before)
    }
  })
})

// TIMING IS THE JOB ROW'S OWN, CLAUSE BY CLAUSE.
//
// THE MODULE HAS NO CLOCK AND MUST NOT GROW ONE. Every value below is a stored string the reader
// stringified out of the job row — `created_at` / `started_at` / `updated_at`, written from the
// injected clock as `new Date().toISOString()`, and the SQLite `CURRENT_TIMESTAMP` space form that
// `normalizeTimestamp` exists for. Nothing here compares against "now", so nothing here can say a
// stage is stuck; elapsed-time judgements are the state the read publishes, not one a card infers.
//
// THE CELLS ASSERT THROUGH THE SAME FORMATTER rather than against a literal wall-clock string: the
// local zone varies between a laptop and CI, and a cell pinned to `10:41:02` would measure the
// machine it ran on instead of the sentence the reader gets.
describe('a card times the stage from the job row, and never from a clock of its own', () => {
  // The production SETTLED shape: created, started, updated — and no lease, because every terminal
  // transition releases the claim. `LEASE` is the same middle instant spelled as a claim, for the
  // cells that prove a lease alone is not a measurement.
  const STORED = {
    createdAt: '2026-09-22T10:41:02.000Z',
    startedAt: '2026-09-22T10:41:04.500Z',
    updatedAt: '2026-09-22T10:41:09.500Z',
  }
  const LEASE = '2026-09-22T10:41:04.500Z'
  const clock = (): string => {
    const at = formatClockTime(STORED.createdAt)
    return at ?? 'UNPARSED'
  }

  it('STAGE-TIMING-LINE: clock, then the two durations, and attempts only past one', () => {
    expect(formatClockTime(STORED.createdAt)).toMatch(/^\d{2}:\d{2}:\d{2}$/)
    expect(stageTimingLine({ ...STORED, attempts: 1 }, 'complete'))
      .toBe(`Queued ${clock()} · started after 2.5s · finished in 5s`)
    expect(stageTimingLine({ ...STORED, attempts: 2 }, 'complete'))
      .toBe(`Queued ${clock()} · started after 2.5s · finished in 5s · 2 attempts`)
  })

  it('STAGE-TIMING-LINE-DURABLE-START: a settled row whose claim was released still says how long the stage took', () => {
    expect(
      stageTimingLine({ ...STORED, attempts: 1 }, 'complete'),
      'the production settled shape — created, started, updated, and no lease — is fully timed',
    ).toBe(`Queued ${clock()} · started after 2.5s · finished in 5s`)
    expect(
      stageTimingLine(
        { createdAt: STORED.createdAt, claimedAt: LEASE, updatedAt: STORED.updatedAt },
        'complete',
      ),
      'the load-bearing half: every terminal transition releases the lease, so a card that timed '
        + 'from it could never answer how long a settled stage took — the question D-12 was written for',
    ).toBe(`Queued ${clock()}`)
  })

  it('STAGE-TIMING-LINE: a running stage ends at `running` and claims no finish', () => {
    const line = stageTimingLine({ ...STORED, attempts: 1 }, 'running')
    expect(line).toBe(`Queued ${clock()} · started after 2.5s · running`)
    expect(line).not.toContain('finished in')
  })

  // THE PRODUCTION RETRY SHAPE: `markRetryable` releases the lease and keeps the write-once start,
  // so the row reads `pending` while carrying a start and the instant its failure was recorded.
  it('STAGE-TIMING-LINE: a stage queued to retry says when it started and claims no finish', () => {
    const line = stageTimingLine({ ...STORED, attempts: 1, lastFailureKind: 'retry' }, 'pending')
    expect(line).toBe(`Queued ${clock()} · started after 2.5s`)
    expect(line).not.toContain('finished in')
    expect(stageTimingLine({ ...STORED, attempts: 2, lastFailureKind: 'retry' }, 'pending'))
      .toBe(`Queued ${clock()} · started after 2.5s · 2 attempts`)
  })

  it('STAGE-TIMING-LINE: a pending stage with only a queue moment says exactly that', () => {
    expect(stageTimingLine({ createdAt: STORED.createdAt, attempts: 0 }, 'pending'))
      .toBe(`Queued ${clock()}`)
  })

  it('STAGE-TIMING-LINE: no row at all renders no line; an absent field renders no clause', () => {
    expect(stageTimingLine(undefined, 'complete')).toBeUndefined()
    expect(
      stageTimingLine({ claimedAt: LEASE, updatedAt: STORED.updatedAt }, 'complete'),
      'a lease and an update time nothing: the lease is who holds the row, not when the work began',
    ).toBeUndefined()
    expect(stageTimingLine({ createdAt: STORED.createdAt, updatedAt: STORED.updatedAt }, 'complete'))
      .toBe(`Queued ${clock()}`)
  })

  it('STAGE-TIMING-LINE: an unparseable timestamp drops its own clause and never renders NaN', () => {
    const line = stageTimingLine(
      { createdAt: 'whenever', startedAt: STORED.startedAt, updatedAt: STORED.updatedAt },
      'complete',
    )
    expect(line).toBe('finished in 5s')
    expect(line).not.toContain('NaN')
    expect(formatClockTime('whenever')).toBeUndefined()
  })

  it('STAGE-TIMING-LINE: reads both shapes the store actually writes — ISO with Z and the SQLite space form', () => {
    expect(formatClockTime('2026-09-22 10:41:02')).toBe(formatClockTime('2026-09-22T10:41:02.000Z'))
  })

  it('STAGE-TIMING-LINE: folds onto the stage that HAS a row, and onto neither when none does', () => {
    const view = chips(projectPostProcessingView(read({
      status: status('complete', 'complete', notification({ status: 'complete' }, { total: 0, byClass: {} }), {
        stageDetails: { analysis: { ...STORED, attempts: 1 } },
      }),
      disposition: 'drained',
    })))
    expect(view.analysis.card?.timing)
      .toBe(`Queued ${clock()} · started after 2.5s · finished in 5s`)
    expect(view.curation.card?.timing).toBeUndefined()
  })

  it('STAGE-TIMING-LINE: a skipped run is never timed — nothing was ever enqueued to time', () => {
    const view = chips(projectPostProcessingView(read({
      status: status('pending', 'pending', undefined, {
        skipped: { reason: 'gate-run' },
        stageDetails: { analysis: { ...STORED, attempts: 1 } },
      }),
    })))
    expect(view.analysis.card?.timing).toBeUndefined()
    expect(view.analysis.card?.outcome).toBe(STAGE_SKIPPED_TEXT['gate-run'].analysis)
  })
})

// THE ROOT CAUSE COMES FROM A COUNTED FIELD, NEVER FROM A SENTENCE (425-08 · D-13, UI-SPEC S4).
//
// `notification.verdictSummary` is on the same read the header already holds: counted, durable and
// conformance-pinned. The alternative — reading a verdict's prose and looking for a class in it —
// is the rule 406 closed: a surface that parses another surface's sentence is coupled to wording
// that is free to change, and reports a class nobody stored.
describe('a settled analysis with verdicts names its root cause from the summary', () => {
  const outcomeFor = (verdictSummary: unknown): string | undefined =>
    chips(projectPostProcessingView(read({
      status: status('complete', 'complete', notification({ status: 'complete' }, verdictSummary)),
      disposition: 'drained',
    }))).analysis.card?.outcome

  it('ANALYSIS-ROOT-CAUSE-FROM-SUMMARY: names the dominant class and agrees its count', () => {
    expect(outcomeFor({ total: 2, byClass: { app_bug: 2 } }))
      .toBe('Analysis complete — root cause: app bug (2 verdicts)')
    expect(outcomeFor({ total: 1, byClass: { app_bug: 1 } }))
      .toBe('Analysis complete — root cause: app bug (1 verdict)')
    expect(outcomeFor({ total: 3, byClass: {} })).toBe('Analysis complete — 3 verdicts')
    expect(outcomeFor({ total: 0, byClass: {} })).toBe(ANALYSIS_COMPLETE_NO_ISSUES_TEXT)
  })

  it('ANALYSIS-ROOT-CAUSE-FROM-SUMMARY: breaks a tie by the schema class order, not by insertion order', () => {
    expect(VERDICT_CLASSES.indexOf('test_bug')).toBeLessThan(VERDICT_CLASSES.indexOf('app_bug'))
    expect(outcomeFor({ total: 2, byClass: { app_bug: 1, test_bug: 1 } }))
      .toBe('Analysis complete — root cause: test bug (2 verdicts)')
    expect(outcomeFor({ total: 2, byClass: { test_bug: 1, app_bug: 1 } }))
      .toBe('Analysis complete — root cause: test bug (2 verdicts)')
  })

  it('ANALYSIS-ROOT-CAUSE-FROM-SUMMARY: a zero-count key is not a class that occurred', () => {
    expect(outcomeFor({ total: 2, byClass: { test_bug: 0, app_bug: 2 } }))
      .toBe('Analysis complete — root cause: app bug (2 verdicts)')
  })

  it('ANALYSIS-ROOT-CAUSE-FROM-SUMMARY: the class is RE-SPELLED, never re-classified', () => {
    expect(verdictClassLabel('app_bug')).toBe('app bug')
    expect(verdictClassLabel('llm_error')).toBe('llm error')
    expect(verdictClassLabel('config_error')).toBe('config error')
    expect(verdictClassLabel('timeout')).toBe('timeout')
    for (const cls of VERDICT_CLASSES) expect(verdictClassLabel(cls)).not.toContain('_')

    expect(analysisCompleteWithVerdictsText(undefined, 1)).toBe('Analysis complete — 1 verdict')
    expect(analysisCompleteWithVerdictsText('config_error', 4))
      .toBe('Analysis complete — root cause: config error (4 verdicts)')
  })
})
