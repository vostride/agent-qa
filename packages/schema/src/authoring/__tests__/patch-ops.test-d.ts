// A fourth op kind would compile alone; these assertions keep the applier's `switch` exhaustive.

import { expectTypeOf } from 'vitest'

import type {
  EditablePointerRoot,
  PatchOp,
  PatchOpKind,
  TestEditPatchSet,
} from '../patch-ops'

expectTypeOf<PatchOpKind>().toEqualTypeOf<'add' | 'remove' | 'replace'>()
expectTypeOf<PatchOp['op']>().toEqualTypeOf<'add' | 'remove' | 'replace'>()

expectTypeOf<EditablePointerRoot>().toEqualTypeOf<'steps' | 'name' | 'context'>()

// `remove` carries no `value`: narrowing on the discriminant must remove the field entirely,
// not widen it to `string | undefined`, or the applier could write a value on a removal.
type RemoveOp = Extract<PatchOp, { op: 'remove' }>
expectTypeOf<RemoveOp>().toEqualTypeOf<{ op: 'remove'; path: string }>()

type AddOp = Extract<PatchOp, { op: 'add' }>
expectTypeOf<AddOp>().toEqualTypeOf<{ op: 'add'; path: string; value: string }>()

expectTypeOf<TestEditPatchSet>().toEqualTypeOf<{ thoughts: string; patches: PatchOp[] }>()
