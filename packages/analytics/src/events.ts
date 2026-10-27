// THE CLOSED EVENT UNION (Phase 398 plan 03, D-18 · ANLY-01).
//
// WHAT THIS FILE IS FOR. The process this package runs in holds customer credentials, and the only
// thing standing between them and a third-party endpoint is what an event is ALLOWED to carry. The
// v1 module answered that question with `.strip()` schemas whose string fields were
// `z.string().min(1).optional()` — `model_name`, `provider_mode`, `app_state`,
// `execution_destination`, `browser_name` and eight more. Every one of them was a field into which
// any string in the process could be written and would be sent, and `.strip()` meant an unexpected
// key was silently DROPPED rather than refused, so nobody ever found out.
//
// Both defects are abolished by construction here, not patched:
//
//   1. `.strictObject` everywhere. An unknown key REFUSES at parse. A caller who invents a field is
//      told; a caller who smuggles one is stopped. There is no `.strip(` anywhere in this package
//      and a cell asserts that over the source.
//   2. NO UNCONSTRAINED STRING EXISTS. Every string-typed field in every member draws from a
//      `z.enum`, a `z.literal`, or a known-id codec that is BOTH tagged and refined. The rule is
//      mechanical: `assertNoUnconstrainedStrings` walks the union and throws naming the member and
//      the field path, and a planted plain string reds it. A free-text field is unrepresentable,
//      not discouraged.
//
// WHAT IS COUNTED RATHER THAN CARRIED. `explain` reports two counters and no query text. The
// abstained query is free text by definition and it is exactly the thing a docs-gap signal wants,
// which is why D-11 keeps that log LOCAL, under `.agent-qa/`, and lets analytics carry the count
// only. If a later phase wants the text, the answer is not a field here.

import { isCanonicalRunId, isCanonicalSuiteId, isCanonicalTestId } from '@vostride/agent-qa-ids'
import { AGENT_QA_TOOL_PROJECTIONS } from '@vostride/agent-qa-mcp'
import { z } from 'zod'

// ---------------------------------------------------------------------------------------------
// The vocabulary primitives
// ---------------------------------------------------------------------------------------------

/**
 * The metadata key `assertNoUnconstrainedStrings` looks for.
 *
 * A tag alone buys NOTHING — the checker also requires the schema to carry at least one check, so a
 * bare `z.string()` wearing this marker still reds. That is deliberate: an allow-list whose entry
 * condition is "say the magic word" is an allow-list anyone can join, and the planted-tag cell
 * exists to keep it that way.
 */
export const ANALYTICS_VOCABULARY_META_KEY = 'analyticsVocabulary'
export const ANALYTICS_KNOWN_ID_MARKER = 'known-id'

/**
 * A string whose whole value space is a codec this repo owns.
 *
 * The predicates come from `@vostride/agent-qa-ids` rather than being restated as regexes: the id
 * shape is that package's to define, and a second spelling of it here would be a second answer to
 * "what is a run id".
 */
function knownId(codec: string, accepts: (value: string) => boolean): z.ZodType<string> {
  return z
    .string()
    .refine(accepts, { message: `expected a ${codec} id` })
    .meta({ [ANALYTICS_VOCABULARY_META_KEY]: ANALYTICS_KNOWN_ID_MARKER, analyticsCodec: codec })
}

// A version is a closed vocabulary too — the set of strings semver admits — and the refinement is
// what makes that true rather than asserted. It is the one string on the base properties.
const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u

const AgentQaVersionSchema = z
  .string()
  .regex(SEMVER_PATTERN, 'expected a semver version')
  .meta({ [ANALYTICS_VOCABULARY_META_KEY]: ANALYTICS_KNOWN_ID_MARKER, analyticsCodec: 'semver' })

