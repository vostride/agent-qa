// One tool per registered op plus two meta-tools, none with an execute callback, so nothing runs.

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

// `clause` is required, so one answer cannot consume clauses it does not name.
export const ANSWER_ONLY_INPUT_SCHEMA = z.object({
  // Non-empty, matching the reader in `reconcile.ts`, so the model is not shown a call it refuses.
  clause: z
    .string()
    .min(1)
    .describe(
      'The part of the request, quoted verbatim from the clauses you were given, that this '
      + 'answer is about.',
    ),
  // Non-empty; the reader in `reconcile.ts` is one notch stricter and rejects whitespace-only text.
  text: z
    .string()
    .min(1)
    .describe('The answer, in prose, for a turn that asks for information.'),
})

// `mark_unhandled`'s contract: which clause, and why nothing here can carry it out.
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

const MARK_UNHANDLED_DESCRIPTION =
  'Declare that a part of the request cannot be carried out with the tools available. Naming it '
  + 'here refuses the whole turn without performing any of it, which is the correct outcome — '
  + 'never substitute a different tool that looks close. Do not use this because an optional field '
  + 'is missing — optional fields never make a request unhandleable.'

const HOST_SUPPLIES_WINDOW =
  'The host supplies a session-scoped `window` when this field is omitted — omit it to ask about '
  + 'the current session; pass `window` only to widen to all-time or last-n.'

// Only a one-product project gets a host-derived scope, so the planner passes the person's words.
const HOST_DERIVES_SCOPE =
  "When the person's request names the page, product or target it is for, pass `scope` with that "
  + "target's key. When `scope` is omitted the host derives it only when this project has exactly "
  + 'one candidate product; otherwise the call returns a typed refusal naming every candidate — '
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

// The withheld set is `session-stamps.ts`'s, and every edit is on a clone of the shared projection.
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
    // `window` stays, minus its requiredness; the session arm's `sessionRef` is removed outright.
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

// Appended in set order, so `declaration.summary` stays what the MCP listing renders.
function modelFacingDescription(declaration: FunctionDeclaration): string {
  const sentences = [
    ...(WINDOW_STAMPED_FUNCTION_IDS.has(declaration.id) ? [HOST_SUPPLIES_WINDOW] : []),
    ...(HOST_DERIVED_SCOPE_FUNCTION_IDS.has(declaration.id) ? [HOST_DERIVES_SCOPE] : []),
  ]
  return [declaration.summary, ...sentences].join(' ')
}

// The registry lists the same ops for every caller, so this caller does not narrow the set.
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
