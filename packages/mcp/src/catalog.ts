// Handlers only validate and call `invokeFunction`; every caller sees one catalogue (SEP-2567).

import { McpServer } from '@modelcontextprotocol/server'
import type {
  CallToolResult,
  StandardSchemaV1,
  StandardSchemaWithJSON,
} from '@modelcontextprotocol/server'
import {
  FunctionInputError,
  invokeFunction,
  RUNS_ARTIFACT_FUNCTION_ID,
} from '@vostride/agent-qa-agent'
import type { FunctionRegistry } from '@vostride/agent-qa-agent'
import type { FunctionCaller } from '@vostride/agent-qa-schema'

import { MCP_APPS_EXTENSION_ID, appResourceUriFor, registerAppResources } from './app-resource.js'
import { AGENT_QA_MCP_INSTRUCTIONS, agentQaMcpPostureInstructions } from './instructions.js'
import { liveLinkLineFor } from './live-link.js'
import type { LiveLinkSupplier } from './live-link.js'
import {
  advertisedContracts,
  AGENT_QA_OP_CONTRACTS,
  AGENT_QA_TOOL_PROJECTIONS,
  compositionOf,
} from './mapping.js'
import type { ToolProjection } from './mapping.js'
import {
  decorateRunEvidenceImage,
  maskedToolError,
  maskedToolResult,
} from './masked-result.js'
import { McpProjectionError, toRegisterToolConfig } from './projection.js'
import type { ProjectedOpSpec } from './projection.js'
import { registerEntityResources } from './resources.js'

// Why the host cannot serve a project: every tool stays listed and every call says what to run.
export type AgentQaMcpPosture =
  | { readonly state: 'not-initialized'; readonly configPath: string }
  | { readonly state: 'config-invalid'; readonly configPath: string; readonly problem: string }

/** One tool call as it settled; `error` is the thrown value, absent when nothing was thrown. */
export interface McpToolSettled {
  readonly tool: string
  readonly durationMs: number
  readonly outcome: 'success' | 'error'
  readonly error?: unknown
}

/** What a host must supply to build a server for one caller. */
export interface AgentQaMcpServerDeps {
  // Built by the host, never by this package.
  readonly registry: FunctionRegistry
  // Passed through untouched to `invokeFunction`; nothing here reads it to decide what to serve.
  readonly caller: FunctionCaller
  // Required: an optional masker is absent exactly where nobody thought to pass one.
  readonly maskText: (text: string) => string
  // The host supplies the server version because this package reads no package.json.
  readonly version: string
  // A factory, because on the co-hosted composition the origin exists only once a port is bound.
  readonly liveLink?: LiveLinkSupplier
  // Present when there is no project to serve; no call then reaches the registry.
  readonly posture?: AgentQaMcpPosture
  // The host observes every tool call here; this package never learns where the observation goes.
  readonly onToolSettled?: (settled: McpToolSettled) => void
}

/** The host-bound `(registry, caller)` closure over `invokeFunction`. */
type BoundInvoke = (opId: string, input: unknown) => Promise<unknown>

/**
 * Join the mapping's declared contracts with this host's registry declarations.
 *
 * Returns `undefined` when any arm is missing from the registry — which is a REAL answer and not an
 * error: a projection naming an op a given composition does not register is a tool that composition
 * genuinely cannot serve, and refusing to build the whole server over it would take an editor's MCP
 * connection down because one capability was unavailable. A contract missing from the mapping table
 * IS an error, because that is this repository disagreeing with itself.
 */
function resolveSpecs(
  projection: ToolProjection,
  declarations: ReadonlyMap<string, ProjectedOpSpec>,
): readonly ProjectedOpSpec[] | undefined {
  const specs: ProjectedOpSpec[] = []
  for (const opId of projection.ops) {
    const resolved = declarations.get(opId)
    if (resolved === undefined) return undefined
    specs.push(resolved)
  }
  return specs
}

// A second reading of the arm: the schema package and `mapping.ts` can drift apart.
function selectFoldArm(
  projection: ToolProjection,
  args: unknown,
): { readonly opId: string; readonly input: Record<string, unknown> } {
  const key = projection.discriminant!
  const record = (args ?? {}) as Record<string, unknown>
  const selected = record[key]
  if (typeof selected !== 'string' || !projection.ops.includes(selected)) {
    throw new McpProjectionError(
      projection.name,
      `was called with ${key}=${JSON.stringify(selected)}, which is not one of the ops it declares`,
    )
  }
  // The discriminant is WIRE vocabulary and stops here: what crosses the function-layer wall is the
  // object `invokeFunction` will parse against the op's own `.strict()` contract, which would refuse
  // the extra key.
  const { [key]: _arm, ...input } = record
  return { opId: selected, input }
}

