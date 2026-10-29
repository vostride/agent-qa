// Both stage-3 calls share these renderers; a procedure gives its `flowAnchor`, never its `id`.

import { procedureStepVocabulary } from '@vostride/agent-qa-schema'
import type { AuthoringBrief } from '@vostride/agent-qa-schema'

// A constant because it lands in the stable tier, the byte prefix provider prompt caches key on.
export const PROCEDURE_BY_REFERENCE_INSTRUCTION =
  'This project already knows how to perform some flows. Where a step of yours is one of the '
  + 'flows listed under PROCEDURE, write that step in that flow\'s own words, as an ordinary '
  + 'natural-language step. Do NOT cite a record, an id or a reference of any kind, and do not '
  + 'invent a special syntax: the test file stays plain prose, and the flow is recognised when the '
  + 'test runs. A step that matches no listed flow is simply written as you would write any other.'

// Appended to the compile and refine `Role` bodies.
export const REQUEST_WINS_INSTRUCTION =
  'The request\'s stated subject, values and checks win over what this project knows: use '
  + 'project knowledge only to decide how to reach them, never to replace them, and keep every '
  + 'quoted string, number, price and date from the request word for word.'

/** The title of the stable block {@link TEST_DOCUMENT_FORMAT_INSTRUCTION} renders under. */
export const TEST_DOCUMENT_FORMAT_BLOCK_TITLE = 'Test document format'

// A context block, not stable: target names are per-project, and the stable tier is cache-shared.
export const CONFIGURED_TARGETS_BLOCK_TITLE = 'Configured targets'

/**
 * The served names, one per line — or the honest answer when a project declares none.
 *
 * ONE NAME PER LINE AND NOTHING ELSE around them: no bullets, no quoting, no count. Anything
 * rendered beside a name is something a model can mistake FOR a name, and this is the one block
 * whose whole purpose is that the value it produces is copied out of it verbatim.
 */
export function configuredTargetsBlockBody(names: readonly string[]): string {
  if (names.length === 0) {
    return 'This project declares no targets. Ask which target this test should run against '
      + 'rather than inventing one.'
  }
  return names.join('\n')
}

/** The line the canonical example follows, and the last prose in the block. */
export const TEST_DOCUMENT_FORMAT_EXAMPLE_MARKER = 'A complete document looks exactly like this:'

/**
 * The canonical minimal document, in neutral values.
 *
 * Composed INTO {@link TEST_DOCUMENT_FORMAT_INSTRUCTION} rather than typed twice, so the bytes a
 * test stages through the real parser are the bytes the model is shown.
 */
export const TEST_DOCUMENT_FORMAT_EXAMPLE = `name: Confirm the sign-in page shows its heading
test-id: t_amber-cotton-ledger-marble-quartz-signal-timber-violet-walnut-yellow
target: sign-in
steps:
  - Open the sign-in page
  - Verify the page heading says "Sign in"
`

// Every sentence here must stay true against `TestDefinitionSchema`, or the prompt drifts from it.
export const TEST_DOCUMENT_FORMAT_INSTRUCTION =
  'A test document has these four required top-level keys:\n'
  + '- `name`: the test\'s display name, one line of plain English.\n'
  + '- `test-id`: a stable identifier — the letters `t_` followed by exactly ten lowercase words '
  + 'joined by hyphens. Choose ten words of your own rather than copying the example\'s.\n'
  + '- `target`: the test\'s target, chosen from the names in the Configured targets block — '
  + 'never invented. The Scope block names a PRODUCT, which is not always one of those names.\n'
  + '- `steps`: a YAML list of natural-language step strings, at least one of which asserts '
  + 'concrete expected content.\n'
  + '`context` is optional: one paragraph of standing background the whole test assumes.\n'
  + 'The schema also accepts `use`, `meta`, `setup` and `teardown`; this stage does not teach them, '
  + 'so leave them out. Any top-level key outside the ones named here is rejected without the '
  + 'document being read.\n'
  + 'When the Exemplar tests block carries tests, it shows this project\'s house style and takes '
  + 'precedence on every question of style; this block is the floor beneath it, not a rival.\n\n'
  + `${TEST_DOCUMENT_FORMAT_EXAMPLE_MARKER}\n\n${TEST_DOCUMENT_FORMAT_EXAMPLE}`

/** The brief's exemplars, as the context block a model reads them as. */
export function exemplarBlockBody(brief: AuthoringBrief): string {
  if (brief.exemplars.length === 0) {
    return 'No exemplar tests were served for this scope. Follow the house YAML test style.'
  }
  return brief.exemplars
    .map((exemplar) => `- ${exemplar.filePath} · ${exemplar.testName}\n${exemplar.excerpt}`)
    .join('\n')
}

// Procedures render through `procedureStepVocabulary`, so no object or id reaches a model.
export function knowledgeBlockBody(brief: AuthoringBrief): string {
  const lines = [
    ...brief.cautions.map((caution) => `CAUTION: ${caution.summary}`),
    ...brief.procedures.map(
      (procedure) => `PROCEDURE: ${procedureStepVocabulary(procedure.flowAnchor)}`,
    ),
    ...brief.facts.map((fact) => `FACT: ${fact.summary}`),
  ]
  return lines.length === 0 ? 'This scope has no served knowledge yet.' : lines.join('\n')
}
