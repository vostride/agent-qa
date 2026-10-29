// The retrieval class is a pure function of the recorded rung and reason; nothing probes the store.

import { describe, expect, it } from 'vitest'
import { RETRIEVAL_RUNG_REASONS, type RetrievalRung, type RetrievalRungReason } from '@vostride/agent-qa-schema'

import type { KnowledgeRead } from '@/lib/api'
import {
  DOCTOR_POINTER_TEXT,
  RETRIEVAL_CLASSES,
  RETRIEVAL_CLASS_BY_REASON,
  RETRIEVAL_CLASS_TONES,
  RUNG_CAUSE_LABELS,
  projectKnowledgeView,
  retrievalClassFor,
  retrievalStatement,
  rungBannerText,
} from '@/lib/knowledge-view'

type LowerRung = Exclude<RetrievalRung, 'memidex'>

// Spelled here rather than read from the subject, so a re-mapped reason fails.
const EXPECTED: Record<RetrievalRungReason, readonly [LowerRung, string]> = {
  'index-not-built': ['bundle-scan', 'fresh-index'],
  'index-unavailable': ['bundle-scan', 'cause-not-recorded'],
  'index-locked': ['bundle-scan', 'index-problem'],
  'index-corrupt': ['bundle-scan', 'index-problem'],
  'native-runtime-unavailable': ['static-floor', 'semantic-search-unavailable'],
  'model-not-downloaded': ['lexical-only', 'semantic-search-unavailable'],
  'embedder-load-failed': ['lexical-only', 'semantic-search-unavailable'],
  'profile-unresolved': ['lexical-only', 'semantic-search-unavailable'],
  'profile-static-configured': ['static-floor', 'by-configuration'],
  'floor-disabled': ['lexical-only', 'by-configuration'],
}

const REASON_ROWS = RETRIEVAL_RUNG_REASONS.map(reason => [reason, ...EXPECTED[reason]] as const)

const BOOTSTRAP =
  "The knowledge index hadn't been built yet, so this run read knowledge straight from the bundles. "
  + 'Nothing was missed. The index is built after the run finishes, and later runs use it.'

const POINTER =
  "To check the store's health now, run agent-qa doctor. It reports current health and doesn't change what this run recorded."

// One (rung, reason) per class, plus the second wording inside semantic-search-unavailable and
// by-configuration, and the reason-less historical row.
const SENTENCES: ReadonlyArray<readonly [LowerRung, RetrievalRungReason | undefined, string, string]> = [
  ['bundle-scan', 'index-not-built', 'fresh-index', BOOTSTRAP],
  [
    'bundle-scan',
    'index-unavailable',
    'cause-not-recorded',
    "This run used bundle scan instead of full knowledge retrieval. The reason wasn't recorded for this run.",
  ],
  [
    'static-floor',
    undefined,
    'cause-not-recorded',
    "This run used static-floor embeddings instead of full knowledge retrieval. The reason wasn't recorded for this run.",
  ],
  [
    'bundle-scan',
    'index-locked',
    'index-problem',
    "This run couldn't use the knowledge index, so it read knowledge straight from the bundles — knowledge index locked by another process, scanning bundles.",
  ],
  [
    'bundle-scan',
    'index-corrupt',
    'index-problem',
    "This run couldn't use the knowledge index, so it read knowledge straight from the bundles — knowledge index corrupt, rebuild requested, scanning bundles.",
  ],
  [
    'static-floor',
    'native-runtime-unavailable',
    'semantic-search-unavailable',
    "This run's knowledge retrieval used the lightweight static-floor embeddings instead of the full model — native ONNX runtime unavailable.",
  ],
  [
    'lexical-only',
    'model-not-downloaded',
    'semantic-search-unavailable',
    "This run's knowledge retrieval ran without semantic search, on keyword and anchor matching only — embedding model not downloaded.",
  ],
  [
    'static-floor',
    'profile-static-configured',
    'by-configuration',
    "This run's knowledge retrieval used the static-floor embeddings, as this project is configured to.",
  ],
  [
    'lexical-only',
    'floor-disabled',
    'by-configuration',
    "This run's knowledge retrieval used keyword and anchor matching only, as this project is configured to.",
  ],
]

