import { expectTypeOf, test } from 'vitest'
import type { z } from 'zod'
import { NETWORK_BODY_CONTENT_TYPES, NETWORK_BODY_MAX_BYTES } from '../index'
import type { NetworkBodyContentType } from '../index'

test('C423-CONTENT-TYPES-EXACT', () => {
  type Expected = 'application/json' | 'text/html' | 'text/plain' | 'application/xml' | 'text/xml' | 'application/x-www-form-urlencoded'
  expectTypeOf<NetworkBodyContentType>().toEqualTypeOf<Expected>()
  expectTypeOf<(typeof NETWORK_BODY_CONTENT_TYPES)[number]>().toEqualTypeOf<Expected>()
  expectTypeOf<Exclude<NetworkBodyContentType, (typeof NETWORK_BODY_CONTENT_TYPES)[number]>>().toEqualTypeOf<never>()
  expectTypeOf<Exclude<(typeof NETWORK_BODY_CONTENT_TYPES)[number], NetworkBodyContentType>>().toEqualTypeOf<never>()
  expectTypeOf<typeof NETWORK_BODY_MAX_BYTES>().toEqualTypeOf<32768>()
})
import {
  EVIDENCE_KINDS, EVIDENCE_ABSENCE_REASONS, EVIDENCE_REF_PREFIXES,
  EvidenceDocumentSchema, EvidenceEntrySchema,
} from '../index'
import type {
  ArtifactRef, EvidenceArtifactRef, EvidenceKind, EvidenceAbsenceReason, EvidenceRefPrefix,
  EvidenceDocument, EvidenceEntry, StepEvidenceEntries, VariableSnapshot,
} from '../index'

test('C423-KINDS-EXACT', () => {
  type Expected = 'console' | 'network' | 'a11y' | 'aria' | 'variables'
  expectTypeOf<EvidenceKind>().toEqualTypeOf<Expected>()
  expectTypeOf<(typeof EVIDENCE_KINDS)[number]>().toEqualTypeOf<Expected>()
  expectTypeOf<Exclude<Expected, EvidenceKind>>().toEqualTypeOf<never>()
  expectTypeOf<Exclude<EvidenceKind, Expected>>().toEqualTypeOf<never>()
  expectTypeOf<EvidenceDocument['kind']>().toEqualTypeOf<Expected>()
  expectTypeOf<EvidenceDocument>().toEqualTypeOf<z.infer<typeof EvidenceDocumentSchema>>()
})
test('C423-ABSENCE-EXACT', () => {
  type Expected = 'empty' | 'not-captured' | 'unsupported' | 'unavailable' | 'failed'
  expectTypeOf<EvidenceAbsenceReason>().toEqualTypeOf<Expected>()
  expectTypeOf<(typeof EVIDENCE_ABSENCE_REASONS)[number]>().toEqualTypeOf<Expected>()
  expectTypeOf<Exclude<EvidenceAbsenceReason, Expected>>().toEqualTypeOf<never>()
  expectTypeOf<Exclude<Expected, EvidenceAbsenceReason>>().toEqualTypeOf<never>()
  expectTypeOf<Extract<EvidenceEntry, { state: 'absent' }>['reason']>().toEqualTypeOf<Expected>()
})
test('C423-REFS-EXACT', () => {
  type Expected = 'decision-screenshot:' | 'console-evidence:' | 'network-evidence:' | 'a11y-evidence:' | 'aria-state:'
  expectTypeOf<EvidenceRefPrefix>().toEqualTypeOf<Expected>()
  expectTypeOf<(typeof EVIDENCE_REF_PREFIXES)[number]>().toEqualTypeOf<Expected>()
  expectTypeOf<Exclude<EvidenceRefPrefix, Expected>>().toEqualTypeOf<never>()
  expectTypeOf<Exclude<Expected, EvidenceRefPrefix>>().toEqualTypeOf<never>()
  expectTypeOf<EvidenceArtifactRef['id']>().toEqualTypeOf<`${Expected}${string}`>()
  expectTypeOf<ArtifactRef>().toEqualTypeOf<{ id: string; sha: string; evidenceIncomplete?: boolean }>()
})
test('C423-PRESENCE-EXACT', () => {
  expectTypeOf<EvidenceEntry>().toEqualTypeOf<z.infer<typeof EvidenceEntrySchema>>()
  expectTypeOf<EvidenceEntry['state']>().toEqualTypeOf<'present' | 'absent'>()
  expectTypeOf<Extract<EvidenceEntry, { state: 'present' }>['kind']>().toEqualTypeOf<'console' | 'network' | 'a11y' | 'aria' | 'variables'>()
  expectTypeOf<Extract<keyof Extract<EvidenceEntry, { state: 'absent' }>, 'counts' | 'ref'>>().toEqualTypeOf<never>()
  expectTypeOf<keyof StepEvidenceEntries>().toEqualTypeOf<'console' | 'network' | 'a11y' | 'variables'>()
  expectTypeOf<Extract<keyof Extract<EvidenceEntry, { kind: 'variables'; state: 'present' }>, 'ref'>>().toEqualTypeOf<never>()
  expectTypeOf<Extract<keyof Extract<EvidenceEntry, { kind: 'aria'; state: 'present' }>, 'counts'>>().toEqualTypeOf<never>()
})
test('C423-VARIABLES source and value retain the finalized snapshot shape', () => {
  expectTypeOf<VariableSnapshot>().toEqualTypeOf<Record<string, { value: string; source: 'env' | 'inline' | 'suite' | 'cli' | 'capture' | 'hook' | 'step' }>>()
})
