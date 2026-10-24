import { z } from 'zod'
import { EvidenceArtifactRefSchema } from '../ids/artifact-ref'

export type NetworkBodyContentType =
  | 'application/json' | 'text/html' | 'text/plain' | 'application/xml'
  | 'text/xml' | 'application/x-www-form-urlencoded'
export const NETWORK_BODY_CONTENT_TYPES = [
  'application/json', 'text/html', 'text/plain', 'application/xml', 'text/xml',
  'application/x-www-form-urlencoded',
] as const satisfies readonly NetworkBodyContentType[]
export const NETWORK_BODY_MAX_BYTES = 32768

export type EvidenceKind = 'console' | 'network' | 'a11y' | 'aria' | 'variables'
export const EVIDENCE_KINDS = [
  'console', 'network', 'a11y', 'aria', 'variables',
] as const satisfies readonly EvidenceKind[]
export type EvidenceAbsenceReason =
  | 'empty' | 'not-captured' | 'unsupported' | 'unavailable' | 'failed'
export const EVIDENCE_ABSENCE_REASONS = [
  'empty', 'not-captured', 'unsupported', 'unavailable', 'failed',
] as const satisfies readonly EvidenceAbsenceReason[]
export const EvidenceKindSchema = z.enum(EVIDENCE_KINDS)
export const EvidenceAbsenceReasonSchema = z.enum(EVIDENCE_ABSENCE_REASONS)

const count = z.number().int().nonnegative()
export const ConsoleEvidenceRecordSchema = z.strictObject({
  level: z.string(), text: z.string(), timestamp: z.number(),
  location: z.strictObject({ url: z.string(), lineNumber: count, columnNumber: count }).optional(),
})
export const NetworkEvidenceRecordSchema = z.strictObject({
  url: z.string(), method: z.string(), status: count,
  requestHeaders: z.record(z.string(), z.string()),
  responseHeaders: z.record(z.string(), z.string()),
  body: z.string().optional(), requestBody: z.string().optional(),
  startTime: z.number(), endTime: z.number(),
  timing: z.record(z.string(), z.number()).optional(),
  requestSize: count.optional(), responseSize: count.optional(),
})
export const A11yEvidenceRecordSchema = z.strictObject({
  ruleId: z.string(), impact: z.enum(['minor', 'moderate', 'serious', 'critical']),
  description: z.string(), help: z.string(), helpUrl: z.string(),
  nodes: z.array(z.strictObject({ html: z.string(), target: z.array(z.string()) })),
})
const VariableSnapshotEntrySchema = z.strictObject({
  value: z.string(), source: z.enum(['env', 'inline', 'suite', 'cli', 'capture', 'hook', 'step']),
})
type VariableSnapshotEntry = z.infer<typeof VariableSnapshotEntrySchema>
const PRESERVED_PROTO = Symbol('preserved __proto__ entry')
type PreservedProto = { [PRESERVED_PROTO]?: VariableSnapshotEntry }
// Captured names are data, but Zod's record parser skips an own __proto__ and its intersection
// merge deletes one. The second arm validates that entry and carries it through the merge under a
// symbol, and the last stage restores it as an own property. The record supplies the JSON-schema
// input contract and validates every other entry.
export const VariableSnapshotSchema = z.record(z.string(), VariableSnapshotEntrySchema).and(
  z.unknown().transform((input, ctx): object => {
    if (typeof input !== 'object' || input === null || !Object.hasOwn(input, '__proto__')) return {}
    const entry = VariableSnapshotEntrySchema.safeParse(
      Object.getOwnPropertyDescriptor(input, '__proto__')?.value,
    )
    if (entry.success) return { [PRESERVED_PROTO]: entry.data } satisfies PreservedProto
    for (const issue of entry.error.issues) {
      ctx.addIssue({ code: 'custom', message: issue.message, path: ['__proto__', ...issue.path] })
    }
    return {}
  }),
).transform((merged): Record<string, VariableSnapshotEntry> => {
  const { [PRESERVED_PROTO]: preserved, ...entries } = merged as typeof merged & PreservedProto
  return preserved === undefined ? entries : Object.defineProperty(entries, '__proto__', {
    value: preserved, enumerable: true, writable: true, configurable: true,
  })
})
export type VariableSnapshot = z.infer<typeof VariableSnapshotSchema>

export const RUN_EVIDENCE_DOCUMENT_SCHEMA_VERSION = 2

