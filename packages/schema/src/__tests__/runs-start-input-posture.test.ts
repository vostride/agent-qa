// THE REQUEST HALF OF D-12 (402-03): concurrency is a CONFIG fact, and a caller cannot name it.
//
// `use.parallel` / `use.workers` live in the config the run resolves against, so the owner of a
// target tunes how much of their machine a run may take. `RunsStartInput` is the OTHER side of that
// sentence: a remote token-holder handing the run service a request must not be able to raise the
// concurrency of a target somebody else tuned down. That is not a rule anything enforces at runtime
// — it is a rule the SHAPE enforces, by there being no such field and the object being `.strict()`.
//
// WHY A CELL AND NOT A COMMENT. A shape-enforced rule is exactly the kind that a later additive
// field silently repeals: `RunsStartInput` is designed to grow (its own doc says so), and every
// growth so far has been a one-line addition. These cells make the two concurrency-shaped names a
// DELIBERATE red rather than a quiet contract change.
//
// THE CELLS SEND THE FIELD. A posture cell that sent a clean request and asserted the parsed value
// has no concurrency key passes under a schema that accepts one and drops it, under a schema that
// accepts and honours it, and under no schema at all. So every arm below carries the key and reads
// the refusal — and each arm's positive control (the same input WITHOUT the key) proves the refusal
// is about the key rather than about the rest of the request.

import { describe, expect, it } from 'vitest'

import { RunsStartInputSchema } from '../functions/runs'
import type { RunsStartInput } from '../functions/runs'

/** An otherwise-valid request: every field this schema honours, and nothing it does not. */
const VALID_REQUEST = {
  patterns: ['tests/checkout.yaml'],
  configPath: 'agent-qa.config.yaml',
  gateRun: true,
} as const

/**
 * The names a concurrency override would plausibly arrive under.
 *
 * NAMED RATHER THAN INFERRED, because the claim is about what a CALLER would try to write. The two
 * the config uses come first; the rest are the spellings the same idea travels under elsewhere, so
 * an addition under any of them is a red rather than a near miss.
 */
const CONCURRENCY_SHAPED_KEYS = [
  'parallel',
  'workers',
  'concurrency',
  'maxWorkers',
  'workerCount',
  'jobs',
  'threads',
] as const

describe('RunsStartInput refuses a concurrency override', () => {
  it('THE POSITIVE CONTROL — the base request, without any added key, parses', () => {
    // Without this, every refusal below could be a refusal of the base request and the cells would
    // read as green posture over a schema that refuses everything.
    expect(RunsStartInputSchema.safeParse(VALID_REQUEST).success).toBe(true)
  })

  it('refuses a request carrying `parallel`', () => {
    const result = RunsStartInputSchema.safeParse({ ...VALID_REQUEST, parallel: true })

    expect(result.success).toBe(false)
  })

  it('refuses a request carrying `workers`', () => {
    const result = RunsStartInputSchema.safeParse({ ...VALID_REQUEST, workers: 8 })

    expect(result.success).toBe(false)
  })

  it('refuses every concurrency-shaped spelling, in both value forms', () => {
    for (const key of CONCURRENCY_SHAPED_KEYS) {
      for (const value of [true, 8] as const) {
        const result = RunsStartInputSchema.safeParse({ ...VALID_REQUEST, [key]: value })

        expect(result.success, `${key}: ${String(value)} was accepted`).toBe(false)
      }
    }
  })

  it('refuses the key on an ARGUMENT-LESS request too — the smallest surface still refuses', () => {
    // `{}` is a valid request (run the configured default set), so this arm shows the refusal is
    // the strict object's and not an interaction with the other fields.
    expect(RunsStartInputSchema.safeParse({}).success).toBe(true)
    expect(RunsStartInputSchema.safeParse({ workers: 4 }).success).toBe(false)
    expect(RunsStartInputSchema.safeParse({ parallel: true }).success).toBe(false)
  })

  it('never parses a concurrency key THROUGH — the refusal is not a silent drop', () => {
    // The other failure mode a strict object rules out: accepting the request and discarding the
    // field. Asserted on the parsed data of the ONE request that does parse, so a schema loosened
    // to `.passthrough()` (which would carry the caller's field onward) reds here as well as above.
    const parsed = RunsStartInputSchema.safeParse(VALID_REQUEST)

    expect(parsed.success).toBe(true)
    if (parsed.success) {
      for (const key of CONCURRENCY_SHAPED_KEYS) {
        expect(Object.hasOwn(parsed.data, key), `${key} survived the parse`).toBe(false)
      }
    }
  })

  it('declares no concurrency-shaped key in its own shape', () => {
    // The census, read off the schema rather than off a list of what it refuses: a field ADDED
    // under any of these names is a red here even if some later arm of the schema accepted it.
    const declared = Object.keys(RunsStartInputSchema.shape)

    expect(declared.filter((key) => (CONCURRENCY_SHAPED_KEYS as readonly string[]).includes(key)))
      .toEqual([])
  })
})

/**
 * THE COMPILE-TIME HALF. `RunsStartInput` is what every door types its request against, so a key
 * added to the schema surfaces here as `TS2322: Type 'false' is not assignable to type 'true'`.
 *
 * THE GATE THAT REPORTS IT IS `pnpm typecheck` (tsc over this package, `__tests__` included) —
 * measured, not assumed: vitest's own typecheck pass ranges `*.test-d.ts` and stayed green under
 * the very mutation that added `parallel` to the schema. Named precisely so a later reader does not
 * conclude from a green `vitest run` that this half was measured.
 */
type DeclaresKey<T, K extends string> = K extends keyof T ? true : false

const parallelIsNotARequestField: DeclaresKey<RunsStartInput, 'parallel'> = false
const workersIsNotARequestField: DeclaresKey<RunsStartInput, 'workers'> = false
/** A control on the assertion above: a field the request DOES declare types as `true`. */
const patternsIsARequestField: DeclaresKey<RunsStartInput, 'patterns'> = true

void parallelIsNotARequestField
void workersIsNotARequestField
void patternsIsARequestField
