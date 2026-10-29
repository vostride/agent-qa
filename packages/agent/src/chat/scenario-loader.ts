// Reading one scenario back.
//
// A scenario file is committed DATA that decides whether a gate passes, so the step between the
// bytes on disk and the assertion has to be a validation rather than a cast. This module is that
// step, spelled once for both lanes and for the manifest walk.
//
// IT TAKES A PARSED DOCUMENT, NEVER A PATH, and the shape of that decision is architectural rather
// than stylistic. `packages/agent` is `storageNeutral`: the class rules forbid `node:fs` by name,
// and they are right to — a package whose whole claim is "storage access through ports only" must
// not grow a file reader for its own test corpus. The eight lines of `readFileSync` + YAML decode
// therefore live in the runners, which are test files in packages that may touch a disk, and
// everything that could be got WRONG about a scenario — the schema, the cross-checks, the refusal
// wording — lives here where one spelling serves every caller. (The plan named a `loadScenario`
// that resolves and reads a path; the split is the deviation, and it is recorded as one.)
//
// THE REFUSAL NAMES THE SCENARIO. A zod error alone reports a field path against an anonymous
// object, and the reader of a red gate needs to know WHICH of twenty files is malformed before
// anything else is useful.

import { ChatScenarioSchema } from '@vostride/agent-qa-schema'
import type { ChatScenario, ScenarioClass } from '@vostride/agent-qa-schema'

/**
 * How a scenario is addressed: `<class>/<id>.yml`, relative to `src/chat/scenarios`.
 *
 * The directory name IS the class name, so there is no second mapping table to keep in step with
 * `SCENARIO_CLASSES`. A class added to the vocabulary needs a directory and nothing else.
 */
export function scenarioRelativePath(reference: {
  readonly class: ScenarioClass
  readonly id: string
}): string {
  return `${reference.class}/${reference.id}.yml`
}

/**
 * Validate a decoded scenario document against the schema AND against the line that found it.
 *
 * The second half is the one worth stating. The manifest addresses a scenario by class and id, and
 * the file states its own class and id — two facts that a loader trusting the filename would let
 * drift, leaving a corpus entry whose contents belong to a different scenario than the one the
 * denominator counted.
 */
export function parseScenario(
  document: unknown,
  expected: { readonly class: ScenarioClass; readonly id: string },
): ChatScenario {
  const reference = `${expected.class}/${expected.id}`
  const parsed = ChatScenarioSchema.safeParse(document)
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
      .join('; ')
    throw new Error(`scenario ${reference} is not a valid ChatScenario — ${detail}`)
  }
  const scenario = parsed.data
  if (scenario.id !== expected.id || scenario.class !== expected.class) {
    throw new Error(
      `scenario ${reference} declares itself as ${scenario.class}/${scenario.id} — the file and `
        + 'the manifest line that addressed it must name the same scenario',
    )
  }
  return scenario
}
