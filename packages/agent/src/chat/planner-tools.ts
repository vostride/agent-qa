// The planner's action vocabulary.
//
// THE TOOLSET IS THE REGISTRY WALK. Every registered op projects 1:1 to a tool, plus exactly two
// orchestration meta-tools, and nothing else exists. That is the always-send-all law expressed as
// code rather than as a policy: the model is shown everything this host can do, so a curated subset
// — the shape that quietly decides on a person's behalf which capabilities are worth mentioning —
// has nowhere to live. It is also what makes 393-395's arrival free: an op registered there appears
// here without anyone editing this file, and 397's chat-equals-registry conformance becomes a walk
// rather than a hand-maintained list.
//
// NO TOOL CARRIES AN EXECUTE CALLBACK, and that omission is the load-bearing line in this file.
// `generateText` runs a tool exactly when the tool has a function to run; with none present it
// returns the model's plan in `result.toolCalls` and enacts nothing. D-10 requires reconciliation
// to complete BEFORE the first side effect, and this is the version of that requirement the SDK
// cannot get wrong — there is no callback to invoke, so there is no ordering to remember.
//
// THE WALK CONSUMES DECLARATIONS, NEVER SPECS. A declaration is capability-free by construction
// scalars plus inert JSON-Schema projections, with no live validator and no
// implementation anywhere on it. So this module holds no dispatch path, and the chat subtree still
// has exactly one way to run anything — the `ChatInvokeBinding` its composition supplies. The
// projections it reads are the same views 396's MCP tool listing will consume, which is the point:
// one description of a capability, rendered by every surface that describes capabilities.

import { jsonSchema, tool } from 'ai'
import type { Tool, ToolSet } from 'ai'
import { z } from 'zod'

import type { FunctionCaller } from '@vostride/agent-qa-schema'

import type { FunctionDeclaration, FunctionSchemaProjection } from '../functions/spec.js'
import {
  HOST_DERIVED_SCOPE_FUNCTION_IDS,
  SESSION_STAMPED_FUNCTION_IDS,
  WINDOW_STAMPED_FUNCTION_IDS,
} from './session-stamps.js'
import {
  ANSWER_ONLY_TOOL_NAME,
  ChatToolNameError,
  MARK_UNHANDLED_TOOL_NAME,
  toToolName,
} from './tool-names.js'

/**
 * What the projection needs of a registry: the listing, and nothing else.
 *
 * `FunctionRegistry` satisfies this structurally, and the composition root hands one over. Naming
 * the narrower shape here is what keeps the chat subtree's reach honest — this module cannot
 * acquire the registry's internals seam even by accident, because the type it holds does not have
 * one. The claim "chat can propose only what the registry declares" is then a fact about what this
 * function was given rather than a rule about what it chose to do with it.
 */
export interface PlannerToolSource {
  list(caller: FunctionCaller): readonly FunctionDeclaration[]
}

/**
 * `answer_only`'s contract: WHICH clause is being answered, and the prose.
 *
 * THE `clause` FIELD IS REQUIRED, and it mirrors `mark_unhandled`'s for the same reason: a turn is
 * made of clauses, so a claim about a turn cannot stand in for a claim about one of them. Without
 * it, one call answering one question consumed every OTHER clause the merge had no binding for —
 * an unroutable action erased with no receipt and no refusal (392-VERIFICATION CR-03).
 */
export const ANSWER_ONLY_INPUT_SCHEMA = z.object({
  // NON-EMPTY for the same reason `text` is, one field over. `reconcile.ts` has
  // rejected `clause: ""` since the field was required — a claim that names nothing covers nothing
  // — while the contract the model was SHOWN still admitted it. The two halves of one field cannot
  // be allowed to disagree in the direction that lets the model emit a call the reader will refuse.
  clause: z
    .string()
    .min(1)
    .describe(
      'The part of the request, quoted verbatim from the clauses you were given, that this '
      + 'answer is about.',
    ),
  // NON-EMPTY, and that is the model-facing half of the coverage predicate. `z.string()`
  // admitted `""`, so the one call that erases a clause — naming it, answering nothing — was
  // inside the contract the model was shown. The reader in `reconcile.ts` moved in the SAME commit
  // and is deliberately one notch stricter (it also rejects whitespace-only prose): the two halves
  // of a claim's meaning cannot be allowed to disagree in the direction that completes more.
  text: z
    .string()
    .min(1)
    .describe('The answer, in prose, for a turn that asks for information.'),
})

/** `mark_unhandled`'s contract: WHICH clause, and WHY nothing here can carry it out. */
export const MARK_UNHANDLED_INPUT_SCHEMA = z.object({
  clause: z
    .string()
    .describe('The part of the request, quoted from what the person typed, that cannot be done.'),
  reason: z.string().describe('Which capability would be needed, in one sentence.'),
})

