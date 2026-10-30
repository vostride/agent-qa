// The accept control end to end: all four gate booleans, the disposition and the persisted bytes.

import {
  computeDraftDisposition,
  DRAFT_GATE_NAMES,
  DRAFT_STABILITY_RUNS_N,
  DraftReceiptSchema,
} from '@vostride/agent-qa-schema'
import type { DraftReceipt } from '@vostride/agent-qa-schema'
import { describe, expect, it } from 'vitest'

import {
  ACCEPT_CONTROL_DRAFT,
  ACCEPT_CONTROL_SUBACTIONS,
  acceptControlMember,
  expectedElement,
  fakeFingerprintIndex,
  fakeRunPort,
} from './evidence-fixtures.js'
import { DraftEvaluationPortNotBoundError, evaluateDraft } from '../verify-draft.js'
import { GateRunNotFlaggedError } from '../stability-gates.js'

const USERNAME_ELEMENT = expectedElement(ACCEPT_CONTROL_SUBACTIONS[0]![0]!)
const HEADING_ELEMENT = expectedElement(ACCEPT_CONTROL_SUBACTIONS[1]![0]!)

/**
 * The suite as the accept control meets it: local-form covers the Username field, and NOTHING
 * covers the page heading. That single missing element is what `expectations.json` says gate 3
 * turns on for this draft, so the union is built to be missing exactly it and nothing else.
 */
function suiteIndexMissingTheHeading() {
  return fakeFingerprintIndex([
    {
      filePath: 'demo/init/tests/local-form.yaml',
      testName: 'Sign in on the local account form',
      elements: [USERNAME_ELEMENT],
    },
  ])
}

function inMemoryStore() {
  const written: DraftReceipt[] = []
  return { written, put: async (receipt: DraftReceipt) => void written.push(receipt) }
}

