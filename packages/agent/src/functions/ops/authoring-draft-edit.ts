// Writes over the read file only while it holds the read digest; the gates are not re-run.

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

// Pinned, because it lands in the stable tier the provider's prompt cache keys on.
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

// The applier's own `isEditablePointer`, asked early so a retarget is a named refusal.
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

// The whole set is refused on the first bad path, so no half-edited document is left behind.
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
  // Every refusal throws, so a returned value always staged a draft.
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

    // Never guessed: an exact address parses, and the resolver's other arms refuse by type.
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

    // The literal-marker check runs before anything is written.
    refuseLiteralSecretMarkers(staged.draft)

    const stagedRef = {
      filePath: staged.draft.filePath,
      testId: staged.draft.testId,
      testName: staged.draft.testName,
      contentDigest: staged.draft.contentDigest,
    }

    // Writes only if the file still holds exactly the bytes this op read.
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