const ANSWER_ONLY_DESCRIPTION =
  'Answer the person in prose and perform no action. Use this when the request asks for '
  + 'information rather than for something to happen. ONE CALL PER CLAUSE you are answering, '
  + 'naming that clause in `clause` copied verbatim from the list you were given: this call '
  + 'covers the clause it names and no other, and any clause left neither named here nor bound '
  + 'to a tool refuses the whole turn.'

// THE SECOND SENTENCE IS 394-30's LIVE REFUSAL, ANSWERED AT THE CALL THAT MADE IT. A live planner
// refused an authoring turn whose only obstacle was an OMITTED OPTIONAL FIELD — one its own tool
// contract lists outside `required` — so the refusal was never "no tool here can do this" but "I
// decided a tool I have needs something it says it does not". That decision is made at the moment
// this call is emitted, which makes this description the nearest surface to it: the prompt states
// the general law (chat-prompt.ts) and this states it where the misuse happens.
const MARK_UNHANDLED_DESCRIPTION =
  'Declare that a part of the request cannot be carried out with the tools available. Naming it '
  + 'here refuses the whole turn without performing any of it, which is the correct outcome — '
  + 'never substitute a different tool that looks close. Do not use this because an optional field '
  + 'is missing — optional fields never make a request unhandleable.'

const HOST_SUPPLIES_WINDOW =
  'The host supplies a session-scoped `window` when this field is omitted — omit it to ask about '
  + 'the current session; pass `window` only to widen to all-time or last-n.'

// TWO FACTS, AND THE SENTENCE THAT PRECEDED IT GOT BOTH WRONG.
//
// It closed with "pass `scope` only to author for a DIFFERENT target" — which reads to a planner as
// an instruction to WITHHOLD a scope the person has already named, exactly the field the surface is
// positioned to fill from their own words. And its opening promised a host derivation flatly, while
// `deriveDefaultAuthoringScope` binds only where the project has ONE candidate product and returns
// `AuthoringScopeUnresolvableError` otherwise (six candidates on the demo workspace). A model told
// the host will handle something the host refuses has been handed a false premise to plan against.
//
// So this says who fills the field and when, and states the refusal as a refusal. Guessing belongs
// to NOBODY: the host must not guess among candidates and the planner must not invent a
// requirement its contract denies, which leaves the person's own utterance as the one legitimate
// source of a scope — and the planner as the only surface positioned to read it. The absent-scope
// path is thereby a single-product-project affordance, and the sentence says so out loud rather
// than letting a multi-product project discover it as a refusal.
const HOST_DERIVES_SCOPE =
  "When the person's request names the page, product or target it is for, pass `scope` with that "
  + "target's key. When `scope` is omitted the host derives it only when this project has exactly "
  + 'one candidate product; otherwise the call returns a typed refusal naming every candidate — '
  // The dist-gate sentinel 394-35 greps before it spends, kept whole on ONE source line: a string
  // concatenation folds at build time, so a phrase split across two lines is greppable in the built
  // bytes and invisible in the source the acceptance check reads.
  + 'it never guesses.'

/** A projected JSON-Schema node, as the shape this transform edits it through. */
type SchemaNode = Record<string, unknown>

function objectNode(value: unknown): SchemaNode | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as SchemaNode)
    : undefined
}

/** Drop `key` from a node's `required`, and the empty list with it. */
function dropRequired(node: SchemaNode, key: string): void {
  const required = node.required
  if (!Array.isArray(required)) return
  const kept = required.filter((entry) => entry !== key)
  if (kept.length === 0) delete node.required
  else node.required = kept
}

/**
 * The arms of a projected union, under whichever keyword zod emitted for it.
 *
 * Discriminated unions project as `oneOf` and plain ones as `anyOf`; which keyword carries the
 * arms is a library detail rather than a contract this file may pin.
 */
function unionArms(node: unknown): SchemaNode[] {
  const union = objectNode(node)
  const arms = Array.isArray(union?.oneOf) ? union.oneOf : union?.anyOf
  if (!Array.isArray(arms)) return []
  return arms.map(objectNode).filter((arm): arm is SchemaNode => arm !== undefined)
}

/**
 * The model-facing view of a declaration's input: the contract, minus what the host stamps.
 *
 * THE SET IS THE STAMP'S OWN. Both sides read `session-stamps.ts`, so the fields withheld here and
 * the fields `stampSessionFacts` writes at the invoke cannot drift; `planner-tools.test.ts` pins
 * the transformed ids SET-EQUAL to the union of the two sets. Showing the model a field the host
 * overwrites unconditionally is what talked a live planner into refusing the call instead of
 * emitting the field-absent step the stamp exists to complete (394-22, G-1).
 *
 * EVERY EDIT IS ON A CLONE. `declaration.input` is the registry's shared inert projection — the
 * same view 396's MCP listing consumes — so an in-place edit here would rewrite what every other
 * surface publishes.
 */
