// Composition only: the gates live in `../../authoring/`, and `draftPath` refusals are named.

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

// The host enforces the workspace boundary; this package only names the refusal.
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
  // A rejection is the verification's finding, an answer, never `refused`.
  classify(output): ClauseVerdict {
    return {
      status: 'executed',
      outcome: `verified — disposition ${output.disposition}, `
        + `${output.gateRuns.length} gate run(s)`,
    }
  },
  async invoke(input, deps) {
    // Reached with no port only by an in-layer caller; the refusal is the same named error.
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