/** The one arm of an entity resolution that has something further to fetch. */
function resolvedCardId(resolution: unknown): string | undefined {
  if (typeof resolution !== 'object' || resolution === null) return undefined
  const record = resolution as { kind?: unknown; card?: unknown }
  if (record.kind !== 'resolved') return undefined
  const card = record.card as { id?: unknown } | undefined
  return typeof card?.id === 'string' ? card.id : undefined
}

/**
 * Run one projected call and answer what the op answered, with the op that answered it.
 *
 * Every branch is `invokeFunction` and argument shuffling. Nothing computes a result, nothing reads
 * a store, nothing decides a policy.
 */
async function runProjection(
  projection: ToolProjection,
  args: unknown,
  invoke: BoundInvoke,
): Promise<{ readonly opId: string; readonly output: unknown }> {
  switch (compositionOf(projection)) {
    case 'single':
      return { opId: projection.ops[0]!, output: await invoke(projection.ops[0]!, args) }
    case 'union': {
      const arm = selectFoldArm(projection, args)
      return { opId: arm.opId, output: await invoke(arm.opId, arm.input) }
    }
    case 'pipeline': {
      // Resolve, then re-read the one resolved entity at its canonical address with `entities.get`.
      const resolution = await invoke(projection.ops[0]!, args)
      const id = resolvedCardId(resolution)
      if (id === undefined) return { opId: projection.ops[0]!, output: resolution }
      const card = await invoke(projection.ops[1]!, { ref: id })
      return { opId: projection.ops[1]!, output: { ...(resolution as Record<string, unknown>), card } }
    }
  }
}

/**
 * The concrete run this carrier's result is ABOUT, read from the source the projection declares.
 *
 * DEFENSIVE ON BOTH ARMS, and neither arm is hypothetical. `runIdFrom: 'input'` reads the args the
 * handler already checked against the advertised input schema; `runIdFrom: 'output'` reads the op's
 * own result, which is a `RunStartAcknowledgement` today and could be a fold's arm tomorrow. Either
 * can answer with something that is not a string — and the honest treatment of that is the same as
 * the honest treatment of a missing dashboard: the LINE becomes the named absence and there is no
 * concrete App address to advertise. What it must never be is a crash, because that would turn a
 * decoration into a way to fail a tool call that had already succeeded.
 */
function carrierRunIdOf(
  projection: ToolProjection,
  args: unknown,
  output: unknown,
): string | undefined {
  const source = projection.ui?.runIdFrom === 'output' ? output : args
  const runId = (source as { runId?: unknown } | null | undefined)?.runId
  return typeof runId === 'string' && runId !== '' ? runId : undefined
}

// Additive only: a masked link line and `_meta.ui.resourceUri`, attached without negotiation.
function decorateCarrierResult(input: {
  readonly result: CallToolResult
  readonly projection: ToolProjection
  readonly args: unknown
  readonly output: unknown
  readonly maskText: (text: string) => string
  readonly liveLink?: LiveLinkSupplier
}): CallToolResult {
  if (input.projection.ui === undefined) return input.result
  if (input.result.isError === true) return input.result

  const runId = carrierRunIdOf(input.projection, input.args, input.output)
  const line = liveLinkLineFor(input.liveLink?.dashboardBaseUrl(), runId)

  return {
    ...input.result,
    content: [...input.result.content, { type: 'text' as const, text: input.maskText(line) }],
    ...(runId === undefined
      ? {}
      : { _meta: { ...input.result._meta, ui: { resourceUri: appResourceUriFor(runId) } } }),
  }
}

// A returned result is an error when it says so, since masking or a decoration can refuse.
function settleToolCall(
  onToolSettled: ((settled: McpToolSettled) => void) | undefined,
  tool: string,
  startedAt: number,
  arm: { readonly result: CallToolResult } | { readonly error: unknown },
): void {
  if (onToolSettled === undefined) return
  try {
    const durationMs = Math.max(0, Math.round(performance.now() - startedAt))
    onToolSettled(
      'error' in arm
        ? { tool, durationMs, outcome: 'error', error: arm.error }
        : { tool, durationMs, outcome: arm.result.isError === true ? 'error' : 'success' },
    )
  } catch {
    // An observer that throws must not fail a tool call that has already answered.
  }
}

