import type { OwnershipContract } from '@vostride/agent-qa-arch'

export const AGENT_QA_ANALYTICS_PACKAGE_NAME = '@vostride/agent-qa-analytics'
export const AGENT_QA_ANALYTICS_PACKAGE_DIR = 'packages/analytics'
// 2026-08-17. `adapter` and nothing else. It is not `surface`: a surface
// is an invocation door with dispatch, policy and gate verdicts, and this package answers no
// request — hosts call INTO it. It is not `browserSafe`/`storageNeutral`/`providerNeutral` either,
// because the whole point of the boundary is that the one place holding a live network client to a
// third party sits inside a named wall rather than scattered through a host.
export const AGENT_QA_ANALYTICS_PACKAGE_CLASSES = ['adapter'] as const
// 2026-08-17. The v1 module this replaces had no stated
// responsibilities at all — it was a folder inside `core`, which is exactly how it acquired a
// module-level singleton, a privacy decision made inside `capture()`, and `.strip()` schemas that
// admitted free text. Each line below is one of those defects restated as something this package
// owns rather than something a reviewer has to notice.
export const AGENT_QA_ANALYTICS_ALLOWED_RESPONSIBILITIES = [
  'the product-analytics port and its transports: the `AnalyticsPort`/`AnalyticsTransport` split, '
    + 'the PostHog transport behind it, and the best-effort boundary that keeps a '
    + 'telemetry failure from reaching the host',
  'the closed typed event union: which events exist, what each one carries, and the range guard '
    + 'that refuses an unconstrained string field',
  'the opt-out decision: resolving the config privacy flag ONCE, at composition, to a transport — '
    + 'never inside a send path',
  'the send seam applying the host\'s declared-secret mask, before any serialization-dependent '
    + 'matching',
  // 2026-08-17 (Phase 398 plan 06 task 3, D-17). Both lines describe things MOVED here from
  // `packages/core/src/analytics/`, and both are stated as contract-preserving on purpose: the
  // identity record is already on disk in every install, and the subscriber's bus-facing shape is
  // what a host attaches. Owning them means owning the promise that neither drifts silently.
  'the anonymous identity store: the persisted distinct id, its scheme, and its exactly-two-key '
    + 'record — never a field that identifies a machine, a user or a working directory',
  'the run-completion bus subscriber: accumulating a run\'s member outcomes, step tallies and '
    + 'suite aggregate from the envelope stream and emitting the completion members once',
] as const
// The forbidden lines are the three v1 defects and the one boundary that keeps this package a host
// concern. `no function-layer imports` is the load-bearing one: analytics is something a HOST does
// with the result of a call, never something the agent's function layer can reach, or every op
// would acquire a telemetry side effect the gate never sees.
export const AGENT_QA_ANALYTICS_FORBIDDEN_RESPONSIBILITIES = [
  'reaching the agent function layer or any op: this is a host concern, bound at a composition '
    + 'root, and an op that could emit telemetry would be a side effect the gate never sees',
  'any free-text event field: a string that does not draw from an enum, a literal or a known-id '
    + 'codec is an exfiltration channel, and the range guard exists so that is unrepresentable '
    + 'rather than reviewed',
  'ambient singletons or module-level service state: the v1 module cached one service whose '
    + 'privacy decision belonged to whichever caller constructed it first',
  'a second opt-out decision site: any environment read outside `compose.ts`, or any transport '
    + 'constructed before the decision, re-opens the bypass D-19 closes structurally',
] as const
// 2026-08-17. `posthog-node` is PINNED at 5.33.2 and moves here from
// `packages/core` with no version change — the dependency is the same bytes already in the
// lockfile, relocated between workspace members. A bump is a separate reviewed diff, not a
// side effect of a re-derivation. It leaves core's host baseline in plan 11, with the deletion,
// so `validate:arch` reds on any straggler import at exactly the moment there is a straggler.
// `zod` is the vocabulary the closed event union is written in; it is not a validator of
// convenience here, it IS the no-free-text mechanism.
// 2026-08-17 (Phase 398 plan 06 task 3, D-17). `id-agent` arrives with the identity store, pinned
// at the SAME 1.0.3 `packages/ids` and `packages/core` already resolve — the id scheme is the thing
// existing installs are keyed on, so the generator moving packages must not also move versions.
export const AGENT_QA_ANALYTICS_EXTERNAL_DEPENDENCIES = [
  'id-agent',
  'posthog-node',
  'zod',
] as const
// 2026-08-17 (Phase 398 plan 03 task 3, D-18). Both entries exist for ONE reason each, and both are
// reads of declared data rather than of behaviour.
//
// `ids` supplies the canonical-id predicates the known-id codecs refine against — `isCanonicalRunId`
// and friends. Restating those shapes as regexes here would be a second definition of what a run id
// is, in the package least likely to be updated when the first one changes.
//
// `mcp` supplies the twelve tool NAMES, which are the closed vocabulary the tool-invocation event's
// `tool_name` field draws from. Note the direction: analytics reads the projection table as data
// and reaches nothing in the server. A hand-copied list would be the drift the produced-not-literal
// law exists to prevent — a renamed tool would keep reporting under its old name indefinitely,
// and nothing would say so.
//
// This list is checked against the package's REAL imports, so an entry added in anticipation of a
// later plan is an offender rather than a placeholder.
//
// `safety` leaves; the send seam applies the mask its host hands it.
//
// 2026-08-17 (Phase 398 plan 06 task 3, D-17). `schema` arrives with the run subscriber, and it is
// a TYPE-ONLY read of the frozen bus envelope (§2.2) — the subscriber consumes a projection the
// runner publishes and reaches nothing that produces it. Restating the envelope shape here would be
// a second declaration of the wire contract, in the package least likely to be updated when the
// first one changes; the direction (adapter → schema) is the one the other adapters already take.
export const AGENT_QA_ANALYTICS_INTERNAL_DEPENDENCIES = [
  '@vostride/agent-qa-ids',
  '@vostride/agent-qa-mcp',
  '@vostride/agent-qa-schema',
] as const

export const AGENT_QA_ANALYTICS_OWNERSHIP_CONTRACT = {
  packageName: AGENT_QA_ANALYTICS_PACKAGE_NAME,
  packageDir: AGENT_QA_ANALYTICS_PACKAGE_DIR,
  packageClasses: AGENT_QA_ANALYTICS_PACKAGE_CLASSES,
  allowedResponsibilities: AGENT_QA_ANALYTICS_ALLOWED_RESPONSIBILITIES,
  forbiddenResponsibilities: AGENT_QA_ANALYTICS_FORBIDDEN_RESPONSIBILITIES,
  externalDependencies: AGENT_QA_ANALYTICS_EXTERNAL_DEPENDENCIES,
  internalDependencies: AGENT_QA_ANALYTICS_INTERNAL_DEPENDENCIES,
} as const satisfies OwnershipContract