/**
 * The known-id fields' guards, as FUNCTIONS a host can call (398-10).
 *
 * Published beside the schemas because an emitter has to make the same decision the schema makes
 * and has to make it BEFORE capture: nothing parses an event on the way to the transport, so a
 * foreign string put on `run_id` is not refused, it is SENT — and `run_id` is a known-id codec
 * precisely so that cannot happen. A host filtering ids for itself would need `@vostride/agent-qa-ids`,
 * which the surface firewall does not admit; asking the package that owns the union is the route
 * that exists. Anything that is not a canonical id becomes an absence, which every field allows.
 */
export function analyticsRunId(value: unknown): string | undefined {
  return typeof value === 'string' && isCanonicalRunId(value) ? value : undefined
}

export function analyticsTestId(value: unknown): string | undefined {
  return typeof value === 'string' && isCanonicalTestId(value) ? value : undefined
}

export function analyticsSuiteId(value: unknown): string | undefined {
  return typeof value === 'string' && isCanonicalSuiteId(value) ? value : undefined
}

const RunIdSchema = knownId('run', isCanonicalRunId)
const TestIdSchema = knownId('test', isCanonicalTestId)
const SuiteIdSchema = knownId('suite', isCanonicalSuiteId)

const NonNegativeInteger = z.number().int().min(0)
const NonNegativeNumber = z.number().min(0)

// ---------------------------------------------------------------------------------------------
// The enumerated vocabularies
// ---------------------------------------------------------------------------------------------

/**
 * WHICH HOST EMITTED, and deliberately NOT the 397 D-04 surface roster.
 *
 * 2026-08-17. The roster answers "which invocation doors does the parity suite measure" and is
 * pinned closed at `chat` and `mcp`. This list answers a different question — which process sent
 * the event — and `cli` and `daemon` are real answers to it while being no kind of surface. Tying
 * the two would make a roster change an analytics schema change for no reason, and would make this
 * list wrong the moment a host emits that is not a door.
 */
export const ANALYTICS_EMITTING_HOSTS = ['cli', 'chat', 'mcp', 'daemon'] as const

// 2026-10-21 (447-02, D-12): a coding agent is a user; its product rides as `agent_product`.
export const ANALYTICS_RUNTIME_CONTEXTS = ['user', 'ci'] as const

// Carried from the v1 module unchanged. Retune when a new coding agent shows up in the wild; the
// `unknown` arm is what keeps an unrecognised one from needing a schema change to be reported.
export const ANALYTICS_AGENT_PRODUCTS = [
  'claude_code',
  'cursor',
  'gemini_cli',
  'augment',
  'goose',
  'opencode',
  'codex',
  'cline',
  'amp',
  'unknown',
] as const

export const ANALYTICS_TRIGGER_SOURCES = ['cli', 'chat', 'mcp', 'daemon', 'unknown'] as const
export const ANALYTICS_RUNNERS = ['local', 'unknown'] as const
export const ANALYTICS_PLATFORMS = ['web', 'android', 'ios', 'unknown'] as const
export const ANALYTICS_RUN_STATUSES = [
  'passed',
  'failed',
  'skipped',
  'cancelled',
  'timeout',
  'unknown',
] as const
export const ANALYTICS_SUITE_EXECUTION_MODES = ['sequential', 'parallel', 'unknown'] as const

// Carried from the v1 module. These are CATEGORIES, never messages: a failure category is a bucket
// this repo defines, while the failure's text is the thing that would carry a credential.
export const ANALYTICS_FAILURE_CATEGORIES = [
  'assertion',
  'timeout',
  'cancelled',
  'setup',
  'hook',
  'appium',
  'browser_install',
  'llm_context',
  'llm_provider',
  'memory',
  'framework',
  'unknown',
] as const

export const ANALYTICS_MCP_SERVER_STATES = ['started', 'stopped'] as const
export const ANALYTICS_MCP_TRANSPORTS = ['stdio', 'http'] as const
export const ANALYTICS_MCP_TOOL_STATUSES = ['success', 'error'] as const
export const ANALYTICS_MCP_ERROR_CATEGORIES = [
  'validation',
  'scope_denied',
  'unknown_tool',
  'tool_error',
  'unknown',
] as const

