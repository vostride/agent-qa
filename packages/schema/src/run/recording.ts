import { z } from 'zod'
import { EvidenceAbsenceReasonSchema } from './evidence'

export type RecordingState = 'present' | 'absent'
export const RECORDING_STATES = [
  'present', 'absent',
] as const satisfies readonly RecordingState[]
export type RecordingContentType = 'video/webm' | 'video/mp4'
export const RECORDING_CONTENT_TYPES = [
  'video/webm', 'video/mp4',
] as const satisfies readonly RecordingContentType[]
export const RECORDING_REF_PREFIX = 'recording:'

export const RecordingRefSchema = z.strictObject({
  id: z.templateLiteral([RECORDING_REF_PREFIX, z.string()]),
  sha: z.string().regex(/^[a-f0-9]{64}$/),
  evidenceIncomplete: z.boolean().optional(),
}).refine(ref => ref.id === `${RECORDING_REF_PREFIX}${ref.sha}`, {
  error: 'Recording ref id must contain its exact SHA and the recording prefix',
})
export type RecordingRef = z.infer<typeof RecordingRefSchema>

export const RecordingEntrySchema = z.union([
  z.strictObject({
    state: z.literal(RECORDING_STATES[0]),
    ref: RecordingRefSchema,
    contentType: z.enum(RECORDING_CONTENT_TYPES),
    byteLength: z.number().int().nonnegative(),
    durationMs: z.number().nonnegative().optional(),
  }),
  z.strictObject({
    state: z.literal(RECORDING_STATES[1]),
    reason: EvidenceAbsenceReasonSchema,
    evidenceIncomplete: z.boolean().optional(),
  }),
])
export type RecordingEntry = z.infer<typeof RecordingEntrySchema>
