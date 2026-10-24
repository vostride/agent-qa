// The canonical output contract (2026-09-28, Phase 431 plan 03 · D-03/D-07 · research A1).
//
// WHY A COMPANION AND NOT THE SCHEMA ITSELF. A runtime contract that brands a run id
// (`z.string().transform(asRunId)`) or preserves an own `__proto__` variable (a transform behind the
// record) cannot be converted in zod's OUTPUT mode: the converter refuses any transform. Before 431
// the only answers were to omit the advertised output (the 397 degradation) or to advertise the
// INPUT-mode document as though it were the output. The first withholds a contract that exists; the
// second is a second recipe presented as the first.
//
// An `OutputContract` is one Standard Schema object with two faces. `validate` IS the runtime
// schema's own validation — the same object, never a re-parse through a wire schema, so no
// transform, refinement or preserved key can be lost. `jsonSchema.output` is an explicit document
// derived from the runtime schema's own output conversion, where exactly the declared WIRE TERMINALS
// below are described by the wire half their transform consumes. Every other unrepresentable
// construct fails the derivation by name, so the document can never be an any-valued stand-in.

import { z } from 'zod'

import { VariableSnapshotSchema } from '../run/evidence'
import { runIdSchema } from '../run/run-id'

export type JsonSchemaDocument = Readonly<Record<string, unknown>>

interface StandardIssue {
  readonly message: string
  readonly path?: ReadonlyArray<PropertyKey | { readonly key: PropertyKey }> | undefined
}

type StandardResult<Output> =
  | { readonly value: Output; readonly issues?: undefined }
  | { readonly issues: ReadonlyArray<StandardIssue> }

interface StandardJsonOptions {
  readonly target: string
  readonly libraryOptions?: Record<string, unknown> | undefined
}

export interface OutputContractStandardProps<Input, Output> {
  readonly version: 1
  readonly vendor: string
  readonly types?: { readonly input: Input; readonly output: Output } | undefined
  readonly validate: (
    value: unknown,
    options?: { readonly libraryOptions?: Record<string, unknown> | undefined } | undefined,
  ) => StandardResult<Output> | Promise<StandardResult<Output>>
  readonly jsonSchema: {
    readonly input: (options: StandardJsonOptions) => Record<string, unknown>
    readonly output: (options: StandardJsonOptions) => Record<string, unknown>
  }
}

export interface OutputContract<Schema extends z.ZodType = z.ZodType> {
  readonly runtimeSchema: Schema
  readonly outputRepresentation: JsonSchemaDocument
  readonly '~standard': OutputContractStandardProps<z.input<Schema>, z.output<Schema>>
}

const PUBLISHED_TARGET = 'draft-2020-12'

/**
 * Transform-bearing schemas whose output, on the wire, is exactly their wire half.
 *
 * `runIdSchema`'s transform is the `asRunId` brand cast: the value out is the validated string in.
 * `VariableSnapshotSchema`'s transform only re-attaches the own `__proto__` entry the record
 * parser skipped, after validating it as an entry, so its output is the string-keyed entry map the
 * record half describes. Nothing else is admitted by default.
 */
const WIRE_TERMINALS: ReadonlyMap<z.ZodType, z.ZodType> = new Map<z.ZodType, z.ZodType>([
  [runIdSchema, runIdSchema.in],
  [VariableSnapshotSchema, VariableSnapshotSchema.in._zod.def.left],
])

function deepFreeze<Value>(value: Value): Value {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value
  for (const nested of Object.values(value)) deepFreeze(nested)
  return Object.freeze(value)
}

function withoutDialect(document: Record<string, unknown>): Record<string, unknown> {
  const { $schema: _dialect, ...rest } = document
  return rest
}

const DATA_KEYWORDS = new Set(['const', 'enum', 'default', 'examples', 'required'])
const NAME_MAP_KEYWORDS = new Set(['properties', 'patternProperties', '$defs', 'dependentSchemas'])