// The SDK answers a call its own check refuses without calling the handler, so the handler checks
// the arguments and the listing stays the contract's.
function listedInputSchema(schema: StandardSchemaWithJSON): StandardSchemaWithJSON {
  const standard = schema['~standard']
  return {
    '~standard': {
      version: standard.version,
      vendor: standard.vendor,
      validate: (value) => ({ value }),
      jsonSchema: standard.jsonSchema,
    },
  }
}

const REFUSED_ARGUMENTS = "the arguments do not match the tool's input schema"
const REFUSED_RESULT = 'answered a result that does not match the output schema it advertises, so '
  + 'the result was withheld'

// The sentence the SDK composes for a refused call, so a client reads what it read before.
function refusedArgumentsText(tool: string, issues: readonly StandardSchemaV1.Issue[]): string {
  const rendered = issues.map((issue) => {
    const path = (issue.path ?? []).map((segment) =>
      String(typeof segment === 'object' ? segment.key : segment),
    )
    return path.length === 0 ? issue.message : `${path.join('.')}: ${issue.message}`
  })
  return `Input validation error: Invalid arguments for tool ${tool}: ${rendered.join(', ')}`
}

/**
 * The one generic tool handler.
 *
 * Input validation happens twice before the invoke — once here against the tool's input contract,
 * once inside `invokeFunction` against the op's own — and both parses are kept, because they are
 * the same check made by two independent parties. A refusal settles with the tool's name and a
 * fixed sentence, never with what the caller typed.
 */
function createProjectionHandler(
  projection: ToolProjection,
  inputSchema: StandardSchemaWithJSON,
  outputSchema: StandardSchemaWithJSON | undefined,
  invoke: BoundInvoke,
  maskText: (text: string) => string,
  liveLink?: LiveLinkSupplier,
  onToolSettled?: (settled: McpToolSettled) => void,
) {
  return async (args: unknown): Promise<CallToolResult> => {
    const startedAt = performance.now()
    try {
      const checked = await inputSchema['~standard'].validate(args)
      if (checked.issues !== undefined) {
        const refusal = maskedToolError(
          refusedArgumentsText(projection.name, checked.issues),
          maskText,
        )
        settleToolCall(onToolSettled, projection.name, startedAt, {
          error: new FunctionInputError(projection.name, REFUSED_ARGUMENTS),
        })
        return refusal
      }
      const { opId, output } = await runProjection(projection, checked.value, invoke)
      // Both channels come from one masked serialization, so `structuredContent` holds no secret.
      const masked = maskedToolResult(output, maskText)
      // The image block is decided after masking, so no bytes sit beside a withheld result.
      const result = opId === RUNS_ARTIFACT_FUNCTION_ID
        ? decorateRunEvidenceImage({ result: masked, output, maskText })
        : masked
      const decorated = decorateCarrierResult({
        result,
        projection,
        args: checked.value,
        output,
        maskText,
        ...(liveLink === undefined ? {} : { liveLink }),
      })
      // Checked before the settle, so a result the SDK's own check refuses never settles success.
      if (outputSchema !== undefined && decorated.isError !== true) {
        const content = decorated.structuredContent
        const refused = content === undefined
          || (await outputSchema['~standard'].validate(content)).issues !== undefined
        if (refused) throw new McpProjectionError(projection.name, REFUSED_RESULT)
      }
      settleToolCall(onToolSettled, projection.name, startedAt, { result: decorated })
      return decorated
    } catch (err) {
      settleToolCall(onToolSettled, projection.name, startedAt, { error: err })
      // A refusal is a readable tool error, masked because an error string can carry a credential.
      return maskedToolError(err, maskText)
    }
  }
}

// The posture is read once, at startup, so a fixed config is served only after a restart.
const RESTART = 'restart this MCP server (reconnect it in your coding agent)'

