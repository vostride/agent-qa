export type { Job, JobKind, JobStatus, JobConclusionKind } from './job'
export { isJobKind, jobSchema } from './job'
export type { JobId } from './job-id'
export { asJobId } from './job-id'

// the agent job queue's request, checkpoint-envelope and
// handler-outcome vocabulary. Minted here rather than on the port because these three cross
// boundaries that need a runtime check — a caller in another process, a file written by an
// earlier build, a handler's returned data — and a port type is erased before any of that.
export type { ChainedJobRequest, JobEnqueueRequest } from './job-enqueue'
export { chainedJobRequestSchema, jobEnqueueRequestSchema } from './job-enqueue'
export type { JobCheckpointEnvelope } from './job-checkpoint'
export { JOB_CHECKPOINT_SCHEMA_VERSION, jobCheckpointEnvelopeSchema } from './job-checkpoint'
export type { JobHandlerOutcome } from './job-outcome'
export { jobHandlerOutcomeSchema } from './job-outcome'
// the `analyze-run` payload mirror, validated at the ENQUEUE site. Homed
// here in `job/` rather than a second near-homographic `jobs/` directory — `JobKind` already
// names 'analyze-run', so this is this module's own vocabulary.
export { AnalyzeRunPayloadSchema } from './analyze-run-payload'
export type { AnalyzeRunPayload } from './analyze-run-payload'
