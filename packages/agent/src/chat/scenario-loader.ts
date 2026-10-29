// Takes a parsed document, never a path, because `packages/agent` is storage-neutral.

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
