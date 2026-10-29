// The D-09 rewire: the projection's flake input is the RESOLVED verdict, on both paths.
//
// Three things are pinned here, and only the first is about counters:
//
//  1. The differential (the SC2 class): one handoff, two legs. With no analysis artifact the fold
//     answers the deterministic floor — an `unknown` failure increments no flake counter. With an
//     artifact upgrading that same test unknown→flake, the flake counter moves. Both legs are
//     id-addressed, because a single-run fixture cannot see a supersession defect (the 388
//     two-sided-contract law).
//  2. Identity refusal is INHERITED, not re-derived: an artifact recording another run's id folds
//     exactly as artifact-absent (G-389-3A). The file is PRESENT on the same path in both legs —
//     only the recorded runId varies — which is what distinguishes refusal from absence.
//  3. L12 rebuild parity by BYTES: a mixed incremental history (artifact present / foreign-runId /
//     absent) and a full rebuild over the same run dirs produce identical table dumps. A rebuild
//     that folded handoffs alone would silently diverge from the incremental path, which is the
//     defect a row-count comparison cannot see.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import {
  CURRENT_HANDOFF_SCHEMA_VERSION,
  ANALYSIS_FILE,
  CURRENT_ANALYSIS_SCHEMA_VERSION,
  canonicalJson,
  type Anchor,
  type CompletedRunHandoff,
  type PerTestOutcome,
  type RunAnalysisArtifact,
  type ScopeKey,
  type StepEvidence,
  type Verdict,
} from '@vostride/agent-qa-schema'
import { afterEach, describe, expect, it } from 'vitest'

import { ensureRunOutcomeTables, openIndexWriter } from '../../index-open.js'
import {
  applyRunOutcomes,
  foldRunOutcomes,
  projectRunOutcomes,
  rebuildRunOutcomes,
} from '../run-outcomes.js'

const SHOP_SCOPE: ScopeKey = { tier: 'product', key: 'shop-web' }
const FLAKY_FILE = 'suite/checkout.test.ts'
const FLAKY_TEST = 'checkout retries the payment sheet'
const payAnchor: Anchor = { t: 'el', role: 'button', name: 'pay now', ordinal: 1 }

/**
 * These folds pass no `quarantine` options, so the 390 D-08 detection step declares itself
 * explicitly skipped rather than answering an empty evaluation. Kept as exact equality — the
 * report's shape is the contract, and a loosened matcher would stop certifying it.
 */
const NO_DETECTION = { quarantine: { kind: 'not-evaluated', reason: 'not-requested' } } as const

const tempDirs: string[] = []

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function failingStep(): StepEvidence {
  return {
    stepIndex: 0,
    stepText: 'pay now',
    cacheStatus: 'miss',
    servedBrief: {
      scope: SHOP_SCOPE,
      asOfBuild: 1,
      budget: 1,
      truncation: 'none',
      channel1: [],
      channel2: [],
      channel3: [],
      briefDigest: 'resolved-fixture-digest',
    },
    subActions: [],
    verifierVerdict: { pass: false, reasoning: 'the payment sheet never opened' },
    anchors: [payAnchor],
  } as unknown as StepEvidence
}

/**
 * One failing member carrying NO `rootCause` — the deterministic floor resolves it to the minted
 * `unknown`, which is not a flake. That is what makes the upgrade observable.
 */
function unknownFailureHandoff(input: {
  runId: string
  buildOrdinal: number
}): CompletedRunHandoff {
  return {
    schemaVersion: CURRENT_HANDOFF_SCHEMA_VERSION,
    runId: input.runId,
    buildOrdinal: input.buildOrdinal,
    scope: SHOP_SCOPE,
    executionContext: 'ci',
    aggregateVerdict: 'failed',
    configDigests: {
      suiteConfigDigest: 'resolved-suite-digest',
      testConfigDigest: 'resolved-test-digest',
    },
    startedAt: input.buildOrdinal * 1_000,
    endedAt: input.buildOrdinal * 1_000 + 1,
    tests: [{
      testId: `${input.runId}-checkout`,
      testName: FLAKY_TEST,
      filePath: FLAKY_FILE,
      testIndex: 0,
      outcome: 'failed',
      steps: [failingStep()],
    } as unknown as PerTestOutcome],
  } as unknown as CompletedRunHandoff
}

