// Where an ABSENT `scope` is resolved, and where it is NOT.
//
// 394-22 established the two-sided law for `sessionRef`: the registry contract optionalizes, the
// host supplies, and the model-facing projection says so. `scope` is the same class one field
// over — a live planner refused `authoring.draft.write` by name because a required `{tier, key}`
// is a field it cannot know. The registry half is measured in
// `packages/schema/src/functions/__tests__/authoring-write-contract.test.ts` and the derivation
// itself in `packages/cli/src/__tests__/authoring-scope-derivation.test.ts`; what is measured HERE
// is the seam between them — the op resolves before the loop, exactly once, and never when the
// caller supplied a scope of its own.
//
// THE OBSERVABLE IS `getAuthoringBrief`'s SECOND ARGUMENT. The loop reads the brief at the scope
// it was handed, so what the read half saw IS what the loop ran at — a counter on the deriver
// alone could not tell a resolution that happened from one that was thrown away.
//
// THE ASSERTION IS THE RULE, NOT THE COUNT (WR-05's posture, applied here). One invocation reads
// the brief at TWO call sites — `loop.ts` for the compile and `refine.ts` for the refine pass —
// and both read `AuthoringLoopInput.scope`. A cell pinning "one read" would state today's call
// graph rather than the law, and would red on a correct edit that added a third read. What must
// hold is that EVERY read happened at the resolved scope, and that at least one happened.

import {
  CURRENT_DRAFT_RECEIPT_SCHEMA_VERSION,
  DRAFT_STABILITY_RUNS_N,
  DraftReceiptSchema,
} from '@vostride/agent-qa-schema'
import type { DraftReceipt, ScopeKey } from '@vostride/agent-qa-schema'
import { describe, expect, it } from 'vitest'

import { authoringDraftWriteSpec } from '../ops/authoring-draft-write.js'
import { FunctionNotBoundError } from '../spec.js'
import type { FunctionDeps } from '../spec.js'
import type { DraftStageOutcome, ParsedDraftLike } from '../../authoring/ports.js'

const DRAFT_PATH = 'tests/.agent-qa-drafts/scope-fixture.yaml'
const DRAFT_NAME = 'Submit the local account form'
const MODEL_DOCUMENT = 'name: Submit the local account form\nsteps:\n  - a\n'

const DRAFT: ParsedDraftLike = {
  testId: DRAFT_NAME,
  filePath: DRAFT_PATH,
  testName: DRAFT_NAME,
  // The name the read double below serves as this project's only configured target.
  target: 'local-form',
  steps: ['Open the local account form', 'Verify the confirmation banner says "Saved"'],
  contentDigest: 'digest-scope-0',
}

const GATE_RUN_IDS = ['r_gate-0', 'r_gate-1', 'r_gate-2'] as const

/** Parsed rather than typed as a literal, on the sibling file's produced-not-literal reasoning. */
const ACCEPTED: DraftReceipt = DraftReceiptSchema.parse({
  schemaVersion: CURRENT_DRAFT_RECEIPT_SCHEMA_VERSION,
  draftRef: {
    filePath: DRAFT_PATH,
    testId: DRAFT_NAME,
    testName: DRAFT_NAME,
    contentDigest: 'digest-scope-0',
  },
  gates: {
    executesDefinitive: { pass: true, runRefs: [...GATE_RUN_IDS], indefinitiveRunRefs: [] },
    stableVerdict: {
      pass: true,
      runRefs: [...GATE_RUN_IDS],
      distinctOutcomes: ['passed'],
      earlyStopped: false,
    },
    addsValue: { pass: true, novelElementCount: 1, comparedTestCount: 1 },
    falsifiableAssertion: { pass: true, assertionStepCount: 1, falsifiableAssertionCount: 1 },
  },
  stepTable: [],
  gateRuns: GATE_RUN_IDS.map((runId) => ({
    runId,
    memberOutcome: 'passed',
    definitive: true,
    healed: false,
  })),
  addsValueFinding: { novelElements: ['el:button "submit"'], comparedTests: [] },
  stabilityRunsRequested: DRAFT_STABILITY_RUNS_N,
  stabilityRunsCompleted: GATE_RUN_IDS.length,
  disposition: 'keep-eligible',
  evaluatedAt: 1,
})

const DERIVED: ScopeKey = { tier: 'product', key: 'derived-product' }
const EXPLICIT: ScopeKey = { tier: 'suite', key: 'checkout' }

interface Trace {
  /** Every scope the READ half was asked for a brief at — what the loop actually ran at. */
  readonly briefScopes: ScopeKey[]
  /** How many times the ONE deriver was consulted. */
  derivations: number
}