function ready(retrievalRung?: { schemaVersion: 2; rung: RetrievalRung; reason?: RetrievalRungReason }, knowledgeStore = 'bound'): KnowledgeRead {
  return {
    kind: 'read',
    projection: {
      kind: 'ready',
      runId: 'r_retrieval',
      buildOrdinal: 3,
      knowledgeStore,
      steps: [],
      curation: { status: 'complete' },
      learned: { changes: [], canaryAttributions: [] },
      ...(retrievalRung === undefined ? {} : { retrievalRung }),
    },
  } as KnowledgeRead
}

function usedRetrieval(read: KnowledgeRead) {
  const view = projectKnowledgeView(read)
  if (view.state !== 'ready') throw new Error(`expected ready, got ${view.state}`)
  return view.used.retrieval
}

describe('every recorded reason maps to exactly one retrieval class', () => {
  it('covers the whole recorded vocabulary with one expected row each', () => {
    expect(Object.keys(EXPECTED).sort()).toEqual([...RETRIEVAL_RUNG_REASONS].sort())
  })

  it.each(REASON_ROWS)('RETRIEVAL-CLASS-PER-REASON: %s on %s is %s', (reason, rung, expected) => {
    expect(retrievalClassFor).toBeTypeOf('function')
    expect(RETRIEVAL_CLASS_BY_REASON?.[reason]).toBe(expected)
    expect(retrievalClassFor({ rung, reason })).toBe(expected)
  })

  it('RETRIEVAL-CLASS-PER-REASON: a rung below memidex with no reason is cause-not-recorded, and memidex has no class', () => {
    expect(retrievalClassFor).toBeTypeOf('function')
    expect(retrievalClassFor({ rung: 'lexical-only' })).toBe('cause-not-recorded')
    expect(retrievalClassFor({ rung: 'bundle-scan' })).toBe('cause-not-recorded')
    expect(retrievalClassFor({ rung: 'memidex' })).toBeUndefined()
  })

  it('the retrieval classes and their tones', () => {
    expect(RETRIEVAL_CLASSES).toEqual([
      'fresh-index',
      'cause-not-recorded',
      'index-problem',
      'semantic-search-unavailable',
      'by-configuration',
    ])
    expect(RETRIEVAL_CLASS_TONES).toEqual({
      'fresh-index': 'info',
      'cause-not-recorded': 'info',
      'index-problem': 'warning',
      'semantic-search-unavailable': 'warning',
      'by-configuration': 'info',
    })
  })
})

describe('each class states this run\'s retrieval level in its own words', () => {
  it.each(SENTENCES)('the %s / %s statement (%s) is pinned', (rung, reason, cls, sentence) => {
    expect(retrievalStatement).toBeTypeOf('function')
    expect(retrievalClassFor({ rung, ...(reason === undefined ? {} : { reason }) })).toBe(cls)
    expect(retrievalStatement(rung, reason)).toBe(sentence)
  })

  it('STATEMENTS-NAME-THIS-RUN: every class sentence says it describes this run', () => {
    expect(retrievalStatement).toBeTypeOf('function')
    const classes = new Set<string>()
    for (const [rung, reason, cls] of SENTENCES) {
      classes.add(cls)
      expect(retrievalStatement(rung, reason).toLowerCase()).toContain('this run')
    }
    expect([...classes].sort()).toEqual([...RETRIEVAL_CLASSES].sort())
    for (const reason of RETRIEVAL_RUNG_REASONS) {
      const [rung] = EXPECTED[reason]
      expect(retrievalStatement(rung, reason).toLowerCase()).toContain('this run')
    }
  })

  it('the bootstrap sentence promises only what happens next, never a completed rebuild', () => {
    expect(retrievalStatement).toBeTypeOf('function')
    expect(retrievalStatement('bundle-scan', 'index-not-built')).toBe(BOOTSTRAP)
    expect(retrievalStatement('bundle-scan', 'index-not-built')).not.toMatch(/rebuilt|was built|has been built/u)
  })

  it('warning statements embed the recorded cause label verbatim', () => {
    expect(retrievalStatement).toBeTypeOf('function')
    expect(RETRIEVAL_CLASS_TONES).toBeTypeOf('object')
    for (const reason of RETRIEVAL_RUNG_REASONS) {
      const [rung, cls] = EXPECTED[reason]
      if (RETRIEVAL_CLASS_TONES[cls as keyof typeof RETRIEVAL_CLASS_TONES] !== 'warning') continue
      expect(retrievalStatement(rung, reason)).toContain(`— ${RUNG_CAUSE_LABELS[reason]}.`)
    }
  })

  it('the doctor pointer says doctor reads current health and changes nothing this run recorded', () => {
    expect(DOCTOR_POINTER_TEXT).toBe(POINTER)
    expect(DOCTOR_POINTER_TEXT).not.toContain('`')
    expect(DOCTOR_POINTER_TEXT).not.toMatch(/\b(repair|fix|rewrite|rebuild)/iu)
  })

  it('no statement carries a backtick or the retired degraded wording', () => {
    expect(retrievalStatement).toBeTypeOf('function')
    for (const reason of RETRIEVAL_RUNG_REASONS) {
      const [rung] = EXPECTED[reason]
      const sentence = retrievalStatement(rung, reason)
      expect(sentence).not.toContain('`')
      expect(sentence).not.toContain('Retrieval degraded')
    }
  })
})