export const ConsoleEvidenceDocumentSchema = z.strictObject({
  schemaVersion: z.literal(RUN_EVIDENCE_DOCUMENT_SCHEMA_VERSION), kind: z.literal('console'),
  records: z.array(ConsoleEvidenceRecordSchema),
})
export const NetworkEvidenceDocumentSchema = z.strictObject({
  schemaVersion: z.literal(RUN_EVIDENCE_DOCUMENT_SCHEMA_VERSION), kind: z.literal('network'),
  records: z.array(NetworkEvidenceRecordSchema),
})
export const A11yEvidenceDocumentSchema = z.strictObject({
  schemaVersion: z.literal(RUN_EVIDENCE_DOCUMENT_SCHEMA_VERSION), kind: z.literal('a11y'),
  records: z.array(A11yEvidenceRecordSchema),
})
export const AriaEvidenceDocumentSchema = z.strictObject({
  schemaVersion: z.literal(RUN_EVIDENCE_DOCUMENT_SCHEMA_VERSION), kind: z.literal('aria'),
  tree: z.string(),
})
// Variables share the read-document shape but remain inline; they have no blob ref kind.
export const VariablesEvidenceDocumentSchema = z.strictObject({
  schemaVersion: z.literal(RUN_EVIDENCE_DOCUMENT_SCHEMA_VERSION), kind: z.literal('variables'),
  records: VariableSnapshotSchema,
})
export const EvidenceDocumentSchema = z.discriminatedUnion('kind', [
  ConsoleEvidenceDocumentSchema, NetworkEvidenceDocumentSchema, A11yEvidenceDocumentSchema,
  AriaEvidenceDocumentSchema, VariablesEvidenceDocumentSchema,
])
export type EvidenceDocument = z.infer<typeof EvidenceDocumentSchema>

const consolePresent = z.strictObject({
  kind: z.literal('console'), state: z.literal('present'),
  ref: EvidenceArtifactRefSchema.refine(ref => ref.id.startsWith('console-evidence:')),
  counts: z.strictObject({ total: count, errors: count, warnings: count }),
})
const networkPresent = z.strictObject({
  kind: z.literal('network'), state: z.literal('present'),
  ref: EvidenceArtifactRefSchema.refine(ref => ref.id.startsWith('network-evidence:')),
  counts: z.strictObject({ total: count, failed: count, errored: count }),
})
const a11yPresent = z.strictObject({
  kind: z.literal('a11y'), state: z.literal('present'),
  ref: EvidenceArtifactRefSchema.refine(ref => ref.id.startsWith('a11y-evidence:')),
  counts: z.strictObject({ minor: count, moderate: count, serious: count, critical: count }),
})
const ariaPresent = z.strictObject({
  kind: z.literal('aria'), state: z.literal('present'),
  ref: EvidenceArtifactRefSchema.refine(ref => ref.id.startsWith('aria-state:')),
})
const variablesPresent = z.strictObject({
  kind: z.literal('variables'), state: z.literal('present'), counts: z.strictObject({ count }),
})
const absent = z.strictObject({
  kind: EvidenceKindSchema, state: z.literal('absent'), reason: EvidenceAbsenceReasonSchema,
  evidenceIncomplete: z.boolean().optional(),
})
export const EvidenceEntrySchema = z.union([
  consolePresent, networkPresent, a11yPresent, ariaPresent, variablesPresent, absent,
])
export type EvidenceEntry = z.infer<typeof EvidenceEntrySchema>
const presentByKind = {
  console: consolePresent, network: networkPresent, a11y: a11yPresent, aria: ariaPresent,
  variables: variablesPresent,
}
// Not EvidenceEntrySchema intersected with a kind literal: Zod reconciles away a key that only one
// side of an intersection rejects, so a strict arm's stray key would pass.
export const evidenceEntryOfKind = <Kind extends EvidenceKind>(kind: Kind) =>
  z.union([presentByKind[kind], absent.extend({ kind: z.literal(kind) })])
export type AriaEvidenceEntry =
  | Extract<EvidenceEntry, { kind: 'aria'; state: 'present' }>
  | (Extract<EvidenceEntry, { state: 'absent' }> & { kind: 'aria' })
export type StepEvidenceEntries = {
  [K in Exclude<EvidenceKind, 'aria'>]:
    | Extract<EvidenceEntry, { kind: K; state: 'present' }>
    | (Extract<EvidenceEntry, { state: 'absent' }> & { kind: K })
}
