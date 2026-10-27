// INVK-06, END TO END OVER THE SHIPPED CORE (Phase 401 plan 08 — D-15).
//
// WHERE THIS FILE LIVES, AND WHY IT IS NOT WHERE THE PLAN PUT IT. The plan names
// `packages/knowledge-local/src/projection/__tests__/gate-run-exclusion.e2e.test.ts` for BOTH
// halves. The census half is there. This half cannot be: it must drive a run through the SHIPPED
// in-process core, which lives in `packages/cli`, and `knowledge-local` neither depends on the CLI
// nor may. `packages/cli` depends on `knowledge-local`, so the differential lives on the side of
// the arrow that can see both.
//
// WHAT IS UNDER TEST is INVK-06's sentence, measured PER CENSUSED CONSUMER rather than through an
// aggregate standing in for the set:
//
//   `projectRunOutcomes`      the ONE gate — `excluded` true, member list emptied
//   `suiteFingerprintDeltas`  the CARRIED decision — no fingerprint rows from a gate run
//   `foldSuiteFingerprints`   the standalone door, which takes the decision as an argument
//   the durable tables        `run_test_outcomes` after a real production fold
//
// THE FIXTURE'S HONEST LIMIT, STATED RATHER THAN SMOOTHED OVER. A run driven here has no browser
// and no reachable model. Until 433-35 its member settled `cancelled` with no steps, which
// `countedOutcome` does not count, so both arms projected an empty member list and "the marked arm
// counted nothing" was true of a projection that counts nothing at all (401-05's Truth 3, met
// again). Since 433-35 (G-433-11) a browser that never launches FAILS its member with the cause, so
// the unmarked arm now counts that one failed member and half 1 asserts it. The member still has no
// steps, so half 2 keeps the countable member list every consumer assertion needs.
//
// So the differential is in two halves and each is measured where it can actually discriminate:
//
//   HALF 1 — TWO REAL RUNS through the production composition. What discriminates here is the
//            MARKER CHAIN and the gate's DECISION: `gateRun`/`excludedFromOutcomes` ride the
//            request onto the durable handoff (and their ABSENCE rides too), and
//            `projectRunOutcomes` over those real records answers `excluded: true` against
//            `excluded: false`.
//
//   HALF 2 — THE SAME TWO REAL HANDOFFS, given a countable member list. Everything else is the
//            shipped runs' own — run id, scope, build ordinal, execution context, and the markers
//            the core actually wrote. Now the member list can be counted, so the exclusion has
//            something to exclude and every consumer assertion has a control that fires.
//
// The substituted member is checked against the shipped recipes BEFORE it is used: a fixture that
// did not reach `countedOutcome` or `testFingerprintElements` would put half 2 back where half 1
// already is.

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { invokeFunction } from '@vostride/agent-qa-agent'
import {
  foldRunOutcomes,
  foldSuiteFingerprints,
  listTestsInFile,
  openIndexWriter,
  projectRunOutcomes,
  suiteFingerprintDeltas,
} from '@vostride/agent-qa-knowledge-local'
import { exercisedAnchors, testFingerprintElements } from '@vostride/agent-qa-schema'
import type {
  CompletedRunHandoff,
  PerTestOutcome,
  RunStartAcknowledgement,
  RunsStartInput,
} from '@vostride/agent-qa-schema'

import { CLI_FUNCTION_CALLER, composeCliLocalAgent } from '../local-agent-host.js'
import {
  CountingTarget,
  createInProcessFixture,
  runDirs,
  removeInProcessFixtures,
} from './in-process-run-fixture.js'
import { pinProcessTmpdir, removeTempRoots } from '../../__tests__/temp-roots.js'
import type { PinnedTmpdir } from '../../__tests__/temp-roots.js'

let pinnedTmpdir: PinnedTmpdir | undefined
beforeAll(() => { pinnedTmpdir = pinProcessTmpdir() })
afterAll(() => {
  pinnedTmpdir?.restore()
  if (pinnedTmpdir !== undefined) removeTempRoots([pinnedTmpdir.root])
})

afterAll(() => { removeInProcessFixtures() })

type Fixture = ReturnType<typeof createInProcessFixture>

const COUNTED_FILE = 'tests/counted.yaml'
const COUNTED_NAME = 'a member with evidence on it'

/**
 * One member the projection can actually count, and that the fingerprint recipe can read.
 *
 * `outcome: 'failed'` is a counted outcome (`passed`/`healed`/`failed`/`timeout` are; `skipped`
 * and `cancelled` are not). The sub-action resolves an element and reports success, which is what
 * `testFingerprintElements` requires to mint an element. Both facts are ASSERTED against the
 * shipped recipes in the integrity cell before any exclusion claim is made.
 */
