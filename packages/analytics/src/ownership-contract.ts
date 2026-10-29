import type { OwnershipContract } from '@vostride/agent-qa-arch'

export const AGENT_QA_ANALYTICS_PACKAGE_NAME = '@vostride/agent-qa-analytics'
export const AGENT_QA_ANALYTICS_PACKAGE_DIR = 'packages/analytics'
export const AGENT_QA_ANALYTICS_PACKAGE_CLASSES = ['adapter'] as const
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
// `id-agent` stays on the version `packages/ids` resolves: installs are keyed on its id scheme.
export const AGENT_QA_ANALYTICS_EXTERNAL_DEPENDENCIES = [
  'id-agent',
  'posthog-node',
  'zod',
] as const
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
