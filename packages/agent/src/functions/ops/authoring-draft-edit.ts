// `authoring.draft.edit` — the user-facing test edit as a catalogued capability (394-09, D-21).
//
// WHY IT REGISTERS, AND WHY NOW. "Edit that test to also verify the coupon banner" is a thing a
// person asks, and 392 D-07 binds every registered op into the chat planner's toolset 1:1 — so
// registering it is what makes the sentence work from chat, MCP and the CLI on the day it lands,
// through one implementation rather than three. The timing is the other half: 394-03 minted the
// RFC-6902 vocabulary and the CST applier, and until this op existed the repair loop was its only
// consumer. A contract with one consumer is a contract shaped like its one caller, and this
// project has already paid for that (the two-sided contract law, 388/390/392). Two real consumers
// from day one is the whole reason D-21 puts the edit verb in 394 instead of the next phase.
//
// THE ID IS `authoring.draft.edit` — three lowercase dot segments, no underscore, `draft` the
// subject and `edit` the verb, so the family reads `authoring.draft.{write, verify, edit}`. The two
// shipped mechanisms that force the spelling were re-measured for this op rather than inherited:
//   1. `parity-coverage.test.ts` requires every registered id to match `^[a-z]+(?:\.[a-z]+)+$` off
//      the registry; `authoring.draft.edit` matches and `authoring.draft_edit` does not.
//   2. `chat/tool-names.ts` maps ids onto provider-safe tool names by `.` ↔ `_` and REFUSES an id
//      already carrying `_`, because such a name has two pre-images under the inverse — so an
//      underscore id would raise `ChatToolNameError` for the WHOLE projection (T-394-07).
//
// IT IS NOT A LOOP STAGE, which is the argument `loop-ordering.test.ts` requires beside the name.
// That pin exists to forbid promoting a stage of `authoring.draft.write` to its own registered op,
// since a planner holding one could run compile without dedup or verify without either. This verb
// is not a stage of anything: it takes an existing COMMITTED test and a change to make to it, it
// has no place in the six-stage order, and invoking it before, during or after a loop invocation
// answers the same question. It widens the domain without widening the loop's entry surface.
//
// NO SCOPES (2026-10-01, 432-24, D-12). This op once declared `test-write` and `read`, and left
// `run` out on purpose so a grant issued for "let it edit my tests" could not also buy child runs
// (T-394-37). Grants and scopes are gone; every door can call every operation. What survives of
// T-394-37 is the behaviour itself: this op edits a committed test and starts no run at all.
//
// IT DOES NOT RE-RUN THE GATES, and CONTEXT leaves that call to this plan, so it is made here and
// written down. An edit to an already-committed test does not automatically re-verify: the
// standalone `authoring.draft.verify` op exists for exactly the question "is this test worth
// keeping", and folding it in would fire a nine-run fan-out on every one-line edit — the cost
// WTST-08's preview exists to keep a person in charge of. One verb per question. A caller who wants
// gate coverage over the edited draft invokes the verify op with the returned `draftRef.filePath`,
// which since 432 D-06 is the written test file itself.
//
// THE WRITE IS THE END OF THIS OP (432 D-06/D-07, superseding 394's propose-plus-apply). The edited
// document is staged on the draft shelf, then written over the file it edited through the shelf's
// direct writer — guarded by the digest of the bytes this op read, so a file that changed in the
// meantime is refused rather than overwritten. No git, no proposal waiting for a person. The answer
// points at the written file, so `agent_qa_refine_test`'s verify arm judges the test as written.

import {
  AuthoringDraftEditInputSchema,
  AuthoringDraftEditOutputSchema,
  TestEditPatchSetSchema,
  isEditablePointer,
} from '@vostride/agent-qa-schema'
import type {
  AuthoringDraftEditInput,
  AuthoringDraftEditOutput,
  PatchOp,
  TestEditPatchSet,
} from '@vostride/agent-qa-schema'

