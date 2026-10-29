// Tool config derived from the op's live contract; the SDK converts it (SEP-2106).

import type { StandardSchemaWithJSON, ToolAnnotations } from '@modelcontextprotocol/server'
import type { RiskActionDescriptor } from '@vostride/agent-qa-schema'

// ONE authoritative spelling of the App address: the module that publishes the template is the
// module that parses it, and this derivation imports it rather than restating the string.
import { APP_RESOURCE_URI_TEMPLATE } from './app-resource.js'
import { compositionOf, DEGRADED_OUTPUT_CONTRACTS, MAX_RESULT_SIZE_META_KEY } from './mapping.js'
import type { ToolOpContracts, ToolProjection } from './mapping.js'

/**
 * The draft the SDK converts every advertised schema to.
 *
 * Pinned here to the SDK's own `JSON_SCHEMA_CONVERSION_TARGET` (`src-CX2iR2pK.mjs`) because the
 * probe below must ask the SAME question `tools/list` will ask. A probe run against a different
 * target would be measuring a conversion nobody performs.
 */
const JSON_SCHEMA_CONVERSION_TARGET = 'draft-2020-12'

// `summary` and `risk` come from the registry's declaration; `input` and `output` from the mapping.
export interface ProjectedOpSpec {
  readonly id: string
  readonly summary: string
  readonly risk: RiskActionDescriptor
  readonly input: StandardSchemaWithJSON
  readonly output: StandardSchemaWithJSON
}

/**
 * Exactly the `registerTool` config fields this projection derives.
 *
 * `outputSchema` is OPTIONAL, and its absence is a decision rather than a gap — see
 * `DEGRADED_OUTPUT_CONTRACTS` and `probeOutputSchema` below.
 */
export interface RegisterToolConfig {
  readonly title: string
  readonly description: string
  readonly inputSchema: StandardSchemaWithJSON
  readonly outputSchema?: StandardSchemaWithJSON
  readonly annotations: ToolAnnotations
  // A non-carrier gets no `_meta` key at all; a host that never negotiated the App ignores it.
  readonly _meta?: Record<string, unknown>
}

// Read-only only when every arm's risk descriptor says `readOnly`; one write arm makes it a write.
function isReadOnly(specs: readonly ProjectedOpSpec[]): boolean {
  return specs.every((spec) => spec.risk.readOnly === true)
}

/**
 * Derive the honest annotation set.
 *
 * `destructiveHint` is true when ANY arm declares itself destructive — the union direction, because
 * a fold is as dangerous as its most dangerous arm and a host deciding whether to confirm is asking
 * about the call it is about to make, not about the average of the ones it could have made.
 *
 * `idempotentHint` follows `readOnlyHint` and nothing else. A read is idempotent; for anything that
 * writes, this product has no per-op declaration of idempotence to read, and asserting one from
 * nowhere is exactly the lie the honest-annotations rule forbids. When such a declaration exists,
 * this is the one line that changes.
 */
function deriveAnnotations(specs: readonly ProjectedOpSpec[]): ToolAnnotations {
  const readOnlyHint = isReadOnly(specs)
  return {
    readOnlyHint,
    destructiveHint: specs.some((spec) => spec.risk.destructive === true),
    idempotentHint: readOnlyHint,
  }
}

/**
 * Compose a human-facing description from the arms' own summaries.
 *
 * A 1:1 projection reads as its op's summary verbatim — there is nothing to add, and adding
 * something would be authoring a second description of one capability.
 *
 * A UNION FOLD lists its arms, each labelled with the op id it stands for, and says which key
 * selects between them — because a caller told only "manage configuration" cannot work out which
 * arm a given input selects, and the discriminant IS the op id.
 *
 * THE PIPELINE names its steps in order. Its second op contributes no shape to the advertisement
 * (see `AGENT_QA_COMPOSED_CONTRACTS`), so a caller reading only the schemas would never learn that
 * a second capability runs, and "what did this call actually do" is not a question a projection may
 * leave unanswerable.
 */
function describe(projection: ToolProjection, specs: readonly ProjectedOpSpec[]): string {
  const composition = compositionOf(projection)
  if (composition === 'single') return specs[0]!.summary
  const arms = specs.map((spec) => `${spec.id}: ${spec.summary}`).join('\n')
  if (composition === 'pipeline') {
    return `${arms}\nThese run in the order listed; the second runs only when the first resolves.`
  }
  return `${arms}\nSelect one with "${projection.discriminant!}", whose value is the op id above.`
}

// An omitted output schema is told to the caller in the description, where it reads.
function degradationSentence(degradation: { readonly schema: string }): string {
  return (
    `\nThis tool advertises no outputSchema: its result contract (${degradation.schema}) contains a `
    + 'construct JSON Schema cannot represent, and a narrowed stand-in would describe a shape '
    + 'nothing produces. The result still arrives as structuredContent.'
  )
}