function harness(options: { readonly unboundDeriver?: true } = {}): {
  readonly deps: FunctionDeps
  readonly trace: Trace
} {
  const documents = new Map<string, { endedAt: number }>()
  GATE_RUN_IDS.forEach((runId, index) => documents.set(runId, { endedAt: 100 + index }))

  const trace: Trace = { briefScopes: [], derivations: 0 }

  const deps = {
    ...(options.unboundDeriver === true ? {} : {
      authoringScope: {
        deriveDefault: () => {
          trace.derivations += 1
          return Promise.resolve(DERIVED)
        },
      },
    }),
    authoringProposals: { put: () => Promise.resolve({ proposalId: 'prop_scope-0' }) },
    draftShelf: {
      runs: {
        start: () => { throw new Error('no cell in this file starts a run') },
        get: (runId: string) => Promise.resolve(documents.get(runId)),
      },
      model: () => Promise.resolve({
        modelId: 'fixture:scope',
        generate: () => Promise.resolve({ text: MODEL_DOCUMENT }),
      }),
      write: () => Promise.resolve({ kind: 'staged', draft: DRAFT } as DraftStageOutcome),
      applyPatches: (candidate: ParsedDraftLike) =>
        Promise.resolve({ kind: 'staged' as const, draft: candidate }),
      verifyDraft: () => Promise.resolve(ACCEPTED),
      publish: (request: { readonly targetPath: string }) => Promise.resolve({
        kind: 'written' as const,
        filePath: request.targetPath,
        contentDigest: DRAFT.contentDigest,
      }),
    },
    authoringRead: {
      getAuthoringBrief: (_intent: string, scope: ScopeKey) => {
        trace.briefScopes.push(scope)
        return Promise.resolve({ scope, facts: [], cautions: [], procedures: [], exemplars: [] })
      },
      suiteTextCorpus: () => Promise.resolve([]),
      // the `target` vocabulary. This file's subject is the SCOPE derivation, and
      // the two are deliberately different values — see the port's own doc.
      configuredTargetNames: () => Promise.resolve(['local-form']),
    },
  } as unknown as FunctionDeps

  return { deps, trace }
}

const INTENT = 'Check that submitting the local account form shows the confirmation banner'

/**
 * How many briefs were read, and the DISTINCT scopes they were read at.
 *
 * The count rides beside the set because the set alone is vacuous: an invocation that read no
 * brief at all has an empty distinct set, which an "every read was at X" claim would satisfy
 * perfectly while measuring nothing.
 */
function briefReads(trace: Trace): { readonly reads: number; readonly distinct: ScopeKey[] } {
  const seen = new Map<string, ScopeKey>()
  for (const scope of trace.briefScopes) seen.set(JSON.stringify([scope.tier, scope.key]), scope)
  return { reads: trace.briefScopes.length, distinct: [...seen.values()] }
}

describe('authoring.draft.write resolves an absent scope BEFORE the loop', () => {
  it('derives once and runs the loop at the derived scope', async () => {
    const { deps, trace } = harness()

    const output = await authoringDraftWriteSpec.invoke({ intent: INTENT }, deps)

    expect((output as { outcome: string }).outcome).toBe('drafted')
    // EXACTLY ONCE. A deriver consulted per stage would read the workspace repeatedly during one
    // invocation and could answer differently inside a single loop.
    expect(trace.derivations).toBe(1)
    // And the resolution REACHED the loop rather than being computed and discarded: every brief
    // this invocation read was read at the derived scope, which is the scope the compile prompt
    // names.
    expect(briefReads(trace).distinct).toEqual([DERIVED])
    expect(briefReads(trace).reads).toBeGreaterThan(0)
  })

  it('CONTROL: an explicit scope reaches the loop unchanged and the deriver is never consulted',
    async () => {
      const { deps, trace } = harness()

      const output = await authoringDraftWriteSpec.invoke(
        { intent: INTENT, scope: EXPLICIT },
        deps,
      )

      expect((output as { outcome: string }).outcome).toBe('drafted')
      // THE BLAST-RADIUS CONTROL. Every caller that already supplies a scope — the CLI `fn`
      // surface, 396's MCP projection, the loop's own tests — must be on exactly the path it was
      // on before. A count of 0 is the only reading of that claim a later edit cannot fake.
      expect(trace.derivations).toBe(0)
      expect(briefReads(trace).distinct).toEqual([EXPLICIT])
      expect(briefReads(trace).reads).toBeGreaterThan(0)
    })

  it('a host with NO deriver and no supplied scope refuses BY NAME, never by default', async () => {
    // The never-a-silent-default arm, in the same named error family the three-halves check uses.
    // A host that cannot resolve a scope must say so where the composition forgot it, rather than
    // author against whatever a fallback happened to pick.
    const { deps, trace } = harness({ unboundDeriver: true })

    let caught: unknown
    try {
      await authoringDraftWriteSpec.invoke({ intent: INTENT }, deps)
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(FunctionNotBoundError)
    expect((caught as Error).message).toContain('authoring.draft.write')
    // NOTHING RAN. The refusal is at the top, before a single child run is spent.
    expect(trace.briefScopes).toEqual([])
  })

  it('CONTROL: a host with no deriver still authors when the caller supplied a scope', async () => {
    // The two-sided half of the cell above. A refusal written outside the absence narrow would
    // break every host that never binds a deriver but always supplies a scope.
    const { deps, trace } = harness({ unboundDeriver: true })

    const output = await authoringDraftWriteSpec.invoke({ intent: INTENT, scope: EXPLICIT }, deps)

    expect((output as { outcome: string }).outcome).toBe('drafted')
    expect(briefReads(trace).distinct).toEqual([EXPLICIT])
    expect(briefReads(trace).reads).toBeGreaterThan(0)
  })
})