import { bindEntityNames } from '../../authoring/entity-binding.js'
import type { EntityBinding } from '../../authoring/entity-binding.js'
import { refuseLiteralSecretMarkers } from '../../authoring/loop.js'
import { buildTieredPrompt } from '../../prompt/tiered-prompt-builder.js'
import { FunctionNotBoundError } from '../spec.js'
import type { ClauseVerdict, FunctionSpec } from '../spec.js'

export const AUTHORING_DRAFT_EDIT_FUNCTION_ID = 'authoring.draft.edit'

/**
 * The `agent_context` this op carries into the ONE tiered prompt builder (389 D-04).
 *
 * Pinned, and distinct from the loop's two, for the reason those are pinned: it lands in the stable
 * tier, which is the byte prefix a provider's prompt cache keys on.
 */
export const AUTHORING_EDIT_AGENT_CONTEXT =
  'authoring.draft.edit — express a requested change to an existing test as RFC-6902 patches'

/** The bound ref named a file this host cannot resolve to a parsable test. */
export class EditTargetUnreadableError extends Error {
  constructor(readonly testRef: string, readonly reason: string) {
    super(`${AUTHORING_DRAFT_EDIT_FUNCTION_ID}: ${testRef} is not an editable test: ${reason}`)
    this.name = 'EditTargetUnreadableError'
  }
}

/**
 * The ref bound to an entity this build cannot open a file for.
 *
 * A NAMED refusal rather than a guess at a path. A resolved descriptor names a real entity, and a
 * store that did not report a test identity has told this layer it cannot say which file that is —
 * recovering one from the entity's title would be exactly the plausible-but-wrong attribution the
 * render-never-recompute boundary exists to refuse.
 */
export class EditTargetHasNoFileError extends Error {
  constructor(readonly testRef: string, readonly boundRef: string) {
    super(
      `${AUTHORING_DRAFT_EDIT_FUNCTION_ID}: "${testRef}" bound to ${boundRef}, which names a real `
        + 'entity that this host cannot resolve to a test file; nothing was edited',
    )
    this.name = 'EditTargetHasNoFileError'
  }
}

/** The model emitted something that is not a `{thoughts, patches}` set. */
export class EditPatchSetUnparsableError extends Error {
  constructor(readonly reason: string) {
    super(`${AUTHORING_DRAFT_EDIT_FUNCTION_ID}: the emitted edit is not a patch set: ${reason}`)
    this.name = 'EditPatchSetUnparsableError'
  }
}

/**
 * A patch addressed a document root outside the editable region (T-394-36).
 *
 * THE SAME PREDICATE THE APPLIER USES, ASKED ON THIS SIDE OF THE PORT. `isEditablePointer` is
 * exported from `schema` precisely so the fence is expressible where the applier is not, and the
 * host runs it again over the whole set before any mutation. That is the two-sided posture this
 * phase applies to every rule that matters — not a second fence with its own idea of the region,
 * because both sides read the one exported predicate over the one pinned root set.
 *
 * The value of asking here is that a retarget is refused before a model's emission reaches the
 * host at all, and the refusal is a class a caller in this layer can catch by name rather than a
 * host error arriving as prose.
 */
export class EditRegionRefusedError extends Error {
  constructor(readonly offendingPaths: readonly string[]) {
    super(
      `${AUTHORING_DRAFT_EDIT_FUNCTION_ID}: ${offendingPaths.length} patch path(s) address a `
        + `document root outside the editable region (${offendingPaths.join(', ')}); the WHOLE set `
        + 'was refused and nothing was staged',
    )
    this.name = 'EditRegionRefusedError'
  }
}

/** The patched document no longer parses as a test. Nothing was staged. */
export class EditResultUnparsableError extends Error {
  constructor(readonly reason: string) {
    super(
      `${AUTHORING_DRAFT_EDIT_FUNCTION_ID}: applying the edit produced a document that is not a `
        + `parsable test, so nothing was staged: ${reason}`,
    )
    this.name = 'EditResultUnparsableError'
  }
}

