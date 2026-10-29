// Every named refusal the agent job queue's local store raises.
//
// The rule this module exists to state, because a small package with two error files and no
// rule for which one gets what is how a vocabulary forks: a refusal DECLARED here is one the
// storage implementation owns, and a refusal the PORT owns is re-exported here rather than
// re-declared. `StaleJobStoreEpochError` is the second case — 386 binds the real writer lease
// to that exact class, so a second class in this package meaning the same condition would
// hand one situation two identities and make the binding a choice instead of a wiring.
//
// Shapes follow v51's writer-lease convention: `override readonly name`, the observed value
// attached as a field, and a message that names a remedy rather than a symptom.

import { JOB_CHECKPOINT_SCHEMA_VERSION } from '@vostride/agent-qa-schema'

// Both are the second case the rule above describes: the PORT declares them, this module
// re-exports them. `QuarantinedJobRequeueError` is a condition of the requeue CONTRACT — every
// store that implements `requeueTerminal` owes the same refusal — so a second class declared here
// would let two stores disagree about what an operator is being told.
export { QuarantinedJobRequeueError, StaleJobStoreEpochError } from '@vostride/agent-qa-agent'

/**
 * The database on disk was written by a build that does not agree with this one.
 *
 * There is no migration machinery in the agent job queue and there is not meant to be: the
 * milestone ships nothing between releases, so a version that does not match is a development
 * artifact, not a user's history. The message therefore carries the remedy — clear agent job
 * queue state — since an operator reading it can act on that and cannot act on a version number
 * alone. The remedy names WHICH queue because three of them coexist: an operator told to
 * "clear queue state" could reasonably clear the curation queue instead.
 */
export class JobStoreSchemaVersionError extends Error {
  override readonly name = 'JobStoreSchemaVersionError'

  constructor(
    readonly path: string,
    readonly expectedVersion: number,
    readonly observedVersion: number,
  ) {
    super(
      `The agent job store at ${path} is stamped at schema version ${observedVersion}, but ` +
        `this build reads version ${expectedVersion}. There is no migration machinery by ` +
        'design — clear agent job queue state (delete the agent job database and its ' +
        'checkpoint directory) and re-enqueue.',
    )
  }
}

/** A job id that no row answers to. */
export class UnknownJobRowError extends Error {
  override readonly name = 'UnknownJobRowError'

  constructor(readonly jobId: string) {
    super(`No agent job row with id ${jobId}`)
  }
}

/**
 * An id that cannot safely become one path segment.
 *
 * Validated BEFORE any join, following the v51 candidate-id precedent: a job id and a
 * checkpoint id both become directory and file names, and an id validated after joining has
 * already escaped.
 */
export class InvalidJobCheckpointIdError extends Error {
  override readonly name = 'InvalidJobCheckpointIdError'

  constructor(
    readonly field: 'jobId' | 'checkpointId',
    readonly value: string,
  ) {
    super(
      `Unusable ${field} for a checkpoint path: ${JSON.stringify(value)}. A checkpoint id ` +
        'becomes a path segment, so it is validated before the path is built rather than ' +
        'after.',
    )
  }
}

/** A checkpoint file written at a layout version this build does not read. */
export class JobCheckpointSchemaVersionError extends Error {
  override readonly name = 'JobCheckpointSchemaVersionError'

  constructor(
    readonly path: string,
    readonly observedVersion: unknown,
  ) {
    super(
      `Agent job checkpoint ${path} was written at schema version ${String(observedVersion)}, ` +
        `but this build reads version ${JOB_CHECKPOINT_SCHEMA_VERSION}. There is no migration ` +
        'machinery by design — clear agent job queue state and re-enqueue.',
    )
  }
}
