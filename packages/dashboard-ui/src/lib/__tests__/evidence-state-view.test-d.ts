import { expectTypeOf, test } from 'vitest'
import type { EvidenceAbsenceReason } from '@vostride/agent-qa-schema'
import {
  EVIDENCE_STATES, EVIDENCE_TONES, EVIDENCE_FAILURES, EVIDENCE_KIND_LABELS,
  EVIDENCE_STATE_OF_REASON,
  type EvidenceState, type EvidenceTone, type EvidenceFailure, type EvidenceKindLabel,
} from '../evidence-state-view'

test('evidence states are an exact union, and every absence reason maps to one', () => {
  type Expected = 'empty' | 'not-captured' | 'unsupported' | 'unavailable' | 'failed' | 'no-selection'
  expectTypeOf<EvidenceState>().toEqualTypeOf<Expected>()
  expectTypeOf<(typeof EVIDENCE_STATES)[number]>().toEqualTypeOf<Expected>()
  expectTypeOf<Exclude<EvidenceState, (typeof EVIDENCE_STATES)[number]>>().toEqualTypeOf<never>()
  expectTypeOf<Exclude<(typeof EVIDENCE_STATES)[number], EvidenceState>>().toEqualTypeOf<never>()
  expectTypeOf<keyof typeof EVIDENCE_STATE_OF_REASON>().toEqualTypeOf<EvidenceAbsenceReason>()
  expectTypeOf<Extract<(typeof EVIDENCE_STATE_OF_REASON)[EvidenceAbsenceReason], 'no-selection'>>().toEqualTypeOf<never>()
})

test('evidence tones are an exact union', () => {
  type Expected = 'positive' | 'neutral' | 'alert'
  expectTypeOf<EvidenceTone>().toEqualTypeOf<Expected>()
  expectTypeOf<(typeof EVIDENCE_TONES)[number]>().toEqualTypeOf<Expected>()
  expectTypeOf<Exclude<EvidenceTone, (typeof EVIDENCE_TONES)[number]>>().toEqualTypeOf<never>()
  expectTypeOf<Exclude<(typeof EVIDENCE_TONES)[number], EvidenceTone>>().toEqualTypeOf<never>()
})

test('evidence failures are an exact union', () => {
  type Expected = 'capture' | 'load'
  expectTypeOf<EvidenceFailure>().toEqualTypeOf<Expected>()
  expectTypeOf<(typeof EVIDENCE_FAILURES)[number]>().toEqualTypeOf<Expected>()
  expectTypeOf<Exclude<EvidenceFailure, (typeof EVIDENCE_FAILURES)[number]>>().toEqualTypeOf<never>()
  expectTypeOf<Exclude<(typeof EVIDENCE_FAILURES)[number], EvidenceFailure>>().toEqualTypeOf<never>()
})

test('evidence kind labels are an exact union', () => {
  type Expected = 'variables' | 'network' | 'console' | 'aria' | 'a11y' | 'video' | 'frame'
  expectTypeOf<EvidenceKindLabel>().toEqualTypeOf<Expected>()
  expectTypeOf<(typeof EVIDENCE_KIND_LABELS)[number]>().toEqualTypeOf<Expected>()
  expectTypeOf<Exclude<EvidenceKindLabel, (typeof EVIDENCE_KIND_LABELS)[number]>>().toEqualTypeOf<never>()
  expectTypeOf<Exclude<(typeof EVIDENCE_KIND_LABELS)[number], EvidenceKindLabel>>().toEqualTypeOf<never>()
})
