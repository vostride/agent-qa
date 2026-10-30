// Vitest type-checks only `*.test-d.ts`, so the serve-without-trace impossibility is asserted here.
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