function countableMember(): PerTestOutcome {
  return {
    testId: 't_counted',
    testName: COUNTED_NAME,
    filePath: COUNTED_FILE,
    testIndex: 0,
    outcome: 'failed',
    steps: [
      {
        stepIndex: 0,
        stepText: 'Click the Submit button',
        cacheStatus: 'miss',
        servedBrief: {
          scope: { tier: 'product', key: 'in-process-thing' },
          asOfBuild: 1,
          budget: 1,
          truncation: 'none',
          channel1: [],
          channel2: [],
          channel3: [],
        },
        subActions: [
          {
            plan: 'plan click',
            plannedAction: { type: 'click', ref: 'e1' },
            stateBefore: {
              platform: 'web',
              tree: '',
              elements: [
                {
                  ref: 'e1',
                  role: 'button',
                  name: 'submit',
                  nameNormalized: 'submit',
                  state: { enabled: true, focused: false, visible: true },
                  labels: {},
                  attributes: {},
                },
              ],
              refMap: {},
              timestamp: 0,
              metadata: {},
              url: 'http://127.0.0.1:8931/form.html',
            },
            result: { success: true },
          },
        ],
        verifierVerdict: { pass: false, reasoning: 'the banner did not appear' },
      },
    ],
  } as unknown as PerTestOutcome
}

/** The shipped run's own record, with a countable member list put on it. */
function withCountableMembers(handoff: CompletedRunHandoff): CompletedRunHandoff {
  return { ...handoff, tests: [countableMember()] } as CompletedRunHandoff
}

/** The run's own durable record, read off disk under the id the door acknowledged. */
function handoffFor(fixture: Fixture, runId: string): CompletedRunHandoff {
  for (const dir of runDirs(fixture)) {
    const path = join(dir, 'handoff.json')
    if (!existsSync(path)) continue
    const document = JSON.parse(readFileSync(path, 'utf8')) as CompletedRunHandoff
    if (String(document.runId) === runId) return document
  }
  throw new Error(`no handoff on disk for run ${runId}`)
}

/**
 * Drive `runs.start` through the SHIPPED host and hand back the run's durable record.
 *
 * The target is declared `local`, so the run gate allows on its TIER — this file is about the
 * exclusion, and a denial would leave no record to project. Everything else is the production
 * composition: no `runExecution`, no producer, no assembler.
 */
async function driveRun(fixture: Fixture, request: RunsStartInput): Promise<CompletedRunHandoff> {
  // An empty browsers root, so the run's shape is a property of the fixture and not of the machine
  // (401-05's idiom). It makes the member `failed` with no steps (433-35; it was `cancelled`).
  process.env.PLAYWRIGHT_BROWSERS_PATH = join(fixture.project, 'no-browsers')
  const { registry } = composeCliLocalAgent({
    agentQaRoot: fixture.agentQaRoot,
    configPath: fixture.configPath,
    resolveExecutionContext: () => 'local-headless',
  })
  const ack = await invokeFunction(
    registry,
    'runs.start',
    request,
    CLI_FUNCTION_CALLER,
  ) as RunStartAcknowledgement
  return handoffFor(fixture, String(ack.runId))
}

function project(handoff: CompletedRunHandoff) {
  return projectRunOutcomes(handoff, { extractAnchors: exercisedAnchors })
}

/** Fold one run into a fresh knowledge root through the production entry, and read the table back. */
function foldedRows(
  fixture: Fixture,
  handoff: CompletedRunHandoff,
  rootName: string,
  product: string,
): unknown[] {
  const knowledgeRoot = join(fixture.project, rootName)
  foldRunOutcomes({ knowledgeRoot, handoff, extractAnchors: exercisedAnchors })
  const handle = openIndexWriter(knowledgeRoot)
  try {
    return listTestsInFile(handle.db, { product, filePath: COUNTED_FILE })
  } finally {
    handle.close()
  }
}

