// Composed by `agent-qa dashboard` and handed in, so this package names no agent package.

import type { FunctionCaller } from '@vostride/agent-qa-schema'

/**
 * The composed function registry, OPAQUE to this package.
 *
 * Deliberately not structurally described. The registry's real type lives in `agent`, this package
 * may not name it, and a hand-written mirror of its shape here would be a second declaration of
 * somebody else's contract — stale on the day `agent` changes it, and silently so, because nothing
 * would compare the two. What this package does with the value is hand it straight back to the
 * functions below, which is all an opaque handle has to support.
 */
export type AgentRegistryHandle = object

/**
 * The whole of what the run-detail and mark routes may ask of the process that started them.
 *
 * A single object rather than loose options, because the members are one decision: they all come
 * from ONE composition, and a server holding an invoke from one host and a registry from another is
 * a state nobody should be able to construct.
 */
export interface AgentHost {
  /** The composed registry every call goes through. Opaque here. */
  readonly registry: AgentRegistryHandle
  // Minted by the composition root from the CLI's own caller mint; this package cannot type one.
  readonly caller: FunctionCaller
  // Supplied by the composition: this package may not import agent, so op ids arrive as data.
  readonly runsPostProcessingFunctionId: string
  // A second id because the read joins chips with the run's posture from its own event log.
  readonly runsEventsFunctionId: string
  readonly runsDetailFunctionId: string
  /** The evidence op identity supplied by the same composition as the detail reader. */
  readonly runsEvidenceFunctionId: string
  // Bytes go through the op, so the evidence store's containment rule is the only one.
  readonly runsArtifactFunctionId: string
  readonly analysisGetFunctionId: string
  readonly runsKnowledgeFunctionId: string
  readonly runsMarkFunctionId: string
  readonly runsMarksHistoryFunctionId: string
  readonly runsMarkPreviewFunctionId: string
  // `input` is `unknown`, because each op's own strict schema validates it inside the invocation.
  invokeFunction(
    registry: AgentRegistryHandle,
    functionId: string,
    input: unknown,
    caller: FunctionCaller,
  ): Promise<unknown>
}

// prettier-ignore
export const AGENT_HOST_MEMBERS = [
  'registry',
  'caller',
  'runsPostProcessingFunctionId',
  'runsEventsFunctionId',
  'runsDetailFunctionId',
  'runsEvidenceFunctionId',
  'runsArtifactFunctionId',
  'analysisGetFunctionId',
  'runsKnowledgeFunctionId',
  'runsMarkFunctionId',
  'runsMarksHistoryFunctionId',
  'runsMarkPreviewFunctionId',
  'invokeFunction',
] as const satisfies readonly (keyof AgentHost)[]