describe('the ready view carries the statement under used, and only below memidex', () => {
  it('a warning class carries its sentence and the doctor pointer', () => {
    expect(retrievalStatement).toBeTypeOf('function')
    expect(usedRetrieval(ready({ schemaVersion: 2, rung: 'bundle-scan', reason: 'index-locked' }))).toEqual({
      retrievalClass: 'index-problem',
      tone: 'warning',
      rung: 'bundle-scan',
      reason: 'index-locked',
      sentence: retrievalStatement('bundle-scan', 'index-locked'),
      pointer: DOCTOR_POINTER_TEXT,
    })
  })

  it('an info class carries its sentence and no pointer', () => {
    expect(usedRetrieval(ready({ schemaVersion: 2, rung: 'bundle-scan', reason: 'index-not-built' }))).toEqual({
      retrievalClass: 'fresh-index',
      tone: 'info',
      rung: 'bundle-scan',
      reason: 'index-not-built',
      sentence: BOOTSTRAP,
    })
  })

  it('a reason-less lower rung reads as cause-not-recorded with no reason key', () => {
    const retrieval = usedRetrieval(ready({ schemaVersion: 2, rung: 'lexical-only' }))
    expect(retrieval?.retrievalClass).toBe('cause-not-recorded')
    expect(retrieval !== undefined && 'reason' in retrieval).toBe(false)
  })

  it('memidex and a run that recorded no rung carry no statement; an unbound store has no ready arm', () => {
    expect(usedRetrieval(ready({ schemaVersion: 2, rung: 'memidex' }))).toBeUndefined()
    expect(usedRetrieval(ready())).toBeUndefined()
    expect(projectKnowledgeView(ready({ schemaVersion: 2, rung: 'bundle-scan', reason: 'index-corrupt' }, 'unbound')).state)
      .toBe('empty-no-store')
  })

  it('the view, the strip and the statement agree on every render of one record (idempotency)', () => {
    expect(retrievalStatement).toBeTypeOf('function')
    expect(RETRIEVAL_CLASS_TONES).toBeTypeOf('object')
    for (const reason of RETRIEVAL_RUNG_REASONS) {
      const [rung, cls] = EXPECTED[reason]
      const read = ready({ schemaVersion: 2, rung, reason })
      const first = usedRetrieval(read)
      expect(usedRetrieval(read)).toEqual(first)
      const banner = rungBannerText({ rung, reason })
      if (RETRIEVAL_CLASS_TONES[cls as keyof typeof RETRIEVAL_CLASS_TONES] === 'warning') {
        expect(banner).toBe(`${first?.sentence ?? ''} ${DOCTOR_POINTER_TEXT}`)
      } else {
        expect(banner).toBeUndefined()
      }
    }
  })
})