function modelFacingInput(declaration: FunctionDeclaration): FunctionSchemaProjection {
  const withholdsRef = SESSION_STAMPED_FUNCTION_IDS.has(declaration.id)
  const optionalisesWindow = WINDOW_STAMPED_FUNCTION_IDS.has(declaration.id)
  if (!withholdsRef && !optionalisesWindow) return declaration.input

  const projected = structuredClone(declaration.input) as SchemaNode
  const properties = objectNode(projected.properties)
  if (properties === undefined) return projected

  if (withholdsRef) {
    // Host-owned end to end: the stamp is an overwrite and never a default, so the model is not
    // shown the field at all rather than shown one its value would be discarded from.
    delete properties.sessionRef
    dropRequired(projected, 'sessionRef')
  }

  if (optionalisesWindow) {
    // THE `window` PROPERTY STAYS — a model may legitimately widen to all-time or last-n;
    // only its requiredness goes. THE SESSION ARM'S `sessionRef` DOES NOT: it is host-owned end to
    // end exactly as the top-level field is, so it is removed from the arm rather than merely made
    // optional there. The wider arms carry no ref and pass through untouched.
    dropRequired(projected, 'window')
    for (const arm of unionArms(properties.window)) {
      const armProperties = objectNode(arm.properties)
      if (armProperties === undefined || !Object.hasOwn(armProperties, 'sessionRef')) continue
      delete armProperties.sessionRef
      dropRequired(arm, 'sessionRef')
    }
  }

  return projected
}

/**
 * The catalogue's own summary, plus each sentence a host-filled field has to say out loud.
 *
 * APPENDED IN SET ORDER, never a rewrite: `declaration.summary` is what 396's MCP listing renders,
 * so a description built by replacing it would publish two catalogues. An id in both sets would
 * carry both sentences — no id is in both today, and the arrangement is deliberate rather than
 * lucky: nothing forbids it, and the day one arrives it needs both facts told rather than one.
 */
function modelFacingDescription(declaration: FunctionDeclaration): string {
  const sentences = [
    ...(WINDOW_STAMPED_FUNCTION_IDS.has(declaration.id) ? [HOST_SUPPLIES_WINDOW] : []),
    ...(HOST_DERIVED_SCOPE_FUNCTION_IDS.has(declaration.id) ? [HOST_DERIVES_SCOPE] : []),
  ]
  return [declaration.summary, ...sentences].join(' ')
}

/**
 * Build the model's entire action vocabulary from the capabilities this host declares.
 *
 * The caller is the PLANNER's caller, minted at the composition root with agent origin (Pitfall 1).
 * It matters here only through the registry's own safe-mode listing filter; the equivalence between
 * this set and the walk holds for whichever caller a host supplies, because both sides read the
 * same listing.
 */
export function projectPlannerTools(source: PlannerToolSource, caller: FunctionCaller): ToolSet {
  const tools: Record<string, Tool> = {}

  for (const declaration of source.list(caller)) {
    const name = toToolName(declaration.id)
    if (Object.hasOwn(tools, name)) {
      // Unreachable while `toToolName` stays injective over the id grammar, and asserted anyway:
      // a silent last-wins here would drop a capability from the model's vocabulary and leave the
      // walk-equivalence test comparing two sets that both lost the same member.
      throw new ChatToolNameError(
        declaration.id,
        `projects onto "${name}", which another registered capability already occupies`,
      )
    }
    tools[name] = tool({
      // `dynamic` is the literal truth about these tools rather than a convenience: their input
      // shapes are known at runtime, off the registry this host composed, and not at the time this
      // module is written. It also makes the read-back uniform — every action call comes back with
      // an unknown input the reconciler validates through the function layer's real contract.
      type: 'dynamic',
      description: modelFacingDescription(declaration),
      // The declaration's own inert projection, minus the fields the host stamps at the invoke.
      // Deriving a second schema here would be a second description of a contract the layer
      // already publishes, free to disagree with the validator `invokeFunction` enforces with —
      // so the transform SUBTRACTS from that projection and never restates it.
      inputSchema: jsonSchema(modelFacingInput(declaration) as never),
      // NO `execute`. See the file header — this absence is the mechanism, not an oversight.
    })
  }

  tools[ANSWER_ONLY_TOOL_NAME] = tool({
    description: ANSWER_ONLY_DESCRIPTION,
    inputSchema: ANSWER_ONLY_INPUT_SCHEMA,
  })
  tools[MARK_UNHANDLED_TOOL_NAME] = tool({
    description: MARK_UNHANDLED_DESCRIPTION,
    inputSchema: MARK_UNHANDLED_INPUT_SCHEMA,
  })

  return tools
}
