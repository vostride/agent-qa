// Produces an inert JSON Schema, so a listing describes the contract without a validator handle.

import type { OutputContract } from '@vostride/agent-qa-schema'
import { z } from 'zod'

import type { FunctionSchemaProjection } from './spec.js'

/**
 * Freeze a value and everything reachable through its own enumerable properties.
 *
 * Shallow freezing is not enough and the difference is the whole defect: sealing the top
 * object leaves every nested schema node writable, so the escape simply moves one level
 * down. The `seen` set keeps the walk terminating on a self-referential document — zod
 * emits `$ref` strings rather than object cycles today, but a guard that depends on that
 * staying true would be one library release away being wrong.
 */
function deepFreeze<Value>(value: Value, seen: WeakSet<object>): Value {
  if (typeof value !== 'object' || value === null) return value

  const node = value as unknown as object
  if (seen.has(node)) return value
  seen.add(node)

  for (const nested of Object.values(node as Record<string, unknown>)) {
    deepFreeze(nested, seen)
  }
  return Object.freeze(value)
}

// Input mode on both sides: zod's output mode throws on branded-id transforms, breaking listing.
export function toSchemaProjection(schema: z.ZodType): FunctionSchemaProjection {
  const projected = z.toJSONSchema(schema, { io: 'input' }) as Record<string, unknown>
  return deepFreeze(projected, new WeakSet())
}

/**
 * Project a declared output: the companion's output document when the spec has one, otherwise
 * the input-mode projection above.
 */
export function toOutputProjection(
  output: z.ZodType,
  outputRepresentation: OutputContract | undefined,
): FunctionSchemaProjection {
  if (outputRepresentation === undefined) return toSchemaProjection(output)
  const projected = outputRepresentation['~standard'].jsonSchema.output({ target: 'draft-2020-12' })
  return deepFreeze(projected, new WeakSet())
}
