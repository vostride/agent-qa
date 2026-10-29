// Refusals the store owns are declared here; those the port owns are re-exported, never redeclared.

import { JOB_CHECKPOINT_SCHEMA_VERSION } from '@vostride/agent-qa-schema'

// Both are the second case the rule above describes: the PORT declares them, this module
// re-exports them. `QuarantinedJobRequeueError` is a condition of the requeue CONTRACT — every
// store that implements `requeueTerminal` owes the same refusal — so a second class declared here
// would let two stores disagree about what an operator is being told.
export { QuarantinedJobRequeueError, StaleJobStoreEpochError } from '@vostride/agent-qa-agent'

// No migration: the message names the agent job queue's state as the thing to clear.
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

// Validated before any join, because an id validated after joining has already escaped.
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
