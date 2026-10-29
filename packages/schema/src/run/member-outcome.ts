import type { RunStatus } from './run-status'

/**
 * The member-level test outcome union. A superset of the aggregate
 * {@link RunStatus} adding `'skipped'` — a member-level concept that can never be
 * an aggregate verdict (an all-skipped run is vacuously `passed`). Splitting this
 * off `RunStatus` keeps aggregate-verdict positions terminal-only while letting a
 * per-test outcome carry the suite runner's existing skip support.
 */
export type MemberTestOutcome = RunStatus | 'skipped'
