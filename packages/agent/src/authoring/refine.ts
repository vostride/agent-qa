// The one unconditional draft-as-query refinement round.
//
// After the whole-document compile, the loop re-retrieves keyed on the DRAFT'S OWN steps and
// anchors and gives the model exactly one pass to improve what it just wrote — emitted as RFC-6902
// patches through the shipped CST applier, never as a second whole document.
//
// WHY THE ROUND IS UNCONDITIONAL, which is the decision rather than the mechanism. The obvious
// alternative is a trigger: refine only when the first retrieval came back thin, or when the draft
// is long, or when some score is low. Every one of those is a RULE ABOUT WHEN KNOWLEDGE MATTERS,
// and that rule rots faster than the knowledge does — the moment the brief's contents shift, a
// threshold calibrated against last quarter's corpus starts skipping exactly the drafts that most
// needed a second look, silently and with no failing test anywhere. Retrieval here is local and
// cheap, so the argument for one round is not that a round is expensive; it is that the loop's
// shape stays deterministic and its fan-out preview keeps describing what actually happens.
//
// WHY THE QUERY IS THE DRAFT AND NOT THE INTENT. The intent has already been retrieved against, at
// stage 1, and re-asking it would return the brief the compile was given — a second call over the
// same substrate, which can only confirm. The compiled steps name things the intent did not: a
// concrete flow, a page, an element, a phrase that matches a caution nobody thought to ask for. So
// this round asks the question the intent could not, which is what makes it a round rather than a
// retry.
// 2026-10-12 (440, D-06): the prompt carries the request too; only the retrieval query stays the draft's words.
//
// WHY A FAILED REFINEMENT DOES NOT FAIL THE INVOCATION. What arrives is a model emission, and the
// three ways it can be unusable — not a patch set at all, a patch set the fence or the applier
// refuses, a patched document that no longer parses — are all facts about the REFINEMENT and not
// about the compiled draft, which was already parsed and staged before this ran. Ending the whole
// invocation on any of them would let an optional improvement destroy a good draft. So the outcome
// is a discriminated union: the draft always survives, and the arm says what happened to it, which
// is the difference between a degraded round a reader can see and one that quietly does nothing.

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

/**
 * How many refinement rounds run per compiled draft. Exactly one, always.
 *
 * what a change to this number has to report, and what it may not be.
 *
 * It may NOT become a condition. Raising it to 2 is a retune; making the second round fire only
 * when some signal says the first one found something is not a retune, it is the trigger heuristic
 * D-18 rules out, and it is ruled out for a stated reason rather than a preference: a trigger is a
 * rule about when this project's own knowledge is worth consulting, and nothing in the codebase
 * fails when that rule goes stale.
 *
 * A retune must report, over the frozen draft corpus: how many drafts a second round CHANGES at
 * all (a round that emits no patches on every member is a round nobody needs), how many of those
 * changes survive the gates that the one-round draft did not, and the token cost of the extra call
 * priced per additional keep. Two of those three are cheap to get wrong in the flattering
 * direction — "the model emitted patches" is not "the draft got better" — so the middle number is
 * the one that decides, and it is the one a receipt can settle rather than an impression.
 *
 * Lowering it to 0 is also a retune, and it needs the same evidence pointed the other way: the
 * round's contribution measured, not assumed absent.
 */
export const REFINEMENT_ROUNDS = 1

/**
 * The `agent_context` the refinement call carries into the ONE tiered prompt builder.
 *
 * A pinned string, distinct from the compile call's, for the reason that one is pinned: it lands in
 * the stable tier, which is the byte prefix a provider's prompt cache keys on. Distinct because the
 * two calls ask genuinely different questions — write a document, versus change one that exists —
 * and a shared context line would tell the model neither.
 */
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

/**
 * The draft, as the retrieval query for its own second round.
 *
 * The test's NAME and its STEP TEXT, in document order, and nothing else. Not the intent — see the
 * header. Not the file path or the digest either: those are addresses this host minted, they name
 * no fact about an application, and a retrieval keyed partly on a content digest would return a
 * different brief for two drafts that say the same thing.
 *
 * Exported because it is the claim worth pinning on its own: a cell can assert the query carries
 * the draft's words and not the intent's without having to reconstruct a prompt to find out.
 */
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

  // AN EMPTY SET SHORT-CIRCUITS THE APPLIER, and that is not an optimisation. 394-03's corpus pins
  // that an empty set renders byte-identical output, so routing one through would be a provably
  // no-op re-stage — but it would still be a WRITE, and a round that touched the shelf on every
  // invocation would make "this refinement changed nothing" indistinguishable, on disk, from one
  // that did. The arm says it instead.
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

  // a patch that loses a stated value is dropped; the compiled draft
  // already passed the same check at compile.
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
