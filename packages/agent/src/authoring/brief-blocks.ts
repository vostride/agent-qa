// The authoring brief as prompt blocks — ONE rendering, read by stage 3's two model calls.
//
// Stage 3 makes two calls (D-02 whole-document compile, then D-18's one refinement round) and both
// are given the same substrate in the same words. These renderers were private to `loop.ts` while
// there was one caller; they moved here when the second arrived, rather than being copied, because
// two renderings of one brief would let the refinement reason over a differently-worded view of the
// facts it is refining against — and a difference nobody intended is exactly what a second copy
// produces the first time either side is edited.
//
// WHAT A PROCEDURE CONTRIBUTES, AND WHAT IT MUST NOT. `ProcedureMatch` carries
// `id`, a learned-shelf record id. This module reads `flowAnchor` and never `id`, so the vocabulary
// a step is authored in is the record's own words while the record's ADDRESS never reaches the
// model at all. That ordering is the whole mitigation: bytes a model was never shown are bytes it
// cannot paste into a committed test, and the authored shelf therefore carries nothing that
// supersession or garbage collection could later turn into a dangling reference.

import { procedureStepVocabulary } from '@vostride/agent-qa-schema'
import type { AuthoringBrief } from '@vostride/agent-qa-schema'

/**
 * The instruction that turns a served procedure into an ordinary step.
 *
 * Pinned as a constant for the reason {@link AUTHORING_COMPILE_AGENT_CONTEXT} is: it lands in the
 * stable prompt tier, which is the byte prefix a provider's prompt cache keys on, so a
 * per-invocation wording would defeat the caching the tier law exists to enable.
 *
 * It asks for PROSE and forbids a citation, which is the syntactic half of D-17 stated where a
 * model can read it. The semantic half is the vocabulary itself, rendered below.
 */
export const PROCEDURE_BY_REFERENCE_INSTRUCTION =
  'This project already knows how to perform some flows. Where a step of yours is one of the '
  + 'flows listed under PROCEDURE, write that step in that flow\'s own words, as an ordinary '
  + 'natural-language step. Do NOT cite a record, an id or a reference of any kind, and do not '
  + 'invent a special syntax: the test file stays plain prose, and the flow is recognised when the '
  + 'test runs. A step that matches no listed flow is simply written as you would write any other.'

// appended to the compile and refine `Role` bodies.
export const REQUEST_WINS_INSTRUCTION =
  'The request\'s stated subject, values and checks win over what this project knows: use '
  + 'project knowledge only to decide how to reach them, never to replace them, and keep every '
  + 'quoted string, number, price and date from the request word for word.'

/** The title of the stable block {@link TEST_DOCUMENT_FORMAT_INSTRUCTION} renders under. */
export const TEST_DOCUMENT_FORMAT_BLOCK_TITLE = 'Test document format'

/**
 * The title of the CONTEXT block serving this project's `target` vocabulary.
 *
 * CONTEXT AND NOT STABLE, unlike its neighbour above. Target names are per-project facts, and the
 * stable tier is the byte prefix a provider's prompt cache keys on — a project-dependent body
 * there would defeat the sharing the tier law exists to enable. It rides beside the Scope block,
 * which is the block it corrects: `Scope` names a PRODUCT and a `target` is a TARGET NAME, and
 * until this constant existed nothing in the prompt said the two were different kinds of value.
 *
 * The title is referenced BY NAME from {@link TEST_DOCUMENT_FORMAT_INSTRUCTION}'s `target` bullet,
 * so the vocabulary is not merely present in the prompt but is where the instruction sends a
 * reader. A served-but-unreferenced block is a block a model may never look at.
 */
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

/**
 * The document SCHEMA, served through a channel that does not depend on memory.
 *
 * Pinned as a constant and landed in the stable tier for the reason
 * {@link PROCEDURE_BY_REFERENCE_INSTRUCTION} is: it is a standing rule about how any document is
 * written rather than a fact about this intent, so it belongs where the byte prefix is shared.
 *
 * A zero-exemplar brief is the bootstrap case — a fresh project has no memory by definition — and
 * `exemplarBlockBody` answers the empty string of prose there. A format rule carried only by the
 * exemplar block is therefore a format rule the first authored test never sees.
 *
 * EVERY SENTENCE HERE IS TRUE AGAINST `TestDefinitionSchema`, AND THAT IS A
 * STANDING OBLIGATION RATHER THAN A ONE-TIME EDIT. A prompt that pins a schema by enumeration is a
 * SECOND SPELLING of that schema, free to drift from the first the moment either side is touched —
 * the same hazard `TEST_DOCUMENT_FORMAT_EXAMPLE` is composed in rather than retyped to avoid. The
 * first draft of this block claimed four keys were all a document may carry, and the cost was
 * specific: `context` is one of the three `EDITABLE_POINTER_ROOTS` and the root `ParsedDraftLike`
 * was widened for in 394-15 so the draft check could read it — and a stage forbidden to
 * emit it could never populate it. The accepted set is `name`, `test-id`, `target`, `steps`,
 * `context`, `use`, `meta`, `setup`, `teardown`, and the schema is `.strict()`, which is the half
 * of the old closing claim that was always true.
 *
 * WHAT IS NAMED BUT NOT TAUGHT. `use`, `meta`, `setup` and `teardown` are accepted by the parser
 * and are stated here as accepted, because a rejection sentence that swept them up would be false
 * again in the other direction. They are not TAUGHT — no shape, no example — because this stage
 * authors a first draft and a hook id it invented would name a hook no project has.
 */
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

/**
 * The brief's cautions, procedures and facts, in the precedence the brief itself locked.
 *
 * The procedure line renders {@link procedureStepVocabulary} over the flow anchor. The previous
 * form printed `JSON.stringify(flowAnchor)` for any arm that was not a flow, which put a serialized
 * object in front of a model asked to write English; the shared vocabulary function answers every
 * arm in the record's own words and cannot be handed an id to print.
 */
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
