import { z } from 'zod'
import { isCanonicalObservationId, isObservationId } from '@vostride/agent-qa-ids'

const ObservationIdSchema = z.string().refine((value) => isObservationId(value), {
  message: 'Observation ID must be obs_ followed by either 10 canonical words or a legacy 6-word body',
})

const CanonicalObservationIdSchema = z.string().refine((value) => isCanonicalObservationId(value), {
  message: 'Observation ID must be obs_ followed by 10 id-agent words',
})

const ObservationSuiteSnapshotEntrySchema = z.object({
  test: z.string(),
  id: z.string(),
}).strict()

export const BaseObservationSchema = z.object({
  id: ObservationIdSchema,
  title: z.string().min(1),
  content: z.string().min(1),
  trust: z.number().min(0).max(1),
  created: z.string().datetime(),
  last_confirmed: z.string().datetime(),
  confirmed_count: z.number().int().min(0),
  contradicted_count: z.number().int().min(0),
  source_test: z.string().min(1),
}).strip()

export const SuiteObservationSchema = BaseObservationSchema.extend({
  position: z.number().int().min(0),
  suite_snapshot: z.array(ObservationSuiteSnapshotEntrySchema).min(1),
}).strip()

export const BaseObservationWriteSchema = BaseObservationSchema.extend({
  id: CanonicalObservationIdSchema,
}).strip()

export const SuiteObservationWriteSchema = BaseObservationWriteSchema.extend({
  position: z.number().int().min(0),
  suite_snapshot: z.array(ObservationSuiteSnapshotEntrySchema).min(1),
}).strip()

export type BaseObservation = z.infer<typeof BaseObservationSchema>
export type SuiteObservation = z.infer<typeof SuiteObservationSchema>
