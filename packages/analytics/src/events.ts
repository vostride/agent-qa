// Every member is a strict object and every string field an enum, literal or known-id codec.

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

// Emitters call these before capture, because nothing parses an event on its way to the transport.
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

// Which process sent the event, apart from the surface roster, so `cli` and `daemon` appear.
export const ANALYTICS_EMITTING_HOSTS = ['cli', 'chat', 'mcp', 'daemon'] as const

// A coding agent is a user; its product rides as `agent_product`.
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

const RunCompletionShape = {
  trigger_source: z.enum(ANALYTICS_TRIGGER_SOURCES).optional(),
  runner: z.enum(ANALYTICS_RUNNERS).optional(),
  platform: z.enum(ANALYTICS_PLATFORMS).optional(),
  status: z.enum(ANALYTICS_RUN_STATUSES).optional(),
  failure_category: z.enum(ANALYTICS_FAILURE_CATEGORIES).optional(),
  duration_ms: NonNegativeNumber.optional(),
  run_id: RunIdSchema.optional(),
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

// Counters only: the query text stays in the local coverage log under `.agent-qa/`.
const ExplainAnswered = member('agent-qa.explain.answered', {
  cited_row_count: NonNegativeInteger.optional(),
  duration_ms: NonNegativeNumber.optional(),
})

const ExplainAbstained = member('agent-qa.explain.abstained', {
  suggested_row_count: NonNegativeInteger.optional(),
  catalog_empty: z.boolean().optional(),
  duration_ms: NonNegativeNumber.optional(),
})

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

// Retired names; a name re-added to the union must leave this list, or the disjointness cell fails.
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