export const ANALYTICS_DAEMON_JOB_KINDS = ['run', 'suite', 'recovery', 'unknown'] as const
export const ANALYTICS_DAEMON_JOB_OUTCOMES = [
  'completed',
  'failed',
  'cancelled',
  'abandoned',
  'unknown',
] as const

export const ANALYTICS_INIT_MODES = ['interactive', 'agent', 'scaffold'] as const
export const ANALYTICS_INIT_OUTCOMES = ['created', 'updated', 'unchanged', 'failed'] as const

export const ANALYTICS_CHAT_END_REASONS = ['exit', 'interrupt', 'error', 'unknown'] as const

/**
 * The MCP tool-name vocabulary, PRODUCED from the declared projection table.
 *
 * Not retyped, on purpose: this is the second consumer of the same twelve names, and the first
 * thing a second transcription does is survive a rename that the first one did not.
 */
export const ANALYTICS_MCP_TOOL_NAMES = AGENT_QA_TOOL_PROJECTIONS.map(
  (projection) => projection.name,
) as [string, ...string[]]

// ---------------------------------------------------------------------------------------------
// The properties every member carries
// ---------------------------------------------------------------------------------------------

const BaseProperties = {
  agent_qa_version: AgentQaVersionSchema.optional(),
  surface: z.enum(ANALYTICS_EMITTING_HOSTS).optional(),
  runtime_context: z.enum(ANALYTICS_RUNTIME_CONTEXTS).optional(),
  is_internal: z.literal(true).optional(),
  agent_product: z.enum(ANALYTICS_AGENT_PRODUCTS).optional(),
  // PostHog's own directive, a literal `false` and never anything else: it suppresses person-profile
  // creation, which is what keeps an anonymous distinct id anonymous on their side too.
  $process_person_profile: z.literal(false).optional(),
} as const

function member<TName extends string, TShape extends z.ZodRawShape>(name: TName, shape: TShape) {
  return z.strictObject({
    name: z.literal(name),
    properties: z.strictObject({ ...BaseProperties, ...shape }),
  })
}

// ---------------------------------------------------------------------------------------------
// The members (D-18)
// ---------------------------------------------------------------------------------------------

const RunCompletionShape = {
  trigger_source: z.enum(ANALYTICS_TRIGGER_SOURCES).optional(),
  runner: z.enum(ANALYTICS_RUNNERS).optional(),
  platform: z.enum(ANALYTICS_PLATFORMS).optional(),
  status: z.enum(ANALYTICS_RUN_STATUSES).optional(),
  failure_category: z.enum(ANALYTICS_FAILURE_CATEGORIES).optional(),
  duration_ms: NonNegativeNumber.optional(),
  run_id: RunIdSchema.optional(),
  // 2026-08-28 (405-13, D-21/DETL-06). The parent-link property was deleted here. It was declared
  // with no producer anywhere in this package — 402-09 put one run row per run and moved member
  // identity onto handles, and 405-07 then deleted the column it named — so it could only ever
  // have travelled as `undefined`. Same disposition and same reason as the healing counter below.
  step_count: NonNegativeInteger.optional(),
  passed_step_count: NonNegativeInteger.optional(),
  failed_step_count: NonNegativeInteger.optional(),
  skipped_step_count: NonNegativeInteger.optional(),
  retry_count: NonNegativeInteger.optional(),
  input_tokens: NonNegativeInteger.optional(),
  output_tokens: NonNegativeInteger.optional(),
  total_tokens: NonNegativeInteger.optional(),
  is_flaky: z.boolean().optional(),
  memory_enabled: z.boolean().optional(),
} as const

// 2026-08-17. `model_name`, `provider`, `provider_mode`, `planner_model`, `verifier_model`,
// `browser_name`, `mobile_transport`, `mobile_provider`, `app_state` and `execution_destination`
// were all `z.string().min(1)` in v1 and are GONE rather than ported. Each named a real dimension,
// and each was a hole: a provider id read from a config file lands in the same field as anything
// else that config file happens to hold. Retune: when one of them is wanted back, it comes back as
// an ENUM of the values this repo actually supports, which is a decision with a list attached.