/** The 389 supersession: the author upgraded the floor's `unknown` to `flake`. */
function flakeArtifact(runId: string): RunAnalysisArtifact {
  const verdict: Verdict = {
    class: 'flake',
    producer: 'analyze-run',
    confidence: 0.82,
    evidence: {
      citedSteps: [0],
      citedAnchors: [],
      citedArtifacts: [],
      rationale: 'the same step passed on the immediate re-run',
    },
    memoryMisdirectionRuledOut: true,
    perTest: 0,
  }
  return {
    schemaVersion: CURRENT_ANALYSIS_SCHEMA_VERSION,
    runId,
    verdicts: [verdict],
    parts: [{
      perTest: 0,
      groundingQuote: { stepIndex: 0, quote: 'the payment sheet never opened' },
      discriminator: 'intermittent, no persistent cause',
      nextAction: 're-run to confirm stability',
      links: [],
    }],
  }
}

const extractAnchors = (step: StepEvidence): Anchor[] =>
  (step as unknown as { anchors?: Anchor[] }).anchors ?? []

function openDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  ensureRunOutcomeTables(db)
  return db
}

interface TableDump {
  outcomes: unknown[]
  anchors: unknown[]
  appliedRuns: unknown[]
}

function dumpTables(db: DatabaseSync): TableDump {
  return {
    outcomes: db.prepare(
      'SELECT * FROM run_test_outcomes ORDER BY product, file_path, test_name',
    ).all(),
    anchors: db.prepare(
      'SELECT * FROM run_test_anchors ORDER BY product, file_path, test_name, anchor_normalized_json',
    ).all(),
    appliedRuns: db.prepare(
      'SELECT product, run_id FROM run_outcome_applied_runs ORDER BY product, run_id',
    ).all(),
  }
}

function flakeCountOf(db: DatabaseSync): number {
  const row = db.prepare(
    'SELECT flake_count FROM run_test_outcomes WHERE file_path = ? AND test_name = ?',
  ).get(FLAKY_FILE, FLAKY_TEST) as { flake_count: number } | undefined
  return Number(row?.flake_count ?? -1)
}

/** Write one run dir: `handoff.json` always, `analysis.json` only when an artifact is given. */
function writeRunDir(input: {
  runsRoot: string
  handoff: CompletedRunHandoff
  artifact?: RunAnalysisArtifact
}): string {
  const runDir = join(input.runsRoot, String(input.handoff.runId))
  mkdirSync(runDir, { recursive: true })
  writeFileSync(join(runDir, 'handoff.json'), `${canonicalJson(input.handoff)}\n`, 'utf8')
  if (input.artifact !== undefined) {
    writeFileSync(join(runDir, ANALYSIS_FILE), `${canonicalJson(input.artifact)}\n`, 'utf8')
  }
  return runDir
}