function unrepresentableAt(schema: unknown, at: string): string | undefined {
  if (typeof schema !== 'object' || schema === null) return undefined
  if (Array.isArray(schema)) {
    for (const [index, entry] of schema.entries()) {
      const found = unrepresentableAt(entry, `${at}/${index}`)
      if (found !== undefined) return found
    }
    return undefined
  }
  if (Object.keys(schema).length === 0) return at
  for (const [key, entry] of Object.entries(schema)) {
    if (DATA_KEYWORDS.has(key)) continue
    const members: [string, unknown][] = NAME_MAP_KEYWORDS.has(key)
      ? Object.entries(entry as object)
      : [['', entry]]
    for (const [name, member] of members) {
      const found = unrepresentableAt(member, name === '' ? `${at}/${key}` : `${at}/${key}/${name}`)
      if (found !== undefined) return found
    }
  }
  return undefined
}

/**
 * The output-mode document of a runtime schema, with its declared wire terminals described by
 * their wire halves.
 *
 * Converted with `unrepresentable: 'any'` only so the override can replace the terminals; any empty
 * schema left afterwards is an unrepresentable node nobody declared, and it throws rather than
 * shipping as "anything".
 */
export function deriveWireOutputRepresentation(
  runtimeSchema: z.ZodType,
  terminals: ReadonlyMap<z.ZodType, z.ZodType> = WIRE_TERMINALS,
): JsonSchemaDocument {
  const document = z.toJSONSchema(runtimeSchema, {
    target: PUBLISHED_TARGET,
    io: 'output',
    unrepresentable: 'any',
    override: (context) => {
      const wire = terminals.get(context.zodSchema as unknown as z.ZodType)
      if (wire === undefined) return
      const replacement = withoutDialect(
        z.toJSONSchema(wire, { target: PUBLISHED_TARGET, io: 'output' }) as Record<string, unknown>,
      )
      for (const key of Object.keys(context.jsonSchema)) delete (context.jsonSchema as Record<string, unknown>)[key]
      Object.assign(context.jsonSchema, replacement)
    },
  }) as Record<string, unknown>

  const unrepresentable = unrepresentableAt(withoutDialect(document), '#')
  if (unrepresentable !== undefined) {
    throw new Error(
      `output contract has an unrepresentable construct at ${unrepresentable}; declare its wire `
      + 'terminal or give the runtime schema a representable output',
    )
  }
  return deepFreeze(document)
}

/**
 * Pair a runtime schema with its explicit output document, as one Standard Schema object.
 *
 * `validate` delegates to the runtime schema, so the advertised contract can never enforce less
 * than `invokeFunction` does. `jsonSchema.input` is the runtime schema's own input conversion;
 * `jsonSchema.output` returns a fresh copy of the document for the one target it is written in.
 */
export function createOutputContract<Schema extends z.ZodType>(
  runtimeSchema: Schema,
  outputRepresentation: Record<string, unknown>,
): OutputContract<Schema> {
  const representation = deepFreeze(structuredClone(outputRepresentation))
  const runtime = runtimeSchema['~standard']
  return Object.freeze({
    runtimeSchema,
    outputRepresentation: representation,
    '~standard': Object.freeze({
      version: 1 as const,
      vendor: 'agent-qa',
      validate: (value: unknown, options?: { readonly libraryOptions?: Record<string, unknown> | undefined }) =>
        runtime.validate(value, options) as StandardResult<z.output<Schema>> | Promise<StandardResult<z.output<Schema>>>,
      jsonSchema: Object.freeze({
        input: (options: StandardJsonOptions) => runtime.jsonSchema.input(options),
        output: (options: StandardJsonOptions) => {
          if (options.target !== PUBLISHED_TARGET) {
            throw new Error(
              `output contract publishes ${PUBLISHED_TARGET} only; ${String(options.target)} was requested`,
            )
          }
          return structuredClone(representation) as Record<string, unknown>
        },
      }),
    }),
  })
}

/** A runtime schema's output contract, with its document derived from the wire terminals. */
export function wireOutputContract<Schema extends z.ZodType>(
  runtimeSchema: Schema,
): OutputContract<Schema> {
  return createOutputContract(runtimeSchema, deriveWireOutputRepresentation(runtimeSchema))
}