const TestRunCompleted = member('agent-qa.test_run.completed', {
  ...RunCompletionShape,
  test_id: TestIdSchema.optional(),
})

const SuiteRunCompleted = member('agent-qa.suite_run.completed', {
  ...RunCompletionShape,
  suite_id: SuiteIdSchema.optional(),
  suite_child_count: NonNegativeInteger.optional(),
  suite_passed_count: NonNegativeInteger.optional(),
  suite_failed_count: NonNegativeInteger.optional(),
  suite_skipped_count: NonNegativeInteger.optional(),
  suite_execution_mode: z.enum(ANALYTICS_SUITE_EXECUTION_MODES).optional(),
})

// AGGREGATES, never message text. A turn count and a duration say how the product is used; the
// turn's content says what the user was working on, and that is theirs.
const ChatSessionCompleted = member('agent-qa.chat.session.completed', {
  duration_ms: NonNegativeNumber.optional(),
  turn_count: NonNegativeInteger.optional(),
  slash_command_count: NonNegativeInteger.optional(),
  function_call_count: NonNegativeInteger.optional(),
  end_reason: z.enum(ANALYTICS_CHAT_END_REASONS).optional(),
})

const ChatTurnCompleted = member('agent-qa.chat.turn.completed', {
  duration_ms: NonNegativeNumber.optional(),
  tool_call_count: NonNegativeInteger.optional(),
  input_tokens: NonNegativeInteger.optional(),
  output_tokens: NonNegativeInteger.optional(),
  total_tokens: NonNegativeInteger.optional(),
  errored: z.boolean().optional(),
})

const DaemonJobCompleted = member('agent-qa.daemon.job.completed', {
  job_kind: z.enum(ANALYTICS_DAEMON_JOB_KINDS).optional(),
  outcome: z.enum(ANALYTICS_DAEMON_JOB_OUTCOMES).optional(),
  duration_ms: NonNegativeNumber.optional(),
  attempt_count: NonNegativeInteger.optional(),
  run_id: RunIdSchema.optional(),
})

const McpServerLifecycle = member('agent-qa.mcp.server.lifecycle', {
  mcp_server_state: z.enum(ANALYTICS_MCP_SERVER_STATES).optional(),
  mcp_transport: z.enum(ANALYTICS_MCP_TRANSPORTS).optional(),
  mcp_tool_count: NonNegativeInteger.optional(),
})

const McpToolInvoked = member('agent-qa.mcp.tool.invoked', {
  tool_name: z.enum(ANALYTICS_MCP_TOOL_NAMES).optional(),
  mcp_tool_status: z.enum(ANALYTICS_MCP_TOOL_STATUSES).optional(),
  mcp_error_category: z.enum(ANALYTICS_MCP_ERROR_CATEGORIES).optional(),
  mcp_transport: z.enum(ANALYTICS_MCP_TRANSPORTS).optional(),
  duration_ms: NonNegativeNumber.optional(),
})

const InitCompleted = member('agent-qa.init.completed', {
  init_mode: z.enum(ANALYTICS_INIT_MODES).optional(),
  outcome: z.enum(ANALYTICS_INIT_OUTCOMES).optional(),
  created_file_count: NonNegativeInteger.optional(),
  duration_ms: NonNegativeNumber.optional(),
})

// COUNTERS ONLY (D-11 / Pitfall 10). There is no query-text field on either explain member and
// there must never be one: the coverage log under `.agent-qa/` is where the query lives, local to
// the machine, and it is the only place the demand signal SURF-FUT-02 reads is allowed to exist.
const ExplainAnswered = member('agent-qa.explain.answered', {
  cited_row_count: NonNegativeInteger.optional(),
  duration_ms: NonNegativeNumber.optional(),
})

