// `authoring.draft.verify` — the keep-gate evaluator as a catalogued capability (393, D-01).
//
// The four keep-gates are not a private power of whatever writes tests. D-01 registers the
// evaluator so the corpus proof drives the REAL gated entry point (the produced-not-literal law),
// so 397's registry-walk conformance and 396's MCP projection inherit it with no harness change,
// and so the standalone question — "is this existing test worth keeping?" — is answerable from
// every surface rather than only from inside 394's loop.
//
// THE ID IS `authoring.draft.verify`, NOT `authoring.verify_draft` (2026-08-10, this plan).
// D-01 sketches the shape as `authoring.verify_draft(ref) → receipt` and leaves the exact naming
// to 384's conventions. Two shipped mechanisms make the underscore spelling impossible, and both
// were measured before choosing:
//   1. `parity-coverage.test.ts` requires every id to match `^[a-z]+(?:\.[a-z]+)+$` — the fixed
//      dot taxonomy of D-15. An underscore fails it, which is also why the shipped catalogue reads
//      `runs.postprocessing` rather than `runs.post_processing`.
//   2. `chat/tool-names.ts` maps ids onto provider-safe tool names by `.` ↔ `_`, and REFUSES an id
//      already carrying `_` because such a name has two pre-images under the inverse. Since 392
//      D-07 binds every registry op into the planner's toolset, an underscore id would not merely
//      look unconventional — it would raise `ChatToolNameError` for the whole projection.
// Three segments rather than two, on the `knowledge.records.inspect` precedent (and the deleted
// `knowledge.proposal.apply`'s, 432-17): `draft` is the subject and `verify` is the verb, which keeps the ratified word in the
// id and leaves 394 room for `authoring.draft.write` beside it.
//
// THE OP IS COMPOSITION, NOT MECHANISM. Every gate lives in `../../authoring/`; what is added here
// is the entry point, its refusals, and the tier it is classified at. The four ports one
// evaluation runs against are assembled at `composeLocalAgent()` and arrive through the
// OPTIONAL `draftEvaluation` dep, so a host that cannot parse a draft or start a run lists this
// capability `unbound` BY NAME rather than as a hole in the catalogue.
//
// INPUT REFUSAL IS THE POINT OF THE FIRST HALF OF `invoke`. 392 D-07 makes this op chat-reachable
// the moment it registers, so `draftPath` is a string an arbitrary caller chose. Every way it can
// be wrong answers with a NAMED error rather than with a run started against a path nobody
// checked.

import { AuthoringVerifyDraftInputSchema, DraftReceiptSchema } from '@vostride/agent-qa-schema'
import type { AuthoringVerifyDraftInput, DraftReceipt } from '@vostride/agent-qa-schema'

import { evaluateDraft } from '../../authoring/verify-draft.js'
import { FunctionNotBoundError } from '../spec.js'
import type { ClauseVerdict, FunctionSpec } from '../spec.js'

export const AUTHORING_DRAFT_VERIFY_FUNCTION_ID = 'authoring.draft.verify'

/**
 * The extensions a draft file may carry.
 *
 * A CLOSED SET checked on the whole suffix, never a substring: `notes.yaml.bak` ends in neither
 * member and is refused, which a `.includes('.yaml')` test would have accepted. The corpus and
 * every authored test in this project is YAML through `parseTestFile`, so there is no third
 * spelling to admit — and widening this is a retune with a visible edit rather than a silent
 * acceptance of whatever a caller names.
 */
const DRAFT_FILE_EXTENSIONS: readonly string[] = ['.yaml', '.yml']

/**
 * The caller named a path this host cannot see.
 *
 * The FIRST of four refusals, and they are separate classes rather than one error with a `kind`
 * because a caller legitimately distinguishes them: a missing file is a typo or an unwritten
 * draft, a directory is a wrong argument, an escaping path is a boundary violation worth
 * reporting, and an unparsable file is a draft that needs fixing rather than moving. One class
 * with a discriminator would make every one of those `catch` blocks read a string.
 */
export class DraftFileNotFoundError extends Error {
  constructor(readonly draftPath: string) {
    super(`${AUTHORING_DRAFT_VERIFY_FUNCTION_ID}: no draft file exists at ${draftPath}`)
    this.name = 'DraftFileNotFoundError'
  }
}

/** The path resolves to something that is not a regular file — a directory, a device, a socket. */
export class DraftNotAFileError extends Error {
  constructor(readonly draftPath: string) {
    super(
      `${AUTHORING_DRAFT_VERIFY_FUNCTION_ID}: ${draftPath} is not a regular file, `
        + 'so there are no draft bytes to evaluate',
    )
    this.name = 'DraftNotAFileError'
  }
}

/**
 * The path names something outside the workspace this host serves.
 *
 * The boundary is enforced by the BOUND capability, because the resolved workspace root is a fact
 * only a host knows and `packages/agent` is `storageNeutral` — it cannot resolve a path, let alone
 * stat one. What lives here is the caller-facing NAME for the refusal, so the boundary check and
 * the vocabulary a caller catches do not have to live in the same package.
 */
export class DraftOutsideWorkspaceError extends Error {
  constructor(readonly draftPath: string) {
    super(
      `${AUTHORING_DRAFT_VERIFY_FUNCTION_ID}: ${draftPath} resolves outside the workspace `
        + 'this host serves; a draft is evaluated where it lives, never fetched from elsewhere',
    )
    this.name = 'DraftOutsideWorkspaceError'
  }
}

