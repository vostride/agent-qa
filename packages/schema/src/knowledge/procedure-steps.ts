// Fail-closed: any malformation returns undefined, never a throw or dynamic dispatch.

import { z } from 'zod'

import { canonicalJson } from '../determinism/canonical-json'
import type { Anchor } from '../identity/anchor'
import type { ProcedureParamType } from './curator-tier'

// Replay re-finds the target strictly; `ordinal` stays only so committed bodies parse.
export interface ProcedureGuardTarget {
  role: string
  nameNormalized: string
  name?: string
  row?: string
  ordinal?: number
}

export interface ProcedureGuardDescriptor {
  target: ProcedureGuardTarget
  pageAnchor: Extract<Anchor, { t: 'page' }>
  landmarks?: string[]
}

export type ProcedureJsonValue =
  | string
  | number
  | boolean
  | null
  | ProcedureJsonValue[]
  | { [key: string]: ProcedureJsonValue }

export const procedureJsonValueSchema: z.ZodType<ProcedureJsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(procedureJsonValueSchema),
    z.record(z.string(), procedureJsonValueSchema),
  ]),
)

/**
 * One action value slot: a JSON scalar literal, a `{ param }` ref into the payload's parameter
 * schema, or a tagged `{ json }` literal. Composite replay semantics such as fileUpload.files and
 * doubleClick/rightClick.relativePosition must survive byte-faithfully. The tag keeps object
 * literals unambiguous from `{ param }`; null, arrays, and objects ride the wrapper while scalars
 * stay bare so every pre-existing committed body remains parseable.
 */
export type ProcedureValueSlot =
  | string
  | number
  | boolean
  | { param: string }
  | { json: ProcedureJsonValue }

export interface ProcedureParameterSpec {
  name: string
  type: ProcedureParamType
  required: boolean
}

export interface ProcedureStepSpec {
  instruction: string
  action: {
    type: string
    targets: Record<string, ProcedureGuardTarget>
    values: Record<string, ProcedureValueSlot>
  }
  guard: ProcedureGuardDescriptor
}

export const PROCEDURE_BODY_SCHEMA_VERSION = 2

/** The one committed procedure body payload (stamped PROCEDURE_BODY_SCHEMA_VERSION). */
export interface ProcedureBodyPayload {
  schemaVersion: typeof PROCEDURE_BODY_SCHEMA_VERSION
  parameters: ProcedureParameterSpec[]
  steps: ProcedureStepSpec[]
  successAssertion: string
}

const guardTargetSchema = z
  .object({
    role: z.string(),
    nameNormalized: z.string(),
    name: z.string().optional(),
    row: z.string().optional(),
    ordinal: z.number().int().optional(),
  })
  .strict()

const guardDescriptorSchema = z
  .object({
    target: guardTargetSchema,
    pageAnchor: z.object({ t: z.literal('page'), route: z.string() }).strict(),
    landmarks: z.array(z.string()).optional(),
  })
  .strict()

const valueSlotSchema: z.ZodType<ProcedureValueSlot> = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.object({ param: z.string() }).strict(),
  z.object({ json: procedureJsonValueSchema }).strict(),
])

const stepSpecSchema = z
  .object({
    instruction: z.string(),
    action: z
      .object({
        type: z.string(),
        targets: z.record(z.string(), guardTargetSchema),
        values: z.record(z.string(), valueSlotSchema),
      })
      .strict(),
    guard: guardDescriptorSchema,
  })
  .strict()

const bodyPayloadSchema: z.ZodType<ProcedureBodyPayload> = z
  .object({
    schemaVersion: z.literal(PROCEDURE_BODY_SCHEMA_VERSION),
    parameters: z.array(
      z
        .object({
          name: z.string(),
          type: z.enum(['string', 'number', 'boolean', 'secret']),
          required: z.boolean(),
        })
        .strict(),
    ),
    steps: z.array(stepSpecSchema),
    successAssertion: z.string(),
  })
  .strict()
  .superRefine((payload, context) => {
    // This codec rejects duplicate parameter names, so an ambiguous body is never served.
    if (!Array.isArray(payload.parameters)) return
    const names = new Set<string>()
    payload.parameters.forEach((parameter, index) => {
      if (typeof parameter?.name !== 'string') return
      if (names.has(parameter.name)) {
        context.addIssue({
          code: 'custom',
          message: `Duplicate procedure parameter name: ${parameter.name}`,
          path: ['parameters', index, 'name'],
        })
      }
      names.add(parameter.name)
    })
  })

const FENCE_OPEN = '```json agent-qa-procedure'
const FENCE_CLOSE = '```'

/**
 * Serialize a payload into the ONE fenced canonicalJson block a record.md body carries.
 * Byte-stable across calls (canonicalJson sorts keys recursively).
 */
export function serializeProcedureBody(payload: ProcedureBodyPayload): string {
  return `${FENCE_OPEN}\n${canonicalJson(payload)}\n${FENCE_CLOSE}\n`
}

// Any malformation returns undefined; this function never throws.
export function parseProcedureBody(body: string): ProcedureBodyPayload | undefined {
  const fenceStart = body.indexOf(FENCE_OPEN)
  if (fenceStart === -1) return undefined
  const contentStart = fenceStart + FENCE_OPEN.length
  const fenceEnd = body.indexOf(`\n${FENCE_CLOSE}`, contentStart)
  if (fenceEnd === -1) return undefined
  const raw = body.slice(contentStart, fenceEnd).trim()
  if (raw === '') return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  const result = bodyPayloadSchema.safeParse(parsed)
  return result.success ? result.data : undefined
}

// Prose and value slots stay out of the keys, so re-parameterizing never forks procedure identity.
export function procedureStepKeys(payload: ProcedureBodyPayload): string[] {
  return payload.steps.map((step) =>
    canonicalJson({
      action: { targets: step.action.targets, type: step.action.type },
      guard: step.guard,
    }),
  )
}
