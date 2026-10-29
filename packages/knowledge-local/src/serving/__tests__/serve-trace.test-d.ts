/**
 * The D-16 structural claim, pinned where a runtime case cannot pin it.
 *
 * D-16 says it is IMPOSSIBLE to serve without producing a trace. That is a claim about SIGNATURES,
 * and this package's vitest config type-checks `*.test-d.ts` only — 387-02 proved the consequence
 * by experiment, deleting a schema interface field outright and watching 702 runtime cases stay
 * green. So the impossibility is asserted here as a compile-time fact: the three serving entries
 * return composites, and a bare brief is NOT assignable to any of their return types.
 *
 * What would have to be written for a trace-less serve to exist: one of these entries would have
 * to return `BriefBlock` / `CautionBlock` / `AuthoringBrief` directly again. Each `toEqualTypeOf`
 * below fails on exactly that edit, and each `@ts-expect-error` below becomes an unused
 * expect-error — which is itself a type error — if the return type ever narrows back.
 */
import type {
  AuthoringBrief,
  BriefBlock,
  CautionBlock,
  ServedRetrievalTraceV1,
} from '@vostride/agent-qa-schema'
import { expectTypeOf, it } from 'vitest'

import { assembleAuthoringBrief } from '../get-authoring-brief.js'
import { selectCautions } from '../get-cautions.js'
import { assembleRunBrief } from '../get-run-brief.js'
import { openKnowledgeReader } from '../reader.js'

declare const brief: BriefBlock
declare const cautionBlock: CautionBlock
declare const authoringBrief: AuthoringBrief

it('serving entries cannot yield a brief without a trace', () => {
  expectTypeOf<ReturnType<typeof assembleRunBrief>>().toEqualTypeOf<{
    readonly brief: BriefBlock
    readonly trace: ServedRetrievalTraceV1
  }>()
  expectTypeOf<ReturnType<typeof assembleAuthoringBrief>>().toEqualTypeOf<{
    readonly brief: AuthoringBrief
    readonly trace: ServedRetrievalTraceV1
  }>()
  expectTypeOf<ReturnType<typeof selectCautions>['trace']>()
    .toEqualTypeOf<ServedRetrievalTraceV1>()

  // The old bare-value signatures no longer exist at any of the three entries.
  // @ts-expect-error a BriefBlock alone is not what assembleRunBrief returns
  const _runBrief: ReturnType<typeof assembleRunBrief> = brief
  // @ts-expect-error an AuthoringBrief alone is not what assembleAuthoringBrief returns
  const _authoring: ReturnType<typeof assembleAuthoringBrief> = authoringBrief
  // @ts-expect-error a CautionBlock alone is not what selectCautions returns
  const _cautions: ReturnType<typeof selectCautions> = cautionBlock
  void _runBrief
  void _authoring
  void _cautions
})

it('the reader port surfaces both composites to the runner', () => {
  const reader = openKnowledgeReader({ knowledgeRoot: '/nowhere' })
  expectTypeOf(reader.getRunBrief).returns.toEqualTypeOf<{
    brief: BriefBlock
    trace: ServedRetrievalTraceV1
  }>()
  expectTypeOf(reader.getCautions).returns.toEqualTypeOf<{
    block: CautionBlock
    trace: ServedRetrievalTraceV1
  }>()
})