// `isError` skips the output check, which the projection handler makes before the SDK does, so the
// same result fits every tool.
function createPostureHandler(
  projection: ToolProjection,
  posture: AgentQaMcpPosture,
  onToolSettled?: (settled: McpToolSettled) => void,
) {
  const { text, structuredContent } = posture.state === 'not-initialized'
    ? {
        text: `agent-qa is not set up here: there is no agent-qa config at ${posture.configPath} `
          + 'or in the folders above it. Run npx agent-qa init in the project folder, then '
          + `${RESTART}.`,
        structuredContent: {
          status: 'not_initialized',
          configPath: posture.configPath,
          run: 'npx agent-qa init',
          then: RESTART,
        },
      }
    : {
        text: `${posture.configPath} is not a valid agent-qa config: `
          + `${posture.problem.replace(/\.$/u, '')}. Fix it until npx agent-qa validate passes, `
          + `then ${RESTART}.`,
        structuredContent: {
          status: 'config_invalid',
          configPath: posture.configPath,
          problem: posture.problem,
          run: 'npx agent-qa validate',
          then: RESTART,
        },
      }
  return async (): Promise<CallToolResult> => {
    const startedAt = performance.now()
    const result: CallToolResult = {
      isError: true,
      content: [{ type: 'text', text }],
      structuredContent,
    }
    settleToolCall(onToolSettled, projection.name, startedAt, { result })
    return result
  }
}

// The listing comes from `registry.list(deps.caller)`, so it describes this composition.
export function buildAgentQaMcpServer(deps: AgentQaMcpServerDeps): McpServer {
  // No `maxToolInputElements` is set: the SDK answers a call over that limit itself.
  const server = new McpServer(
    { name: 'agent-qa', version: deps.version },
    {
      capabilities: {
        tools: {},
        resources: {},
        // Extensions are bilateral opt-in: a host asks only for an App the server advertises.
        extensions: { [MCP_APPS_EXTENSION_ID]: {} },
      },
      // Instructions reach every MCP host, so init's pointer goes here.
      instructions: deps.posture === undefined
        ? AGENT_QA_MCP_INSTRUCTIONS
        : agentQaMcpPostureInstructions(deps.posture),
    },
  )

  const invoke: BoundInvoke = (opId, input) =>
    invokeFunction(deps.registry, opId, input, deps.caller)

  const declarations = new Map<string, ProjectedOpSpec>()
  for (const declaration of deps.registry.list(deps.caller)) {
    const contracts = AGENT_QA_OP_CONTRACTS[declaration.id]
    if (contracts === undefined) continue
    declarations.set(declaration.id, {
      id: declaration.id,
      summary: declaration.summary,
      risk: declaration.risk,
      input: contracts.input,
      output: contracts.output,
    })
  }

  const registered = new Set<string>()
  for (const projection of AGENT_QA_TOOL_PROJECTIONS) {
    if (registered.has(projection.name)) {
      // Unreachable while the mapping table holds distinct names, and asserted anyway: a silent
      // last-wins here would drop a capability from every caller's vocabulary.
      throw new McpProjectionError(
        projection.name,
        'is declared twice in the mapping table; another projection already occupies that name',
      )
    }

    for (const opId of projection.ops) {
      if (AGENT_QA_OP_CONTRACTS[opId] === undefined) {
        throw new McpProjectionError(
          projection.name,
          `names op ${opId}, which has no entry in the contract table`,
        )
      }
    }

    const advertised = advertisedContracts(projection)
    if (advertised === undefined) {
      throw new McpProjectionError(
        projection.name,
        'has no advertised contract; a multi-arm tool needs an entry in AGENT_QA_COMPOSED_CONTRACTS',
      )
    }

    const specs = resolveSpecs(projection, declarations)
    if (specs === undefined) continue

    registered.add(projection.name)
    const config = toRegisterToolConfig(projection, specs, advertised, deps.maskText)

    server.registerTool(
      projection.name,
      { ...config, inputSchema: listedInputSchema(config.inputSchema) },
      deps.posture === undefined
        ? createProjectionHandler(
            projection,
            config.inputSchema,
            config.outputSchema,
            invoke,
            deps.maskText,
            deps.liveLink,
            deps.onToolSettled,
          )
        : createPostureHandler(projection, deps.posture, deps.onToolSettled),
    )
  }

  // Both read the project, so a server with no project to serve lists no resources.
  if (deps.posture !== undefined) return server

  // Registered here so a `resource_link` resolves on the instance that produced it.
  registerEntityResources(server, {
    registry: deps.registry,
    caller: deps.caller,
    maskText: deps.maskText,
  })

  // Registered here so `_meta.ui.resourceUri` resolves on the instance that advertised it.
  registerAppResources(server, {
    registry: deps.registry,
    caller: deps.caller,
    maskText: deps.maskText,
    // The same supplier the carrier decoration reads, so both name one page for one run.
    ...(deps.liveLink === undefined ? {} : { liveLink: deps.liveLink }),
  })

  return server
}