const ExplainAbstained = member('agent-qa.explain.abstained', {
  suggested_row_count: NonNegativeInteger.optional(),
  catalog_empty: z.boolean().optional(),
  duration_ms: NonNegativeNumber.optional(),
})

/**
 * The membership, in the order D-18 states it.
 *
 * The names keep the `agent-qa.` prefix the v33 set used: the events land in a project shared with
 * nothing else today, but a prefix costs nothing and un-prefixing later is a rename of history.
 */
export const ANALYTICS_EVENT_NAMES = [
  'agent-qa.test_run.completed',
  'agent-qa.suite_run.completed',
  'agent-qa.chat.session.completed',
  'agent-qa.chat.turn.completed',
  'agent-qa.daemon.job.completed',
  'agent-qa.mcp.server.lifecycle',
  'agent-qa.mcp.tool.invoked',
  'agent-qa.init.completed',
  'agent-qa.explain.answered',
  'agent-qa.explain.abstained',
] as const

export type AnalyticsEventName = (typeof ANALYTICS_EVENT_NAMES)[number]

/**
 * The v33 names that are NOT members, listed rather than merely absent.
 *
 * 2026-08-17 (Phase 398 plan 03, D-18 · RESEARCH Open Question 2). Two different reasons:
 *
 *   `analytics.initialized` and `analytics.test_event` were TRANSPORT SELF-TESTS — an event whose
 *   only content is "the thing that sends events works" is a diagnostic, and shipping it as product
 *   signal means every dashboard has to remember to exclude it. Dropped outright; the zero-network
 *   differential in plan 06 is the same claim, proven rather than reported.
 *
 *   The three `dashboard.*` rows are dropped BECAUSE THE DASHBOARD IS BEING REBUILT. M5 re-adds
 *   what it needs against this port, which is the right moment to decide what a rebuilt dashboard
 *   is actually worth measuring — carrying the v1 answers forward would have pre-decided it.
 *
 * RETUNE: a name re-added here must be REMOVED from this list in the same change. The disjointness
 * cell fires if it appears in both, so the two lists cannot quietly disagree.
 */
export const RETIRED_V33_EVENT_NAMES = [
  'agent-qa.analytics.initialized',
  'agent-qa.analytics.test_event',
  'agent-qa.dashboard.opened',
  'agent-qa.dashboard.live_mode.started',
  'agent-qa.dashboard.entity.created',
] as const

export const ANALYTICS_EVENT_SCHEMA_BY_NAME = {
  'agent-qa.test_run.completed': TestRunCompleted,
  'agent-qa.suite_run.completed': SuiteRunCompleted,
  'agent-qa.chat.session.completed': ChatSessionCompleted,
  'agent-qa.chat.turn.completed': ChatTurnCompleted,
  'agent-qa.daemon.job.completed': DaemonJobCompleted,
  'agent-qa.mcp.server.lifecycle': McpServerLifecycle,
  'agent-qa.mcp.tool.invoked': McpToolInvoked,
  'agent-qa.init.completed': InitCompleted,
  'agent-qa.explain.answered': ExplainAnswered,
  'agent-qa.explain.abstained': ExplainAbstained,
} as const

export const ANALYTICS_EVENT_MEMBERS = [
  TestRunCompleted,
  SuiteRunCompleted,
  ChatSessionCompleted,
  ChatTurnCompleted,
  DaemonJobCompleted,
  McpServerLifecycle,
  McpToolInvoked,
  InitCompleted,
  ExplainAnswered,
  ExplainAbstained,
] as const

export const AgentQaAnalyticsEventSchema = z.discriminatedUnion('name', ANALYTICS_EVENT_MEMBERS)

export type AgentQaAnalyticsEvent = z.infer<typeof AgentQaAnalyticsEventSchema>

// ---------------------------------------------------------------------------------------------
// The range guard
// ---------------------------------------------------------------------------------------------