/**
 * Ask the SDK's own converter whether this output contract can be advertised at all.
 *
 * PROBED, NEVER ASSUMED, and probed in OUTPUT mode because that is the mode `tools/list` uses for
 * `outputSchema` — a probe in input mode would answer a question nobody asks and pass for every
 * contract this check exists to catch. The conversion is pure and deterministic, so running it once
 * here and once again inside the SDK costs a listing nothing and buys the failure a name.
 *
 * The three answers, and each one is a decision:
 *  - converts, undeclared  -> advertise it.
 *  - throws, DECLARED      -> advertise nothing, say so in the description.
 *  - throws, undeclared    -> refuse to build the tool, naming the tool, the schema and the
 *                             converter's own message. Left to the SDK this would surface as an
 *                             exception inside `tools/list`, taking the whole listing down for
 *                             every caller with no indication of which tool caused it.
 *  - converts, DECLARED    -> also refuse. A degradation entry that no longer describes reality is
 *                             a tool silently withholding a schema it could publish, and a list
 *                             that can only grow is a list that rots.
 */
function probeOutputSchema(
  projection: ToolProjection,
  output: StandardSchemaWithJSON,
): StandardSchemaWithJSON | undefined {
  const declared = DEGRADED_OUTPUT_CONTRACTS.find((entry) => entry.tool === projection.name)

  let failure: string | undefined
  try {
    output['~standard'].jsonSchema.output({ target: JSON_SCHEMA_CONVERSION_TARGET })
  } catch (err) {
    failure = err instanceof Error ? err.message : String(err)
  }

  if (failure === undefined) {
    if (declared === undefined) return output
    throw new McpProjectionError(
      projection.name,
      `is listed in DEGRADED_OUTPUT_CONTRACTS for ${declared.schema}, but that contract now `
        + 'converts cleanly in output mode; remove the entry so the schema is advertised again',
    )
  }

  if (declared === undefined) {
    throw new McpProjectionError(
      projection.name,
      `advertises an output contract JSON Schema cannot represent (${failure}). Declare it in `
        + 'DEGRADED_OUTPUT_CONTRACTS with the measured message, or give the op a contract that '
        + 'converts — an unrepresentable outputSchema throws inside tools/list and takes the whole '
        + 'listing down for every caller',
    )
  }

  return undefined
}

// Derived prose is masked; the `title` and the schemas are not, as masking them breaks the tool.
export function toRegisterToolConfig(
  projection: ToolProjection,
  specs: readonly ProjectedOpSpec[],
  advertised: ToolOpContracts,
  maskText: (text: string) => string,
): RegisterToolConfig {
  if (specs.length === 0) {
    throw new McpProjectionError(
      projection.name,
      'projects no ops; a tool with no arm has nothing to validate against and nothing to call',
    )
  }

  if (specs.length !== projection.ops.length) {
    // Unreachable through `catalog.ts`, which resolves every arm or none, and asserted anyway: a
    // tool derived from a SUBSET of its declared arms would advertise a contract narrower than the
    // one its handler dispatches over, and the caller who found the missing arm would be told its
    // valid input was invalid.
    throw new McpProjectionError(
      projection.name,
      `declares ${projection.ops.length} ops but was derived from ${specs.length}`,
    )
  }

  const outputSchema = probeOutputSchema(projection, advertised.output)
  const degradation = outputSchema === undefined
    ? DEGRADED_OUTPUT_CONTRACTS.find((entry) => entry.tool === projection.name)
    : undefined

  const description = describe(projection, specs)
  const meta = listingMeta(projection)
  const fold = compositionOf(projection) === 'union'
  const inputSchema = fold ? flatFoldInput(projection, advertised.input) : advertised.input
  // Converted once here, so a fold that cannot be listed fails the build rather than tools/list.
  if (fold) inputSchema['~standard'].jsonSchema.input({ target: JSON_SCHEMA_CONVERSION_TARGET })
  return {
    title: projection.name,
    description: maskText(
      degradation === undefined ? description : description + degradationSentence(degradation),
    ),
    inputSchema,
    ...(outputSchema === undefined ? {} : { outputSchema }),
    annotations: deriveAnnotations(specs),
    // Not masked: `resourceUri` is a declared constant, and masking it would break the address.
    ...(meta === undefined ? {} : { _meta: meta }),
  }
}