describe('a gate run reaches no counter and no candidacy input (INVK-06, D-15)', () => {
  it('THE SUBSTITUTED MEMBER REACHES THE RECIPES IT CLAIMS TO', () => {
    // Half 2 is worth nothing if its member cannot be counted or fingerprinted, so this is asserted
    // through the SHIPPED recipes rather than believed. `suiteFingerprintDeltas` is the same
    // function the fold uses; `projectRunOutcomes` over a synthetic unmarked handoff is the same
    // gate. Neither answer is spelled as a literal here.
    const member = countableMember()
    expect(testFingerprintElements(member).length).toBeGreaterThan(0)
    expect(suiteFingerprintDeltas([member])).toHaveLength(1)
  })

  it('HALF 1 — TWO REAL RUNS: the marker chain is lossless, and an INTERRUPTED gate run keeps it', async () => {
    const target = new CountingTarget()
    await target.listen()
    try {
      const fixture = createInProcessFixture({ origin: target.origin, environment: 'local' })

      // ARM A: exactly what `stability-gates.ts` puts on the wire for a keep-filter gate run.
      const marked = await driveRun(fixture, {
        patterns: [fixture.testPattern],
        gateRun: true,
        excludedFromOutcomes: true,
      })
      // ARM B: the control. Two fields different, nothing else.
      const unmarked = await driveRun(fixture, { patterns: [fixture.testPattern] })

      expect(String(marked.runId)).not.toBe(String(unmarked.runId))

      // THE PRECISION EDGE. request → RunConfig → handoff, with no argv in between since 401-03.
      // `true` carries and ABSENCE carries — a `false` is a refusal at every carrier, not a synonym
      // for absence — so the assertion is made in both directions on both fields.
      expect(marked.gateRun).toBe(true)
      expect(marked.excludedFromOutcomes).toBe(true)
      expect(unmarked.gateRun).toBeUndefined()
      expect(unmarked.excludedFromOutcomes).toBeUndefined()

      // THE ONE GATE, over the real records. This is the assertion that discriminates on THIS
      // fixture: the decision differs even though both member lists are uncountable.
      expect(project(marked).excluded).toBe(true)
      expect(project(unmarked).excluded).toBe(false)

      // Since 433-35 the unmarked arm's member is countable: the launch failure is a failed member,
      // so the gate excludes something real here. It has no steps, which is why half 2 exists.
      expect(project(unmarked).tests.map((test) => test.passed)).toEqual([false])

      // ---- THE INTERRUPTED GATE RUN (INVK-06's concurrency edge) ------------------------------
      //
      // This plan filed that edge as a BACKSTOP truth. Until 433-35 half of it was measured here
      // for free, because a browser that never launched cancelled the run. Nobody cancelled it, so
      // since 433-35 (G-433-11) the run's aggregate verdict is `failed` and the interrupted case is
      // a backstop again. What is still asserted here is that the marker survives on a run that did
      // not pass, and that the run contributes nothing.
      //
      // WHAT IT STILL DOES NOT RANGE, stated rather than implied: the ABSENT-handoff arm — a run
      // that left no handoff at all cannot be handed to `projectRunOutcomes`, so "it contributes
      // nothing" is a statement about the fold's input being absent rather than about a decision
      // the fold makes. That half stays a backstop.
      expect(marked.aggregateVerdict).toBe('failed')
      expect(marked.excludedFromOutcomes).toBe(true)
      expect(project(marked).tests).toEqual([])
      expect(project(marked).fingerprints).toEqual([])
    } finally {
      await target.close()
    }
  }, 300_000)

  it('HALF 2 — THE SAME RECORDS, COUNTABLE: every censused consumer excludes the gate run', async () => {
    const target = new CountingTarget()
    await target.listen()
    try {
      const fixture = createInProcessFixture({ origin: target.origin, environment: 'local' })

      const markedRun = await driveRun(fixture, {
        patterns: [fixture.testPattern],
        gateRun: true,
        excludedFromOutcomes: true,
      })
      const unmarkedRun = await driveRun(fixture, { patterns: [fixture.testPattern] })

      // The shipped runs' own records — id, scope, build ordinal, execution context, and the
      // markers the CORE wrote — with a member list the projection can count.
      const marked = withCountableMembers(markedRun)
      const unmarked = withCountableMembers(unmarkedRun)
      expect(marked.excludedFromOutcomes).toBe(true)
      expect(unmarked.excludedFromOutcomes).toBeUndefined()

      const markedProjection = project(marked)
      const unmarkedProjection = project(unmarked)

      // ---- consumer 1: `projectRunOutcomes`, THE one exclusion gate --------------------------
      expect(markedProjection.excluded).toBe(true)
      expect(markedProjection.tests).toEqual([])
      expect(unmarkedProjection.excluded).toBe(false)
      expect(unmarkedProjection.tests).toHaveLength(1)

      // ---- consumer 2: the CARRIED fingerprint decision ---------------------------------------
      //
      // Not a second read of the marker: the deltas are computed from the member list the gate
      // already emptied. The discriminating line is the third one — the SAME function over the
      // handoff's own members IS non-empty, so the fingerprints are absent because the gate
      // emptied the list, not because this run had nothing to fingerprint.
      expect(markedProjection.fingerprints).toEqual([])
      expect(unmarkedProjection.fingerprints).toHaveLength(1)
      expect(suiteFingerprintDeltas(marked.tests ?? [])).toHaveLength(1)

      // ---- consumer 3: the standalone fingerprint door ----------------------------------------
      const doorHandle = openIndexWriter(join(fixture.project, 'fingerprint-door-knowledge'))
      try {
        expect(foldSuiteFingerprints(doorHandle.db, marked, {
          product: markedProjection.product,
          excluded: markedProjection.excluded,
        }).tests).toEqual([])
        expect(foldSuiteFingerprints(doorHandle.db, unmarked, {
          product: unmarkedProjection.product,
          excluded: unmarkedProjection.excluded,
        }).tests).toHaveLength(1)
      } finally {
        doorHandle.close()
      }

      // ---- consumer 4: the DURABLE tables, after a real production fold -----------------------
      //
      // The candidacy substrate itself, not a projection object. Each run folds into its OWN
      // knowledge root through `foldRunOutcomes` — the entry the curation tail calls — and the read
      // port answers what ended up in `run_test_outcomes`.
      expect(foldedRows(fixture, marked, 'marked-knowledge', markedProjection.product)).toEqual([])
      expect(foldedRows(fixture, unmarked, 'unmarked-knowledge', unmarkedProjection.product))
        .toHaveLength(1)
    } finally {
      await target.close()
    }
  }, 300_000)
})