describe('evaluateDraft — the tracer path', () => {
  it('takes the accept control to four true booleans, keep-eligible, and a persisted receipt', async () => {
    const runs = fakeRunPort({
      runs: [[acceptControlMember()], [acceptControlMember()], [acceptControlMember()]],
    })
    const store = inMemoryStore()

    const receipt = await evaluateDraft(
      { draft: ACCEPT_CONTROL_DRAFT },
      {
        runs,
        fingerprints: suiteIndexMissingTheHeading(),
        textCorpus: [],
        receipts: store,
        now: () => 1_700_000_000_000,
      },
    )

    expect(receipt.gates.executesDefinitive.pass).toBe(true)
    expect(receipt.gates.stableVerdict.pass).toBe(true)
    expect(receipt.gates.addsValue.pass).toBe(true)
    expect(receipt.gates.falsifiableAssertion.pass).toBe(true)
    expect(receipt.disposition).toBe('keep-eligible')
    expect(receipt.stabilityRunsRequested).toBe(DRAFT_STABILITY_RUNS_N)
    expect(receipt.stabilityRunsCompleted).toBe(DRAFT_STABILITY_RUNS_N)
  })

  it('reports every gate the vocabulary names — no gate is skipped', async () => {
    const runs = fakeRunPort({
      runs: [[acceptControlMember()], [acceptControlMember()], [acceptControlMember()]],
    })
    const receipt = await evaluateDraft(
      { draft: ACCEPT_CONTROL_DRAFT },
      {
        runs,
        fingerprints: suiteIndexMissingTheHeading(),
        textCorpus: [],
        receipts: inMemoryStore(),
      },
    )

    expect(Object.keys(receipt.gates).sort()).toEqual([...DRAFT_GATE_NAMES].sort())
  })

  it('persists the receipt it returns, and the bytes survive the strict schema', async () => {
    const store = inMemoryStore()
    const receipt = await evaluateDraft(
      { draft: ACCEPT_CONTROL_DRAFT },
      {
        runs: fakeRunPort({
          runs: [[acceptControlMember()], [acceptControlMember()], [acceptControlMember()]],
        }),
        fingerprints: suiteIndexMissingTheHeading(),
        textCorpus: [],
        receipts: store,
      },
    )

    expect(store.written).toHaveLength(1)
    expect(store.written[0]).toBe(receipt)
    // The schema is what the durable store validates on the way in AND out, so a receipt that
    // only satisfies its TypeScript type is not yet a receipt (types are erased; `.strict()` is not).
    expect(DraftReceiptSchema.safeParse(JSON.parse(JSON.stringify(receipt))).success).toBe(true)
  })

  it('names the uncovered element rather than counting it', async () => {
    const receipt = await evaluateDraft(
      { draft: ACCEPT_CONTROL_DRAFT },
      {
        runs: fakeRunPort({
          runs: [[acceptControlMember()], [acceptControlMember()], [acceptControlMember()]],
        }),
        fingerprints: suiteIndexMissingTheHeading(),
        textCorpus: [],
        receipts: inMemoryStore(),
      },
    )

    expect(receipt.addsValueFinding.novelElements).toEqual([HEADING_ELEMENT])
    expect(receipt.addsValueFinding.novelElements[0]).toContain('heading')
  })

  /**
   * The falsifier for the gate-3 lane itself.
   *
   * The accept control passes gate 3 because ONE element is missing from the union. Put that
   * element in, change nothing else, and the gate must go false and take the disposition with it.
   * Without this case the suite cannot tell a working set comparison from an evaluator that
   * returns `addsValue: true` unconditionally — which is exactly what a draft side derived from
   * step text rather than from evidence would produce, since a text-invented anchor matches a
   * resolved one only by accident.
   */
  it('returns addsValue FALSE when the suite union already holds every element', async () => {
    const receipt = await evaluateDraft(
      { draft: ACCEPT_CONTROL_DRAFT },
      {
        runs: fakeRunPort({
          runs: [[acceptControlMember()], [acceptControlMember()], [acceptControlMember()]],
        }),
        fingerprints: fakeFingerprintIndex([
          {
            filePath: 'demo/init/tests/local-form.yaml',
            testName: 'Sign in on the local account form',
            elements: [USERNAME_ELEMENT, HEADING_ELEMENT],
          },
        ]),
        textCorpus: [],
        receipts: inMemoryStore(),
      },
    )

    expect(receipt.gates.addsValue.pass).toBe(false)
    expect(receipt.addsValueFinding.novelElements).toEqual([])
    // The one suite test subsumes every element the draft exercised, and the row says so.
    expect(receipt.addsValueFinding.comparedTests).toEqual([{
      filePath: 'demo/init/tests/local-form.yaml',
      testName: 'Sign in on the local account form',
      lane: 'fingerprint',
      covered: true,
    }])
    // The other three gates are unmoved — gate 3 is demonstrably the only catcher here.
    expect(receipt.gates.executesDefinitive.pass).toBe(true)
    expect(receipt.gates.stableVerdict.pass).toBe(true)
    expect(receipt.gates.falsifiableAssertion.pass).toBe(true)
    expect(receipt.disposition).toBe('rejected')
  })

  it('sets BOTH gate-run markers on every start input the run port saw', async () => {
    const runs = fakeRunPort({
      runs: [[acceptControlMember()], [acceptControlMember()], [acceptControlMember()]],
    })
    await evaluateDraft(
      { draft: ACCEPT_CONTROL_DRAFT },
      {
        runs,
        fingerprints: suiteIndexMissingTheHeading(),
        textCorpus: [],
        receipts: inMemoryStore(),
      },
    )

    expect(runs.startInputs).toHaveLength(DRAFT_STABILITY_RUNS_N)
    for (const input of runs.startInputs) {
      expect(input.gateRun).toBe(true)
      expect(input.excludedFromOutcomes).toBe(true)
      expect(input.patterns).toEqual([ACCEPT_CONTROL_DRAFT.filePath])
    }
  })

  it('refuses to keep running when the host does not accept the run as a gate-run', async () => {
    const runs = fakeRunPort({ runs: [[acceptControlMember()]], dropMarkers: true })

    await expect(evaluateDraft(
      { draft: ACCEPT_CONTROL_DRAFT },
      {
        runs,
        fingerprints: suiteIndexMissingTheHeading(),
        textCorpus: [],
        receipts: inMemoryStore(),
      },
    )).rejects.toBeInstanceOf(GateRunNotFlaggedError)

    // One run attempted, then stopped: an unflagged gate-run corrupts a derived index that
    // accumulates, so taking the remaining two would compound damage nothing can detect later.
    expect(runs.startInputs).toHaveLength(1)
  })

  it('counts a healed pass as a pass and records the heal', async () => {
    const receipt = await evaluateDraft(
      { draft: ACCEPT_CONTROL_DRAFT },
      {
        runs: fakeRunPort({
          runs: [[acceptControlMember('healed')], [acceptControlMember('healed')], [acceptControlMember('healed')]],
        }),
        fingerprints: suiteIndexMissingTheHeading(),
        textCorpus: [],
        receipts: inMemoryStore(),
      },
    )

    expect(receipt.gates.executesDefinitive.pass).toBe(true)
    expect(receipt.gateRuns.every((row) => row.memberOutcome === 'healed')).toBe(true)
    expect(receipt.gateRuns.every((row) => row.definitive && row.healed)).toBe(true)
    // The comparison folds `healed` into `passed`, so a run of heals is ONE verdict, not three.
    expect(receipt.gates.stableVerdict.distinctOutcomes).toEqual(['passed'])
  })

  it('forces `unverified` in draft mode with exactly one run consumed', async () => {
    const runs = fakeRunPort({ runs: [[acceptControlMember()]] })
    const receipt = await evaluateDraft(
      { draft: ACCEPT_CONTROL_DRAFT, draftMode: true },
      {
        runs,
        fingerprints: suiteIndexMissingTheHeading(),
        textCorpus: [],
        receipts: inMemoryStore(),
      },
    )

    expect(runs.startInputs).toHaveLength(1)
    expect(receipt.stabilityRunsRequested).toBe(1)
    // Every gate still true — the disposition is forced by the RULE, not by a failing gate.
    expect(receipt.gates.executesDefinitive.pass).toBe(true)
    expect(receipt.gates.stableVerdict.pass).toBe(true)
    expect(receipt.gates.addsValue.pass).toBe(true)
    expect(receipt.gates.falsifiableAssertion.pass).toBe(true)
    expect(receipt.disposition).toBe('unverified')
  })

  it('takes its disposition from computeDraftDisposition and nowhere else', async () => {
    const receipt = await evaluateDraft(
      { draft: ACCEPT_CONTROL_DRAFT },
      {
        runs: fakeRunPort({
          runs: [[acceptControlMember()], [acceptControlMember()], [acceptControlMember()]],
        }),
        fingerprints: suiteIndexMissingTheHeading(),
        textCorpus: [],
        receipts: inMemoryStore(),
      },
    )

    // Recomputed from the receipt's OWN published fields. If the module ever grew a local
    // derivation that disagreed with the schema function, these two would diverge here.
    expect(receipt.disposition).toBe(computeDraftDisposition({
      gates: {
        executesDefinitive: receipt.gates.executesDefinitive.pass,
        stableVerdict: receipt.gates.stableVerdict.pass,
        addsValue: receipt.gates.addsValue.pass,
        falsifiableAssertion: receipt.gates.falsifiableAssertion.pass,
      },
      stabilityRunsRequested: receipt.stabilityRunsRequested,
      stabilityRunsCompleted: receipt.stabilityRunsCompleted,
    }))
  })

  it('carries refs, never run payloads or resolved step text', async () => {
    const receipt = await evaluateDraft(
      { draft: ACCEPT_CONTROL_DRAFT },
      {
        runs: fakeRunPort({
          runs: [[acceptControlMember()], [acceptControlMember()], [acceptControlMember()]],
        }),
        fingerprints: suiteIndexMissingTheHeading(),
        textCorpus: [],
        receipts: inMemoryStore(),
      },
    )

    const serialized = JSON.stringify(receipt)
    expect(receipt.gateRuns.map((row) => row.runId)).toEqual(['r_fixture-0', 'r_fixture-1', 'r_fixture-2'])
    // The run documents carry screen states, planned actions and verifier reasoning. None of it
    // may reach the durable receipt.
    expect(serialized).not.toContain('stateBefore')
    expect(serialized).not.toContain('verifierVerdict')
    expect(serialized).not.toContain('servedBrief')
    // The step table carries the DRAFT's pre-interpolation text, which is the corpus's own bytes.
    expect(receipt.stepTable.map((row) => row.stepText)).toEqual([...ACCEPT_CONTROL_DRAFT.steps])
  })

  it('refuses by name when a capability is not bound in the composition', async () => {
    await expect(evaluateDraft(
      { draft: ACCEPT_CONTROL_DRAFT },
      {
        runs: undefined as never,
        fingerprints: suiteIndexMissingTheHeading(),
        textCorpus: [],
        receipts: inMemoryStore(),
      },
    )).rejects.toBeInstanceOf(DraftEvaluationPortNotBoundError)
  })
})
