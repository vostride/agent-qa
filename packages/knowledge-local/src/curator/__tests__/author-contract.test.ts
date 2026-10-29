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

// The expectations are declared apart from the production table, so a mutation can red them.
describe('the drain authored-checkpoint boundary admits origins from a total table', () => {
  type OriginAdmission = 'parses' | 'rejects'

  // Rejecting `user` here is what makes the deprecate floor's `user: 'allow'` safe.
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

      // A `ZodError` routes to quarantine; a later throw is requeued as a commit failure.
      expect(thrown).toBeInstanceOf(ZodError)
      expect(
        (thrown as ZodError).issues.some((issue) => issue.path.join('.') === 'deltas.0.origin'),
        'the rejection must name the delta and the field, so an operator reading the quarantine '
          + 'reason knows which value was refused',
      ).toBe(true)
    })
  }

  // The first delta is agent-origin, so only a walk over every position can reject this.
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

  // These rows red if the admission moves from the drain's parse onto the shared envelope.
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