/**
 * The WHOLE set is refused on the first offending path, never partially applied.
 *
 * The applier's own posture (394-03) and the repair fence's (394-06), for the same reason: a
 * per-op check would already have rewritten the legitimate target before it refused the retarget,
 * which leaves a half-edited document behind on the one path where correctness matters most.
 */
function fenceRegion(patchSet: TestEditPatchSet): void {
  const offending = patchSet.patches
    .map((patch: PatchOp) => patch.path)
    .filter((path) => !isEditablePointer(path))
  if (offending.length > 0) throw new EditRegionRefusedError(offending)
}

/** The bound target's identity, or the named refusal for a binding with no file behind it. */
function identityOf(binding: EntityBinding, testRef: string) {
  if (binding.identity === undefined) throw new EditTargetHasNoFileError(testRef, binding.ref)
  return binding.identity
}

export const authoringDraftEditSpec: FunctionSpec<
  AuthoringDraftEditInput,
  AuthoringDraftEditOutput
> = {
  id: AUTHORING_DRAFT_EDIT_FUNCTION_ID,
  summary: 'Apply a requested change to an existing test and write it, answering the diff it applied.',
  resultKind: 'unary',
  // The WRITE half — a host with no model and no shelf cannot express an edit at all. The read
  // half (`draftEvaluation`, which resolves and parses the committed target) is checked by the same
  // name inside the invoke, on `authoring-draft-write.ts`'s precedent: `boundThrough` names one
  // key, and a host missing the other would otherwise list this op `bound` and then fail far from
  // whichever half was forgotten.
  boundThrough: 'draftShelf',
  input: AuthoringDraftEditInputSchema,
  output: AuthoringDraftEditOutputSchema,
  // This op takes one model call, starts zero runs, and writes one file: the test it edited, over
  // the exact bytes it read.
  risk: {
    name: `fn:${AUTHORING_DRAFT_EDIT_FUNCTION_ID}`,
    recognized: true,
  },
  /**
   * An edit that returned STAGED a draft — there is no arm where it did not (399.1 D-01).
   *
   * Every refusal this op can make is a THROW (the never-guess binder, the region fence, the
   * parser), which already reaches the engine's own `failed` mapping. What returns is one shape,
   * and the honest report of it is what was edited and how much changed.
   */
  classify(output): ClauseVerdict {
    const file = output.written
    if (file.kind === 'not-written') {
      return {
        status: file.reason === 'write-failed' ? 'failed' : 'refused',
        outcome: `not edited ${output.editedFrom.testName} — ${file.reason}`,
      }
    }
    return {
      status: 'executed',
      outcome: `edited ${output.editedFrom.testName} — ${output.patches.length} patch op(s) written `
        + `to ${file.filePath}`,
    }
  },
  async invoke(input, deps) {
    const shelf = deps.draftShelf
    const evaluation = deps.draftEvaluation
    if (shelf === undefined || evaluation === undefined) {
      throw new FunctionNotBoundError(AUTHORING_DRAFT_EDIT_FUNCTION_ID)
    }

    // 1. WHICH TEST. Never guessed at (D-19): an exact address is parsed, and anything else goes to
    //    the house resolver, whose ambiguity and low-confidence arms are typed refusals that end
    //    this invocation with nothing edited.
    const [binding] = await bindEntityNames([input.testRef], { entities: deps.entities })
    if (binding === undefined) throw new EditTargetUnreadableError(input.testRef, 'no binding')
    const identity = identityOf(binding, input.testRef)

    // 2. ITS BYTES, through the shipped resolution that already answers the workspace-boundary
    //    question by name. The refusal arms collapse to one class here because the caller's next
    //    move is the same for all of them — the ref named something this host will not edit — and
    //    the arm is carried as the reason rather than lost.
    const resolution = await evaluation.resolveDraft(identity.filePath)
    if (resolution.kind !== 'parsed') {
      throw new EditTargetUnreadableError(input.testRef, resolution.kind)
    }
    // The bound NAME must be the test that is actually there. A file whose single test has been
    // renamed since the ref was minted would otherwise be edited under somebody else's name.
    if (resolution.draft.testName !== identity.testName) {
      throw new EditTargetUnreadableError(
        input.testRef,
        `the file holds "${resolution.draft.testName}", not "${identity.testName}"`,
      )
    }

    // 3. ONE model call through the ONE builder, and one only. A retry hidden here would make this
    //    verb's cost a number nobody counted.
    const request = buildTieredPrompt({
      agent_context: AUTHORING_EDIT_AGENT_CONTEXT,
      stable: [
        {
          title: 'Role',
          body: 'You edit an existing agent-qa test document. Reply with ONE JSON object and '
            + 'nothing else: {"thoughts": string, "patches": [...]}, where each patch is an '
            + 'RFC-6902 op with "op" one of add/remove/replace, a JSON Pointer "path", and for '
            + 'add/replace a string "value". Only /steps, /name and /context may be addressed — '
            + 'the target application and the test identity are not yours to change. Change as '
            + 'little as the request needs.',
        },
      ],
      context: [
        { title: 'The requested change', body: input.intent },
        {
          title: 'The test as it stands',
          body: [
            `Test name: ${resolution.draft.testName}`,
            'Steps, in order:',
            ...resolution.draft.steps.map((step, index) => `  ${index}. ${step}`),
          ].join('\n'),
        },
      ],
      volatile: [],
    })

    const model = await shelf.model()
    const emitted = await model.generate(request)

    // 4. THE CONTRACT, then the FENCE, then the mutation — in that order, because a set that is
    //    refused must be refused before anything is staged.
    let json: unknown
    try {
      json = JSON.parse(emitted.text)
    } catch (error) {
      throw new EditPatchSetUnparsableError(`it is not JSON (${(error as Error).message})`)
    }
    const parsed = TestEditPatchSetSchema.safeParse(json)
    if (!parsed.success) {
      throw new EditPatchSetUnparsableError(parsed.error.issues[0]?.message ?? 'shape refused')
    }
    fenceRegion(parsed.data)

    // 5. THE SAME APPLIER THE REPAIR LOOP USES, reached through the port because it needs the yaml
    //    CST and this package may not depend on `core`. Reusing it is what makes "an edit never
    //    reformats an untouched line" a property this op inherits from a frozen byte-diff corpus
    //    rather than one it would have to re-prove for a second implementation.
    const staged = await shelf.applyPatches(resolution.draft, parsed.data)
    if (staged.kind === 'unparsable') throw new EditResultUnparsableError(staged.reason)

    // 6. 2026-10-14 (441-03, D-10): the loop's literal-marker check, before anything is written.
    refuseLiteralSecretMarkers(staged.draft)

    const stagedRef = {
      filePath: staged.draft.filePath,
      testId: staged.draft.testId,
      testName: staged.draft.testName,
      contentDigest: staged.draft.contentDigest,
    }

    // 7. THE WRITE (432 D-06/D-07), over the file this op read, and only if it still holds exactly
    //    the bytes it read. The parser, the patch schema, the region fence and the marker check
    //    above have all passed by now; the writer adds the workspace boundary and the digest guard.
    const written = await shelf.publish({
      draftPath: staged.draft.filePath,
      targetPath: identity.filePath,
      sourceDigest: resolution.draft.contentDigest,
    })
    const draftRef = written.kind === 'written'
      ? { ...stagedRef, filePath: written.filePath }
      : stagedRef

    return {
      draftRef,
      editedFrom: {
        filePath: identity.filePath,
        testName: identity.testName,
        boundBy: binding.source,
      },
      patches: parsed.data.patches,
      thoughts: parsed.data.thoughts,
      written,
    }
  },
}