// The App reference and the result-size hint are independent members; neither replaces the other.
function listingMeta(projection: ToolProjection): Record<string, unknown> | undefined {
  const meta: Record<string, unknown> = {
    ...(projection.ui === undefined ? {} : { ui: { resourceUri: APP_RESOURCE_URI_TEMPLATE } }),
    ...(projection.maxResultSizeChars === undefined
      ? {}
      : { [MAX_RESULT_SIZE_META_KEY]: projection.maxResultSizeChars }),
  }
  return Object.keys(meta).length === 0 ? undefined : meta
}

type JsonObject = Record<string, unknown>

// Claude Code drops a tool whose input is a top-level `oneOf`, so a fold lists one object.
function flatFoldInput(
  projection: ToolProjection,
  input: StandardSchemaWithJSON,
): StandardSchemaWithJSON {
  const standard = input['~standard']
  return {
    '~standard': {
      version: standard.version,
      vendor: standard.vendor,
      validate: (value, options) => standard.validate(value, options),
      jsonSchema: {
        input: (options) => flatFoldDocument(projection, standard.jsonSchema.input(options)),
        output: (options) => standard.jsonSchema.output(options),
      },
    },
  }
}

interface FoldField {
  readonly shapes: JsonObject[]
  readonly notes: string[]
  readonly usedBy: string[]
  readonly requiredBy: string[]
}

function flatFoldDocument(projection: ToolProjection, document: JsonObject): JsonObject {
  const key = projection.discriminant!
  const { oneOf, type: _type, ...rest } = document
  const arms = Array.isArray(oneOf) ? (oneOf as JsonObject[]) : []
  const unsupported = ['anyOf', 'allOf', 'properties'].filter((name) => rest[name] !== undefined)
  if (arms.length !== projection.ops.length || unsupported.length > 0) {
    throw new McpProjectionError(
      projection.name,
      `has an input contract that is not a ${projection.ops.length}-arm union of objects, so it `
        + 'cannot be listed as one object',
    )
  }

  const ops: string[] = []
  const fields = new Map<string, FoldField>()
  let actionNote: string | undefined
  let strict = true
  for (const arm of arms) {
    const properties = (arm.properties ?? {}) as Record<string, JsonObject>
    const opId = properties[key]?.const
    if (arm.type !== 'object' || typeof opId !== 'string' || !projection.ops.includes(opId)) {
      throw new McpProjectionError(
        projection.name,
        `has a union arm that is not an object selected by a declared ${key}`,
      )
    }
    ops.push(opId)
    if (arm.additionalProperties !== false) strict = false
    actionNote ??= properties[key]?.description as string | undefined
    const required = (arm.required ?? []) as readonly string[]
    for (const [name, schema] of Object.entries(properties)) {
      if (name === key) continue
      const field = fields.get(name) ?? { shapes: [], notes: [], usedBy: [], requiredBy: [] }
      const { description, ...shape } = schema
      if (!field.shapes.some((seen) => JSON.stringify(seen) === JSON.stringify(shape))) {
        field.shapes.push(shape)
      }
      if (typeof description === 'string' && !field.notes.includes(description)) {
        field.notes.push(description)
      }
      field.usedBy.push(opId)
      if (required.includes(name)) field.requiredBy.push(opId)
      fields.set(name, field)
    }
  }

  const perAction = ops.map((opId) => {
    const taken = [...fields].filter(([, field]) => field.usedBy.includes(opId))
    const listed = taken.map(([name, field]) =>
      field.requiredBy.includes(opId) ? name : `${name} (optional)`,
    )
    return `${opId} takes ${listed.length === 0 ? 'no other field' : listed.join(', ')}.`
  })
  const properties: Record<string, JsonObject> = {
    [key]: {
      type: 'string',
      enum: ops,
      description: [actionNote, ...perAction].filter(Boolean).join(' '),
    },
  }
  const required = [key]
  for (const [name, field] of fields) {
    const scope = field.usedBy.length === ops.length
      ? 'every action'
      : `${field.usedBy.join(' or ')} only`
    const need = field.requiredBy.length === 0
      ? 'optional'
      : field.requiredBy.length === field.usedBy.length
        ? 'required'
        : `required for ${field.requiredBy.join(' or ')}`
    const shape = field.shapes.length === 1 ? field.shapes[0]! : { anyOf: field.shapes }
    const description = [...field.notes, `For ${scope}; ${need}.`].join(' ')
    properties[name] = { ...shape, description }
    if (field.requiredBy.length === ops.length) required.push(name)
  }

  return {
    ...rest,
    type: 'object',
    properties,
    required,
    ...(strict ? { additionalProperties: false } : {}),
  }
}

/** A projection that cannot be derived honestly, named with the tool it is about. */
export class McpProjectionError extends Error {
  constructor(readonly toolName: string, detail: string) {
    super(`${toolName} ${detail}`)
    this.name = 'McpProjectionError'
  }
}
