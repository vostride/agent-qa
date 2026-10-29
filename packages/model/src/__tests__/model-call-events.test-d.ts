import { expectTypeOf, test } from 'vitest'
import type { ModelCallEvent, ModelCallObservation, ModelCallReport, ModelCallReportOrigin } from '../index.js'

test('C423-OBSERVATION-EXACT event discriminants are exactly start/success/failure', () => {
  expectTypeOf<ModelCallEvent['kind']>().toEqualTypeOf<'start' | 'success' | 'failure'>()
})
test('C423-OBSERVATION-EXACT exhaustive event never-bar', () => {
  function exhaustive(event: ModelCallEvent) {
    switch (event.kind) {
      case 'start': return
      case 'success': return event.report
      case 'failure': return
      default: { const absent: never = event; return absent }
    }
  }
  expectTypeOf(exhaustive).parameter(0).toEqualTypeOf<ModelCallEvent>()
})
test('C423-OBSERVATION-EXACT trusted origin set has exactly four protocols', () => {
  expectTypeOf<ModelCallReportOrigin>().toEqualTypeOf<
    'openai-chat' | 'openai-responses' | 'anthropic-messages' | 'gemini'
  >()
})
test('C423-OBSERVATION-EXACT exhaustive origin never-bar', () => {
  function exhaustive(origin: ModelCallReportOrigin) {
    switch (origin) {
      case 'openai-chat': case 'openai-responses': case 'anthropic-messages': case 'gemini': return
      default: { const absent: never = origin; return absent }
    }
  }
  expectTypeOf(exhaustive).parameter(0).toEqualTypeOf<ModelCallReportOrigin>()
})
test('C423-OBSERVATION-EXACT only success carries a neutral report', () => {
  expectTypeOf<Extract<ModelCallEvent, { kind: 'success' }>['report']>().toEqualTypeOf<ModelCallReport>()
  expectTypeOf<keyof ModelCallReport>().toEqualTypeOf<
    'inputTokens' | 'outputTokens' | 'cachedInputTokens' | 'respondingModelId'
  >()
  expectTypeOf<keyof Extract<ModelCallEvent, { kind: 'failure' }>>().toEqualTypeOf<'kind'>()
})
test('C423-OBSERVATION-EXACT observer receives events with legacy no-argument notification', () => {
  expectTypeOf<NonNullable<ModelCallObservation['onCall']>>().parameter(0).toEqualTypeOf<ModelCallEvent>()
  expectTypeOf<NonNullable<ModelCallObservation['onProviderCall']>>().parameters.toEqualTypeOf<[]>()
})