/** The file exists and is a file, and the test parser could not make a test out of it. */
export class DraftUnparsableError extends Error {
  constructor(readonly draftPath: string, readonly detail: string) {
    super(`${AUTHORING_DRAFT_VERIFY_FUNCTION_ID}: ${draftPath} is not a parsable test: ${detail}`)
    this.name = 'DraftUnparsableError'
  }
}

/** The path does not end in a test-file extension this host will read. */
export class DraftNotAYamlFileError extends Error {
  constructor(readonly draftPath: string) {
    super(
      `${AUTHORING_DRAFT_VERIFY_FUNCTION_ID}: ${draftPath} does not end in `
        + `${DRAFT_FILE_EXTENSIONS.join(' or ')}, so it is not a test file this host parses`,
    )
    this.name = 'DraftNotAYamlFileError'
  }
}

function hasDraftExtension(draftPath: string): boolean {
  const lowered = draftPath.toLowerCase()
  return DRAFT_FILE_EXTENSIONS.some((extension) => lowered.endsWith(extension))
}

export const authoringVerifyDraftSpec: FunctionSpec<AuthoringVerifyDraftInput, DraftReceipt> = {
  id: AUTHORING_DRAFT_VERIFY_FUNCTION_ID,
  summary: 'Evaluate a draft test against the four keep-gates and return its receipt.',
  // no scopes. The evaluation STARTS runs and READS the completed
  // records back, and the composition invokes those sibling ops on a caller it mints (D-02,
  // op-calls-op). The `run` + `read` pair once declared here kept a nested call from widening a
  // grant; with no grants to widen, every door can call this op and its siblings alike.
  resultKind: 'unary',
  boundThrough: 'draftEvaluation',
  input: AuthoringVerifyDraftInputSchema,
  output: DraftReceiptSchema,
  // Verifying a draft spends this machine's resources, writes into this project's run directory and
  // its gitignored receipts store, and leaves no trace in the shared signals a colleague reads,
  // because every gate-run is flagged `excludedFromOutcomes`.
  risk: {
    name: `fn:${AUTHORING_DRAFT_VERIFY_FUNCTION_ID}`,
    recognized: true,
  },
  /**
   * A RECEIPT'S VERDICT ABOUT A DRAFT IS AN ANSWER, not a refusal (399.1 D-01, plan 03's razor).
   *
   * `rejected` here is the gate saying what it found about somebody's draft — the verification ran
   * and produced its finding. `refused` is for a control declining an act it would otherwise have
   * carried out, and nothing was declined: the act WAS carrying out the verification.
   */
  classify(output): ClauseVerdict {
    return {
      status: 'executed',
      outcome: `verified — disposition ${output.disposition}, `
        + `${output.gateRuns.length} gate run(s)`,
    }
  },
  async invoke(input, deps) {
    // `invokeFunction` already refused this composition on the same fact, so reaching here with no
    // port means an in-layer caller holding the spec directly. The unbound state has no back door:
    // the refusal is the same named error either way (384, D-09).
    const draftEvaluation = deps.draftEvaluation
    if (draftEvaluation === undefined) {
      throw new FunctionNotBoundError(AUTHORING_DRAFT_VERIFY_FUNCTION_ID)
    }

    // The one refusal that needs no host: a suffix is a fact about the string. Checked BEFORE the
    // resolution so a caller who named `runs/` or a binary gets the answer that tells them what
    // this op reads, rather than a stat result about a path it was never going to parse.
    if (!hasDraftExtension(input.draftPath)) {
      throw new DraftNotAYamlFileError(input.draftPath)
    }

    const resolution = await draftEvaluation.resolveDraft(input.draftPath)
    switch (resolution.kind) {
      case 'not-found':
        throw new DraftFileNotFoundError(input.draftPath)
      case 'not-a-file':
        throw new DraftNotAFileError(input.draftPath)
      case 'outside-workspace':
        throw new DraftOutsideWorkspaceError(input.draftPath)
      case 'unparsable':
        throw new DraftUnparsableError(input.draftPath, resolution.reason)
      case 'parsed':
        break
    }

    // The ports are opened only once the draft is known good, so a refused path costs no database
    // handle and no suite walk. `draftMode` is spread rather than assigned through: the evaluator
    // reads absence, and a present `undefined` would be a second spelling of "not draft mode".
    // `sessionRef` rides the same idiom for a sharper reason — the receipt's absence-is-exclusion
    // rule means a present `undefined` and an absent key have to stay the same thing all the way
    // to the mint.
    const ports = await draftEvaluation.openEvaluation(resolution.draft)
    return evaluateDraft(
      {
        draft: resolution.draft,
        ...(input.draftMode === undefined ? {} : { draftMode: input.draftMode }),
        ...(input.sessionRef === undefined ? {} : { sessionRef: input.sessionRef }),
        // Same spread idiom, same reason: the evaluator reads ABSENCE as "the draft's own file is
        // the target", and a present `undefined` would be a second spelling of it.
        ...(input.targetSuitePath === undefined
          ? {}
          : { targetSuitePath: input.targetSuitePath }),
      },
      ports,
    )
  },
}
