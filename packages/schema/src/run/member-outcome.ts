import type { RunStatus } from './run-status'

// `skipped` is a member-level outcome only; an all-skipped run is `passed`.
export type MemberTestOutcome = RunStatus | 'skipped'
