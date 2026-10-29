import {
  DELTA_ORIGINS,
  type Delta,
  type DeltaOrigin,
  type ExecutionContext,
  type ScopeKey,
} from '@vostride/agent-qa-schema'
import { describe, expect, it } from 'vitest'
import { ZodError } from 'zod'

import {
  AUTHORED_CHECKPOINT_SCHEMA_VERSION,
  authoredCheckpointSchema,
  parseAuthoredCheckpoint,
  resolveDispositionProfile,
} from '../../index.js'

const scope: ScopeKey = { tier: 'product', key: 'storefront' }

// The expectation table below is declared INDEPENDENTLY of
// `AUTHORED_CHECKPOINT_ORIGIN_ADMISSION`, on 387-14's pattern-3 discipline: a corpus that
// imported the production mapping and asserted against itself would be a tautology no mutation
// could red. Probe m1 (restoring an unconditional four-origin admission) has to red the three
// rejection rows.
//
// RED BASELINE, observed against unmodified author-contract.ts before the admission table
// landed — `parseAuthoredCheckpoint` accepted every member of DELTA_ORIGINS:
//
//   FAIL … > user-origin deltas may not arrive through the drain's authored boundary
//   FAIL … > import-origin deltas may not arrive through the drain's authored boundary
//   FAIL … > system-origin deltas may not arrive through the drain's authored boundary
//   AssertionError: a persisted non-agent checkpoint re-enters commitCurationDelta on every
//     drain and is refused deterministically, so admitting it converts one bad file into a
//     permanent drain stopper: expected [Function] to throw an error
//   FAIL … > a non-agent origin at a LATER array position is rejected too
//   AssertionError: the admission is per delta, not per checkpoint: expected undefined to be an
//     instance of ZodError
//
//   Test Files  1 failed (1)
//        Tests  4 failed | 6 passed (10)
//
// The agent row, the agent round-trip admit control, and all FOUR structural-schema separation
// controls were green throughout — the preservation half.
describe('the drain authored-checkpoint boundary admits origins from a total table', () => {
  type OriginAdmission = 'parses' | 'rejects'

  /**
   * Which origins may arrive as DRAIN-AUTHORED curator output, declared locally.
   *
   * This is NOT the same question as `AUTONOMOUS_DEPRECATE_BY_ORIGIN` in disposition.ts, which
   * asks who may tombstone standing knowledge. `system` is 'allow' there and 'rejects' here, and
   * the two are consistent because rollback's inverse Deprecate and the canary Confirm reach
   * `disposeDelta` through in-process checkpoints built as plain objects (`maintenanceCheckpoint`
   * in rollback.ts, `bridgeDelta` in knowledge-store.ts) — neither is ever parsed at this
   * boundary. See 387-20 D-3 for the producer enumeration that establishes it.
   *
   * The rejection of `user` is what makes the OTHER table's `user: 'allow'` safe rather than
   * reckless: the floor trusts a user-origin Deprecate to tombstone a live record precisely
   * because this boundary guarantees the model cannot mint one.
   */
  const EXPECTED_ADMISSION_BY_ORIGIN = {
    agent: 'parses',
    user: 'rejects',
    import: 'rejects',
    system: 'rejects',
  } satisfies Record<DeltaOrigin, OriginAdmission>

  function noopDelta(origin: DeltaOrigin): Delta {
    return { kind: 'Noop', origin, scope, citedIds: [] }
  }

  function checkpointOf(...deltas: Delta[]): unknown {
    return {
      schemaVersion: AUTHORED_CHECKPOINT_SCHEMA_VERSION,
      deltas,
      neighborIds: [],
      preconditions: [],
      authorship: {
        path: 'llm',
        model: { id: 'curator-model' },
        executionContext: 'local-interactive',
      },
    }
  }

  for (const origin of DELTA_ORIGINS) {
    const expected = EXPECTED_ADMISSION_BY_ORIGIN[origin]
    it(`${origin}-origin deltas ${
      expected === 'parses' ? 'are admitted through' : 'may not arrive through'
    } the drain's authored boundary`, () => {
      const fixture = checkpointOf(noopDelta(origin))

      if (expected === 'parses') {
        expect(() => parseAuthoredCheckpoint(fixture)).not.toThrow()
        return
      }

      let thrown: unknown
      expect(
        () => {
          try {
            parseAuthoredCheckpoint(fixture)
          } catch (error) {
            thrown = error
            throw error
          }
        },
        'a persisted non-agent checkpoint re-enters commitCurationDelta on every drain and is '
          + 'refused deterministically, so admitting it converts one bad file into a permanent '
          + 'drain stopper',
      ).toThrow()

      /**
       * The FAMILY matters, not just the throw. drain.ts:993-1003 routes a parse failure to
       * `quarantineMalformedClaim` — typed and terminal — while a failure thrown later, out of
       * `commitCurationDelta`, is recorded as a commit failure and requeued durably. Asserting a
       * ZodError is asserting that the rejection lands on the quarantine side of that fork.
       *
       * EVIDENCE LEVEL, stated rather than implied (the split the round-2 verifier used for the
       * requeue half of CR-02″): this corpus measures the SCHEMA. That the drain routes a
       * ZodError from this call site to `quarantineMalformedClaim` is established by reading
       * drain.ts:990-1003, not by executing a drain here.
       */
      expect(thrown).toBeInstanceOf(ZodError)
      expect(
        (thrown as ZodError).issues.some((issue) => issue.path.join('.') === 'deltas.0.origin'),
        'the rejection must name the delta and the field, so an operator reading the quarantine '
          + 'reason knows which value was refused',
      ).toBe(true)
    })
  }

  /**
   * The array axis. A check written against `deltas[0]` would be this phase's named defect at a
   * different axis — a guard scoped to one member of a set whose hazard belongs to the whole set
   * — and a widened checkpoint carries the job's FULL delta array.
   *
   * This control is potent: the first delta is agent-origin, so the fixture would parse under a
   * first-element-only check and the assertion could only pass if the walk really covers every
   * position.
   */
  it('a non-agent origin at a LATER array position is rejected too', () => {
    const fixture = checkpointOf(noopDelta('agent'), noopDelta('user'))

    let thrown: unknown
    try {
      parseAuthoredCheckpoint(fixture)
    } catch (error) {
      thrown = error
    }

    expect(thrown, 'the admission is per delta, not per checkpoint').toBeInstanceOf(ZodError)
    expect(
      (thrown as ZodError).issues.some((issue) => issue.path.join('.') === 'deltas.1.origin'),
      'the issue path must name the offending POSITION',
    ).toBe(true)
  })

  /**
   * The admit control, beyond parsing: the drain's own path is demonstrably unbroken. A
   * narrowing that rejected everything would satisfy every rejection row above and break the
   * only producer that exists.
   */
  it("round-trips the drain's own agent-origin checkpoint by value", () => {
    const fixture = checkpointOf(noopDelta('agent'))

    expect(parseAuthoredCheckpoint(fixture)).toEqual(fixture)
  })

  /**
   * SEPARATION CONTROL — the load-bearing half of 387-20 D-2, and the reason the admission is
   * NOT on `envelopeShape.origin`.
   *
   * `authoredCheckpointSchema` is the SHARED structural boundary: `AuthoredCheckpoint`'s inferred
   * delta type is what `bridgeDelta`, `maintenanceCheckpoint`, `commitCurationDelta` and
   * `disposeDelta` all carry, for every origin the review verbs and rollback produce. Collapsing
   * its envelope to a single origin was measured: 14 `tsc` errors across 13 files, four of them
   * production (commit.ts, drain.ts, knowledge-store.ts, rollback.ts), and 13 red cases in
   * disposition.test.ts whose fixtures could no longer be CONSTRUCTED.
   *
   * So these two rows are not decoration. They red if a later change moves the admission from
   * the drain's parse function onto the shared envelope, which is the mistake this split exists
   * to prevent.
   */
  for (const origin of DELTA_ORIGINS) {
    it(`the SHARED structural schema still accepts ${origin} (it is not the drain boundary)`, () => {
      expect(() => authoredCheckpointSchema.parse(checkpointOf(noopDelta(origin)))).not.toThrow()
    })
  }
})

describe('the authored checkpoint keeps the run\'s actual execution context', () => {
  const CONTEXTS = ['local-interactive', 'local-headless', 'ci', 'cloud'] as const satisfies
    readonly ExecutionContext[]

  for (const executionContext of CONTEXTS) {
    it(`round-trips ${executionContext} authorship and resolves a mode-only profile`, () => {
      const fixture = {
        schemaVersion: AUTHORED_CHECKPOINT_SCHEMA_VERSION,
        deltas: [{ kind: 'Noop', origin: 'agent', scope, citedIds: [] }],
        neighborIds: [],
        preconditions: [],
        authorship: { path: 'llm', model: { id: 'curator-model' }, executionContext },
      }

      expect(parseAuthoredCheckpoint(fixture).authorship.executionContext).toBe(executionContext)
      expect(
        Object.keys(resolveDispositionProfile(executionContext)),
        'the profile decides authority only; it never carries a substitute context',
      ).toEqual(['mode'])
    })
  }
})