describe('the projection fold consumes resolved verdicts', () => {
  it('folds the deterministic floor when no artifact exists — an unknown failure is not a flake', () => {
    const db = openDb()
    const handoff = unknownFailureHandoff({ runId: 'run-floor-aaa', buildOrdinal: 4 })

    applyRunOutcomes(db, projectRunOutcomes(handoff, { extractAnchors }))

    expect(flakeCountOf(db)).toBe(0)
  })

  it('folds the RESOLVED class when an artifact upgrades unknown to flake', () => {
    const db = openDb()
    const runId = 'run-upgraded-bbb'
    const handoff = unknownFailureHandoff({ runId, buildOrdinal: 4 })

    applyRunOutcomes(db, projectRunOutcomes(handoff, {
      extractAnchors,
      artifact: flakeArtifact(runId),
    }))

    expect(flakeCountOf(db)).toBe(1)
  })

  it('refuses a FOREIGN-runId artifact at the loader and answers the floor', () => {
    const runsRoot = tempDir('agent-qa-resolved-foreign-')
    const knowledgeRoot = tempDir('agent-qa-foreign-knowledge-')
    const runId = 'run-own-ccc'
    const handoff = unknownFailureHandoff({ runId, buildOrdinal: 4 })
    // The file is PRESENT on the same path the admitted leg reads — only the RECORDED runId
    // differs, which is what separates identity refusal from absence. Admission lives in the
    // loader (schema owns the comparison); the pure projection takes its artifact as trusted data.
    const runDir = writeRunDir({
      runsRoot,
      handoff,
      artifact: flakeArtifact('run-somebody-elses-ddd'),
    })

    expect(foldRunOutcomes({ knowledgeRoot, handoff, runDir, extractAnchors }))
      .toEqual({ kind: 'applied', tests: 1, ...NO_DETECTION })

    const writer = openIndexWriter(knowledgeRoot)
    try {
      expect(flakeCountOf(writer.db)).toBe(0)
    } finally {
      writer.close()
    }
  })

  it('loads the run\'s own artifact from runDir on the incremental fold path', () => {
    const runsRoot = tempDir('agent-qa-resolved-fold-')
    const knowledgeRoot = tempDir('agent-qa-resolved-knowledge-')
    const runId = 'run-tail-eee'
    const handoff = unknownFailureHandoff({ runId, buildOrdinal: 6 })
    const runDir = writeRunDir({ runsRoot, handoff, artifact: flakeArtifact(runId) })

    expect(foldRunOutcomes({
      knowledgeRoot,
      handoff,
      runDir,
      extractAnchors,
    })).toEqual({ kind: 'applied', tests: 1, ...NO_DETECTION })

    const writer = openIndexWriter(knowledgeRoot)
    try {
      expect(flakeCountOf(writer.db)).toBe(1)
    } finally {
      writer.close()
    }
  })

  it('rebuilds byte-identical tables from run dirs alone over a MIXED artifact history', () => {
    const runsRoot = tempDir('agent-qa-resolved-parity-')
    const incrementalRoot = tempDir('agent-qa-parity-incremental-')
    const rebuildRoot = tempDir('agent-qa-parity-rebuild-')
    const upgraded = unknownFailureHandoff({ runId: 'run-parity-1-upgraded', buildOrdinal: 1 })
    const foreign = unknownFailureHandoff({ runId: 'run-parity-2-foreign', buildOrdinal: 2 })
    const absent = unknownFailureHandoff({ runId: 'run-parity-3-absent', buildOrdinal: 3 })

    const runDirs = [
      writeRunDir({
        runsRoot,
        handoff: upgraded,
        artifact: flakeArtifact(String(upgraded.runId)),
      }),
      writeRunDir({
        runsRoot,
        handoff: foreign,
        artifact: flakeArtifact('run-parity-foreign-source'),
      }),
      writeRunDir({ runsRoot, handoff: absent }),
    ]

    // The REAL incremental path: each run folded through foldRunOutcomes with its own runDir,
    // exactly as the curation tail calls it.
    for (const [index, handoff] of [upgraded, foreign, absent].entries()) {
      expect(foldRunOutcomes({
        knowledgeRoot: incrementalRoot,
        handoff,
        runDir: runDirs[index] as string,
        extractAnchors,
      })).toEqual({ kind: 'applied', tests: 1, ...NO_DETECTION })
    }

    const incremental = openIndexWriter(incrementalRoot)
    const rebuilt = openIndexWriter(rebuildRoot)
    try {
      // Exactly one of the three artifacts governs: the foreign one is refused by identity and
      // the third is absent, so both fold to the floor.
      expect(flakeCountOf(incremental.db)).toBe(1)

      expect(rebuildRunOutcomes(rebuilt.db, runsRoot, { extractAnchors })).toEqual({
        folded: 3,
        skippedHandoffs: 0,
        skippedArtifacts: 0,
      })
      expect(canonicalJson(dumpTables(rebuilt.db))).toBe(
        canonicalJson(dumpTables(incremental.db)),
      )
    } finally {
      rebuilt.close()
      incremental.close()
    }
  })
})
