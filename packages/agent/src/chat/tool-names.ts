// The dotted-id ↔ provider-safe tool-name mapping (Phase 392 plan 04, RESEARCH Pitfall 8).
//
// Registry ids are a lowercase dot taxonomy — `runs.start`, `entities.resolve` — and
// several providers reject a tool name containing anything outside `[a-zA-Z0-9_-]`. So the planner
// needs a rename, and the rename needs an INVERSE: what comes back from the model is a tool name,
// and the only thing the function layer answers to is a function id.
//
// SPELLED ONCE, HERE. 396 projects the same registry onto MCP and will need the same rename; if it
// spells its own, a capability's wire name depends on which surface asked, and the two are free to
// drift the first time an id grammar changes. One module, both directions, property-tested over the
// whole registry walk rather than over samples — a collision costs whichever single op happened to
// collide, which is the one defect shape a sample cannot be relied on to contain.
//
// THE MAPPING IS TOTAL ON THE GRAMMAR IT ACCEPTS, AND REFUSES OUTSIDE IT. `.` ↔ `_` is a bijection
// only while ids carry no underscore and no id maps onto a meta-tool name. Both conditions are
// CHECKED rather than assumed, in both directions, because the failure they prevent is silent: a
// tool call misdispatching to a capability nobody asked for.

/** How a registry id separates its domain and verb. */
const FUNCTION_ID_SEPARATOR = '.'

/** What a provider-safe tool name carries in its place. */
const TOOL_NAME_SEPARATOR = '_'

/** The charset the mapping's output is required to stay inside. */
const PROVIDER_SAFE_TOOL_NAME = /^[a-zA-Z0-9_-]+$/

/**
 * The refusal both directions raise. NAMED, because every other refusal this subtree publishes is:
 * a caller that catches it needs to be able to tell "that name is not mappable" apart from a
 * transport failure or a contract complaint.
 */
export class ChatToolNameError extends Error {
  constructor(readonly subject: string, detail: string) {
    super(`${subject}: ${detail}`)
    this.name = 'ChatToolNameError'
  }
}

/**
 * The model's answer for a turn it answers in prose.
 *
 * A first-class action rather than the absence of one: a turn where the person asked a question
 * executes zero ops and returns text, so `the model planned nothing` has to stay distinguishable
 * against `the model answered` — two facts a reader of the log must be able to tell apart.
 *
 * (The backticks are not stylistic. `packages/arch`'s dependency lint reads every source line
 * looking for a specifier, and its pattern is one particular English word ahead of a quoted
 * phrase — so ordinary prose in that shape is reported as an undeclared package import. Two
 * sibling plans have already reddened `validate:arch` this way.)
 */
export const ANSWER_ONLY_TOOL_NAME = 'answer_only'

/**
 * The model's answer for a clause no available tool can carry out.
 *
 * The capability is ABSENT from the registry — 393-395 have not shipped it — so it is absent from
 * the toolset, and this is how the model says so by name instead of improvising with something
 * adjacent. The turn then fails closed naming the clause, with zero executions.
 */
export const MARK_UNHANDLED_TOOL_NAME = 'mark_unhandled'

/** The two orchestration tools, and no others. */
export const CHAT_META_TOOL_NAMES = [ANSWER_ONLY_TOOL_NAME, MARK_UNHANDLED_TOOL_NAME] as const

export type ChatMetaToolName = (typeof CHAT_META_TOOL_NAMES)[number]

/** Whether a tool name belongs to orchestration rather than to a registered capability. */
export function isChatMetaToolName(name: string): name is ChatMetaToolName {
  return (CHAT_META_TOOL_NAMES as readonly string[]).includes(name)
}

/**
 * A registry id, as the provider-facing tool name.
 *
 * Two refusals, and each closes a way the inverse could stop being an inverse:
 *
 *   1. An id already carrying the separator this maps ONTO has two pre-images under the reverse
 *      mapping. There is no honest answer to which one it came from, so there is no name for it.
 *   2. An id whose projected name collides with a meta-tool would make an orchestration call and a
 *      capability call the same bytes on the wire. `answer.only` is a perfectly plausible future op
 *      id, which is exactly why this is a check and not an observation.
 */
export function toToolName(functionId: string): string {
  if (functionId.includes(TOOL_NAME_SEPARATOR)) {
    throw new ChatToolNameError(
      functionId,
      `a function id may not contain "${TOOL_NAME_SEPARATOR}" — the provider-safe tool name uses `
        + 'it as the separator, so such an id would have two pre-images under the reverse mapping '
        + 'and a tool call could dispatch to a capability nobody asked for',
    )
  }
  const name = functionId.replaceAll(FUNCTION_ID_SEPARATOR, TOOL_NAME_SEPARATOR)
  if (isChatMetaToolName(name)) {
    throw new ChatToolNameError(
      functionId,
      `projects onto the orchestration tool "${name}", which would make a capability call and an `
        + 'orchestration call indistinguishable in the model plan',
    )
  }
  if (!PROVIDER_SAFE_TOOL_NAME.test(name)) {
    throw new ChatToolNameError(
      functionId,
      `projects to "${name}", which is outside the provider-safe tool-name charset`,
    )
  }
  return name
}

/**
 * A provider-facing tool name, back as the registry id the function layer answers to.
 *
 * A meta-tool name is REFUSED rather than reversed: `answer_only` would come back as `answer.only`,
 * a well-formed id in a taxonomy that could one day hold it. A caller reading a model plan checks
 * {@link isChatMetaToolName} first; this refusal is what makes forgetting to a failure rather than
 * a silent dispatch.
 *
 * A name that reverses to an id nothing registered is NOT refused here, and that is deliberate:
 * `invokeFunction` raises `UnknownFunctionError` naming it, from the one place that knows what is
 * registered. A check here would be a second catalogue, free to disagree with the real one.
 */
export function fromToolName(toolName: string): string {
  if (isChatMetaToolName(toolName)) {
    throw new ChatToolNameError(
      toolName,
      'is an orchestration tool, not a capability — it names no registry op, and reversing it '
        + 'would manufacture a plausible-looking function id out of a control signal',
    )
  }
  return toolName.replaceAll(TOOL_NAME_SEPARATOR, FUNCTION_ID_SEPARATOR)
}
