// Type-level pins: the routes are mutually non-assignable and neither function takes model output.

import { expectTypeOf, test } from 'vitest'

import type {
  CompletedRunHandoff,
  DraftRef,
  RunEvidenceChannel,
  RunEvidenceRef,
  VerdictSource,
} from '@vostride/agent-qa-schema'

import type {
  PostVerifyRoute,
  RepairRoute,
  RouterMechanicsSignalName,
  RouterRepairSignalClass,
  RouterSignalClass,
  RouterStopSignalClass,
  StopRoute,
} from '../router.js'
import type { classifyFailureEvidence, routeRepairOrStop } from '../router.js'
import type { RepairDeps } from '../repair.js'

declare const repair: RepairRoute
declare const stop: StopRoute

test('the repair and stop routes are live union arms that cannot be assigned to each other', () => {
  // `toExtend` and not the deprecated `toMatchTypeOf`, which expect-type 1.3 superseded.
  //
  // HOW A NEGATED PIN FAILS, since the failure mode is not obvious: `not.toExtend<E>()` takes zero
  // arguments only while the assertion HOLDS. The moment the two arms become assignable the
  // signature grows a required mismatch parameter and the call reads `Expected 1 arguments, but
  // got 0` — so the pin reds by arity, at this exact line, rather than by silently passing.
  expectTypeOf(repair).not.toExtend<StopRoute>()
  expectTypeOf(stop).not.toExtend<RepairRoute>()
  expectTypeOf<StopRoute>().not.toExtend<RepairRoute>()
  expectTypeOf<RepairRoute>().not.toExtend<StopRoute>()

  // Each arm is a member of the union, so the non-assignability above is a statement about two
  // live arms rather than about two types that merely happen to be unrelated.
  expectTypeOf(repair).toExtend<PostVerifyRoute>()
  expectTypeOf(stop).toExtend<PostVerifyRoute>()

  // The REQUIRED fields that carry the separation. An arm stripped of the field the other lacks
  // stops satisfying its own type, so making `mechanics` or `evidenceRefs` optional — the one
  // edit that would quietly restore assignability in both directions — reds here first.
  expectTypeOf<{
    kind: 'repair'
    signalClass: RouterRepairSignalClass
    failingStepIndex: number | null
  }>().not.toExtend<RepairRoute>()
  expectTypeOf<{
    kind: 'stop'
    signalClass: RouterStopSignalClass
    failurePoint: null
  }>().not.toExtend<StopRoute>()

  // And the whole field sets, by equality: a field added to either arm, or dropped, fails here.
  expectTypeOf<keyof RepairRoute>().toEqualTypeOf<
    'kind' | 'signalClass' | 'mechanics' | 'failingStepIndex'
  >()
  expectTypeOf<keyof StopRoute>().toEqualTypeOf<
    'kind' | 'signalClass' | 'failurePoint' | 'evidenceRefs'
  >()
})

test('the route kinds, signal classes, mechanics signals and evidence channels are closed sets', () => {
  expectTypeOf<PostVerifyRoute['kind']>().toEqualTypeOf<'repair' | 'stop'>()
  expectTypeOf<RepairRoute['kind']>().toEqualTypeOf<'repair'>()
  expectTypeOf<StopRoute['kind']>().toEqualTypeOf<'stop'>()

  // The two signal-class partitions do not overlap and together exhaust the routable classes, so
  // an arm cannot be handed a class the other arm owns.
  expectTypeOf<RepairRoute['signalClass']>().toEqualTypeOf<RouterRepairSignalClass>()
  expectTypeOf<StopRoute['signalClass']>().toEqualTypeOf<RouterStopSignalClass>()
  expectTypeOf<RouterRepairSignalClass>().toEqualTypeOf<'execution-mechanics'>()
  expectTypeOf<RouterStopSignalClass>().toEqualTypeOf<
    'clean-definitive-assertion-fail' | 'mixed-evidence' | 'indefinitive-failure'
  >()
  expectTypeOf<RouterSignalClass>().toEqualTypeOf<
    RouterRepairSignalClass | RouterStopSignalClass | 'no-failure' | 'no-run-evidence'
  >()

  // The closed mechanics and evidence-channel vocabularies, pinned the same way: a signal the
  // router can name but no corpus row covers, or a channel silently dropped, fails here.
  expectTypeOf<RouterMechanicsSignalName>().toEqualTypeOf<
    | 'termination'
    | 'planning-failure'
    | 'member-timeout'
    | 'member-cancelled'
  >()
  expectTypeOf<'cycle'>().not.toExtend<RouterMechanicsSignalName>()
  expectTypeOf<'stagnation'>().not.toExtend<RouterMechanicsSignalName>()
  expectTypeOf<RunEvidenceChannel>().toEqualTypeOf<
    'step-trace' | 'state-before' | 'state-after'
  >()
})

test('no model output can reach the routing decision', () => {
  expectTypeOf<Parameters<typeof routeRepairOrStop>>().toEqualTypeOf<
    [draftRef: DraftRef, handoff: CompletedRunHandoff | undefined]
  >()
  expectTypeOf<ReturnType<typeof routeRepairOrStop>>().toEqualTypeOf<PostVerifyRoute>()

  expectTypeOf<Parameters<typeof classifyFailureEvidence>>().toEqualTypeOf<
    [draftRef: DraftRef, handoff: CompletedRunHandoff | undefined]
  >()
  expectTypeOf<ReturnType<typeof classifyFailureEvidence>>().toEqualTypeOf<RouterSignalClass>()

  // The stop arm's verdict source is the RUN's recorded one, never a free-form string a model
  // could have written into it.
  expectTypeOf<NonNullable<StopRoute['failurePoint']>['verdictSource']>()
    .toEqualTypeOf<VerdictSource | undefined>()

  // Its key set is pinned by equality, so a payload smuggled onto an evidence ref fails here.
  expectTypeOf<keyof RunEvidenceRef>().toEqualTypeOf<
    'runId' | 'filePath' | 'testName' | 'stepIndex' | 'subActionIndex' | 'channel'
  >()
})

// A stop route must not type as a `RepairRoute`: `@ts-expect-error` reds if the call compiles.

// Declared, not imported: this file is typechecked and never executed.
declare const repairDraft: typeof import('../repair.js')['repairDraft']
declare const repairDeps: RepairDeps

test('repair accepts a repair route and refuses a stop route', () => {
  // @ts-expect-error — a StopRoute is not a RepairRoute, and repair must be unreachable from it.
  void repairDraft(stop, repairDeps)

  // The positive direction, so the cell above is a statement about a call that otherwise WORKS
  // rather than about a function nothing can call.
  void repairDraft(repair, repairDeps)

  expectTypeOf<Parameters<typeof repairDraft>[0]>().toEqualTypeOf<RepairRoute>()
})
