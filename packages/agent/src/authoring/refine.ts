// One unconditional round keyed on the draft's own words; a failed round never loses the draft.

import { TestEditPatchSetSchema } from '@vostride/agent-qa-schema'
import type { ScopeKey, TestEditPatchSet } from '@vostride/agent-qa-schema'

import { exemplarBlockBody, knowledgeBlockBody, REQUEST_WINS_INSTRUCTION } from './brief-blocks.js'
import type {
  AuthoringReadPortLike,
  DraftShelfPortLike,
  ParsedDraftLike,
} from './ports.js'
import {
  extractStatedValues,
  missingStatedValues,
  statedValuesMissingReason,
} from './stated-values.js'
import { buildTieredPrompt } from '../prompt/tiered-prompt-builder.js'

export const REFINEMENT_ROUNDS = 1

// Distinct from the compile context because the call asks to change a document, not write one.
export const AUTHORING_REFINE_AGENT_CONTEXT =
  'authoring.draft.write — refine a compiled draft against newly retrieved facts and procedures'

/**
 * What one refinement round did to the draft it was given.
 *
 * THREE ARMS AND THE DRAFT ON EVERY ONE. The loop continues with `outcome.draft` whatever happened,
 * so no caller has to remember which arms carry a replacement — and no arm can be read as "the
 * draft is gone".
 *
 *   `refined`     patches applied; `draft` is the patched, re-parsed, re-staged document.
 *   `no-op`       the model emitted zero patches. A VALID answer, not an error: it saw nothing new.
 *   `not-applied` the emission or its application was refused. The compiled draft continues, and
 *                 `reason` is the refusal, kept so a receipt reader can tell a round that found
 *                 nothing apart from a round that could not be used.
 */
export type RefinementOutcome =
  | {
      readonly kind: 'refined'
      readonly draft: ParsedDraftLike
      readonly patchCount: number
      readonly thoughts: string
    }
  | { readonly kind: 'no-op'; readonly draft: ParsedDraftLike; readonly thoughts: string }
  | { readonly kind: 'not-applied'; readonly draft: ParsedDraftLike; readonly reason: string }

export interface RefineDraftDeps {
  readonly read: AuthoringReadPortLike
  readonly shelf: DraftShelfPortLike
}

// Name and step text only: a query keyed on host-minted addresses would vary for equal drafts.
export function draftRetrievalQuery(draft: ParsedDraftLike): string {
  return [draft.testName, ...draft.steps].join('\n')
}

/** The draft as the model is shown it for refinement — the same two facts the query is built on. */
function draftBlockBody(draft: ParsedDraftLike): string {
  return [
    `Test name: ${draft.testName}`,
    'Steps, in order:',
    ...draft.steps.map((step, index) => `  ${index}. ${step}`),
  ].join('\n')
}

/**
 * What came back, parsed as a patch set — or the reason it could not be.
 *
 * The emission is JSON text a model produced, so BOTH failure modes are ordinary rather than
 * exceptional: bytes that are not JSON, and JSON that is not this contract. Neither throws out of
 * here; the caller turns them into the `not-applied` arm with the reason attached.
 */
function parsePatchSet(text: string): { patchSet: TestEditPatchSet } | { reason: string } {
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch (error) {
    return { reason: `the refinement emission is not JSON: ${(error as Error).message}` }
  }
  const parsed = TestEditPatchSetSchema.safeParse(json)
  return parsed.success
    ? { patchSet: parsed.data }
    : { reason: `the refinement emission is not a patch set: ${parsed.error.issues[0]?.message}` }
}

/**
 * Run THE refinement round. Unconditional: there is no early return above the retrieval.
 *
 * Read the body top to bottom and there is no `if` between the entry and the model call — no
 * emptiness check on the first brief, no length test on the draft, no cached-result short circuit.
 * That absence is the contract, and `refine.test.ts` drives the case a trigger would skip: a draft
 * whose first retrieval already returned facts still gets its round.
 */
export async function refineDraft(
  draft: ParsedDraftLike,
  input: { readonly scope: ScopeKey; readonly intent: string },
  deps: RefineDraftDeps,
): Promise<RefinementOutcome> {
  const brief = await deps.read.getAuthoringBrief(draftRetrievalQuery(draft), input.scope)

  const request = buildTieredPrompt({
    agent_context: AUTHORING_REFINE_AGENT_CONTEXT,
    stable: [
      {
        title: 'Role',
        body: 'You improve an agent-qa test document that has already been written. Reply with '
          + 'ONE JSON object and nothing else: {"thoughts": string, "patches": [...]}, where each '
          + 'patch is an RFC-6902 op with "op" one of add/remove/replace, a JSON Pointer "path", '
          + 'and for add/replace a string "value". Only /steps, /name and /context may be '
          + 'addressed. Emit an EMPTY patches array when the knowledge below adds nothing — that '
          + 'is a correct answer, and inventing a change to look useful is not. '
          + REQUEST_WINS_INSTRUCTION,
      },
    ],
    context: [
      { title: 'Intent', body: input.intent },
      { title: 'The draft as it stands', body: draftBlockBody(draft) },
      { title: 'What this project knows about these steps', body: knowledgeBlockBody(brief) },
    ],
    volatile: [{ title: 'Exemplar tests', body: exemplarBlockBody(brief) }],
  })

  const model = await deps.shelf.model()
  const emitted = await model.generate(request)

  const parsed = parsePatchSet(emitted.text)
  if ('reason' in parsed) return { kind: 'not-applied', draft, reason: parsed.reason }

  // An empty set skips the applier, so a round that changed nothing does not touch the shelf.
  if (parsed.patchSet.patches.length === 0) {
    return { kind: 'no-op', draft, thoughts: parsed.patchSet.thoughts }
  }

  // THE SAME APPLIER THE REPAIR LOOP AND THE EDIT OP USE, reached through the port for the reason
  // stated on the port itself: it needs the yaml CST, which lives in a package this one may not
  // depend on. A refusal here — the region fence, an unresolvable pointer, a patched document that
  // no longer parses — arrives as a throw or as the `unparsable` arm, and both mean the same thing
  // to this round: the compiled draft stands.
  let staged
  try {
    staged = await deps.shelf.applyPatches(draft, parsed.patchSet)
  } catch (error) {
    return { kind: 'not-applied', draft, reason: (error as Error).message }
  }
  if (staged.kind === 'unparsable') return { kind: 'not-applied', draft, reason: staged.reason }

  // A patch that loses a stated value is dropped; the compiled draft passed the same check.
  const missing = missingStatedValues(extractStatedValues(input.intent), staged.draft.steps)
  if (missing.length > 0) {
    return { kind: 'not-applied', draft, reason: statedValuesMissingReason(missing) }
  }

  return {
    kind: 'refined',
    draft: staged.draft,
    patchCount: parsed.patchSet.patches.length,
    thoughts: parsed.patchSet.thoughts,
  }
}
