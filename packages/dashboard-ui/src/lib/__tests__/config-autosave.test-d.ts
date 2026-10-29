// The event union is the machine's only input, so its member names are a closed set.

import { expectTypeOf, test } from 'vitest'

import type { SaveState } from '../config-tabs'
import {
  deriveSaveStatus,
  reduceConfigAutosave,
  type ConfigAutosaveEvent,
  type ConfigAutosaveState,
} from '../config-autosave'

test('autosave events are an exact union', () => {
  type Expected =
    | 'edit'
    | 'write-started'
    | 'write-succeeded'
    | 'write-failed'
    | 'retry'
    | 'undo-offered'
    | 'undo-finished'
    | 'drafts-restored'
    | 'draft-cleared'
  expectTypeOf<ConfigAutosaveEvent['type']>().toEqualTypeOf<Expected>()
  expectTypeOf<Exclude<ConfigAutosaveEvent['type'], Expected>>().toEqualTypeOf<never>()
  expectTypeOf<Exclude<Expected, ConfigAutosaveEvent['type']>>().toEqualTypeOf<never>()
})

test('the derived status answers exactly SaveState', () => {
  expectTypeOf<ReturnType<typeof deriveSaveStatus>['state']>().toEqualTypeOf<SaveState>()
})

test('the reducer and the status both take now', () => {
  expectTypeOf(reduceConfigAutosave).parameters.toEqualTypeOf<
    [ConfigAutosaveState, ConfigAutosaveEvent, number]
  >()
  expectTypeOf(deriveSaveStatus).parameters.toEqualTypeOf<[ConfigAutosaveState, number]>()
})