/**
 * Walks every member of the union and throws naming the member and the field path of any string
 * that is not drawn from a closed vocabulary.
 *
 * FAIL-CLOSED. A construct this walker does not recognise is reported, not skipped. The alternative
 * — treat the unknown as fine — means the rule silently stops covering whatever zod grows next, and
 * a guard that quietly narrows is worse than no guard, because the suite keeps saying yes.
 *
 * The bar this has to clear is not "the shipped union passes". It is that a planted plain string
 * REDS, that a string wearing the known-id tag without a refinement ALSO reds, and that neither an
 * optional, a record value nor an array element is a place to hide one.
 */
export function assertNoUnconstrainedStrings(members: readonly z.ZodType[]): void {
  const offenders: string[] = []

  for (const memberSchema of members) {
    const name = memberNameOf(memberSchema)
    walk(memberSchema, '', name, offenders)
  }

  if (offenders.length > 0) {
    throw new Error(
      `analytics event union carries unconstrained string field(s):\n  ${offenders.join('\n  ')}`,
    )
  }
}

function memberNameOf(schema: z.ZodType): string {
  if (schema instanceof z.ZodObject) {
    const nameSchema = (schema.shape as Record<string, z.ZodType | undefined>).name
    if (nameSchema instanceof z.ZodLiteral) {
      const values = nameSchema.def.values
      const first = Array.isArray(values) ? values[0] : values
      if (typeof first === 'string') return first
    }
  }
  return '<unnamed member>'
}

function walk(schema: z.ZodType, path: string, member: string, offenders: string[]): void {
  const unwrapped = unwrap(schema)

  if (unwrapped instanceof z.ZodObject) {
    for (const [key, child] of Object.entries(unwrapped.shape as Record<string, z.ZodType>)) {
      walk(child, path === '' ? key : `${path}.${key}`, member, offenders)
    }
    return
  }

  if (unwrapped instanceof z.ZodEnum || unwrapped instanceof z.ZodLiteral) return
  if (
    unwrapped instanceof z.ZodNumber
    || unwrapped instanceof z.ZodBoolean
    || unwrapped instanceof z.ZodNull
    || unwrapped instanceof z.ZodUndefined
  ) {
    return
  }

  if (unwrapped instanceof z.ZodArray) {
    walk(unwrapped.element as z.ZodType, path, member, offenders)
    return
  }

  if (unwrapped instanceof z.ZodRecord) {
    walk(unwrapped.keyType as z.ZodType, path, member, offenders)
    walk(unwrapped.valueType as z.ZodType, path, member, offenders)
    return
  }

  if (unwrapped instanceof z.ZodUnion) {
    for (const option of unwrapped.options as readonly z.ZodType[]) {
      walk(option, path, member, offenders)
    }
    return
  }

  if (unwrapped instanceof z.ZodString) {
    if (!isKnownIdCodec(unwrapped)) {
      offenders.push(`${member} :: ${path} | unconstrained string`)
    }
    return
  }

  offenders.push(`${member} :: ${path} | unrecognised construct, cannot prove it is constrained`)
}

/**
 * Two conditions, both required.
 *
 * The TAG says a human decided this string is an identifier from a codec this repo owns. The CHECK
 * is what makes that decision true of the values rather than of the intention — without it the tag
 * is a comment with a runtime cost, and tagging becomes the escape hatch from the rule.
 */
function isKnownIdCodec(schema: z.ZodString): boolean {
  const meta = schema.meta() as Record<string, unknown> | undefined
  if (meta?.[ANALYTICS_VOCABULARY_META_KEY] !== ANALYTICS_KNOWN_ID_MARKER) return false
  return (schema.def.checks ?? []).length > 0
}

function unwrap(schema: z.ZodType): z.ZodType {
  let current: z.ZodType = schema
  for (;;) {
    if (
      current instanceof z.ZodOptional
      || current instanceof z.ZodNullable
      || current instanceof z.ZodReadonly
    ) {
      current = current.unwrap() as z.ZodType
      continue
    }
    if (current instanceof z.ZodDefault) {
      current = current.def.innerType as z.ZodType
      continue
    }
    return current
  }
}
