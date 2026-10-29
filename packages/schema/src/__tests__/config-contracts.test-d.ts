import { expectTypeOf, test } from 'vitest'
import {
  CONFIG_ACTION_REFUSALS,
  CONFIG_NAMED_ARRAYS,
  CONFIG_WRITE_DENIED_ROOTS,
  CONFIG_WRITE_OPS,
  CONFIG_WRITE_REFUSALS,
  LLM_SETUP_REFUSALS,
  PROVIDER_ERROR_CLASSES,
} from '../index'
import type {
  ConfigActionRefusal,
  ConfigChange,
  ConfigNamedArray,
  ConfigPathSegment,
  ConfigWriteDeniedRoot,
  ConfigWriteOp,
  ConfigWriteRefusal,
  LlmSetupRefusal,
  ProviderErrorClass,
} from '../index'

test('C429-CONFIG-WRITE-OPS-EXACT', () => {
  type Expected = 'set' | 'unset' | 'append' | 'set-if-absent' | 'move' | 'expect'
  expectTypeOf<ConfigWriteOp>().toEqualTypeOf<Expected>()
  expectTypeOf<(typeof CONFIG_WRITE_OPS)[number]>().toEqualTypeOf<Expected>()
  expectTypeOf<Exclude<ConfigWriteOp, Expected>>().toEqualTypeOf<never>()
  expectTypeOf<Exclude<Expected, ConfigWriteOp>>().toEqualTypeOf<never>()
  expectTypeOf<ConfigChange['op']>().toEqualTypeOf<Expected>()
  expectTypeOf<ConfigChange['path'][number]>().toEqualTypeOf<ConfigPathSegment>()
})

test('C429-CONFIG-WRITE-DENIED-ROOTS-EXACT', () => {
  type Expected = 'plugins'
  expectTypeOf<ConfigWriteDeniedRoot>().toEqualTypeOf<Expected>()
  expectTypeOf<(typeof CONFIG_WRITE_DENIED_ROOTS)[number]>().toEqualTypeOf<Expected>()
  expectTypeOf<Exclude<ConfigWriteDeniedRoot, Expected>>().toEqualTypeOf<never>()
  expectTypeOf<Exclude<Expected, ConfigWriteDeniedRoot>>().toEqualTypeOf<never>()
})

test('C429-CONFIG-WRITE-REFUSALS-EXACT', () => {
  type Expected =
    | 'invalid_write_input'
    | 'file_invalid'
    | 'path_not_found'
    | 'validation_failed'
    | 'write_failed'
    | 'field_changed'
    | 'path_not_writable'
    | 'marker_written_back'
  expectTypeOf<ConfigWriteRefusal>().toEqualTypeOf<Expected>()
  expectTypeOf<(typeof CONFIG_WRITE_REFUSALS)[number]>().toEqualTypeOf<Expected>()
  expectTypeOf<Exclude<ConfigWriteRefusal, Expected>>().toEqualTypeOf<never>()
  expectTypeOf<Exclude<Expected, ConfigWriteRefusal>>().toEqualTypeOf<never>()
})

test('C429-CONFIG-NAMED-ARRAYS-EXACT', () => {
  type Expected = 'registry.llms'
  expectTypeOf<ConfigNamedArray>().toEqualTypeOf<Expected>()
  expectTypeOf<(typeof CONFIG_NAMED_ARRAYS)[number]>().toEqualTypeOf<Expected>()
  expectTypeOf<Exclude<ConfigNamedArray, Expected>>().toEqualTypeOf<never>()
  expectTypeOf<Exclude<Expected, ConfigNamedArray>>().toEqualTypeOf<never>()
})

test('C429-PROVIDER-ERROR-CLASSES-EXACT', () => {
  type Expected =
    | 'auth_error'
    | 'model_not_found'
    | 'rate_limit'
    | 'network_error'
    | 'invalid_request'
    | 'provider_error'
  expectTypeOf<ProviderErrorClass>().toEqualTypeOf<Expected>()
  expectTypeOf<(typeof PROVIDER_ERROR_CLASSES)[number]>().toEqualTypeOf<Expected>()
  expectTypeOf<Exclude<ProviderErrorClass, Expected>>().toEqualTypeOf<never>()
  expectTypeOf<Exclude<Expected, ProviderErrorClass>>().toEqualTypeOf<never>()
})

test('C429-LLM-SETUP-REFUSALS-EXACT', () => {
  type Expected =
    | 'invalid_setup_input'
    | 'name_invalid'
    | 'name_taken'
    | 'credential_provider_conflict'
    | 'credential_not_accepted'
    | 'credential_missing'
    | 'credential_exists'
    | 'validation_failed'
  expectTypeOf<LlmSetupRefusal>().toEqualTypeOf<Expected>()
  expectTypeOf<(typeof LLM_SETUP_REFUSALS)[number]>().toEqualTypeOf<Expected>()
  expectTypeOf<Exclude<LlmSetupRefusal, Expected>>().toEqualTypeOf<never>()
  expectTypeOf<Exclude<Expected, LlmSetupRefusal>>().toEqualTypeOf<never>()
})

test('C429-CONFIG-ACTION-REFUSALS-EXACT', () => {
  type Expected = 'undo_expired' | 'undo_conflict'
  expectTypeOf<ConfigActionRefusal>().toEqualTypeOf<Expected>()
  expectTypeOf<(typeof CONFIG_ACTION_REFUSALS)[number]>().toEqualTypeOf<Expected>()
  expectTypeOf<Exclude<ConfigActionRefusal, Expected>>().toEqualTypeOf<never>()
  expectTypeOf<Exclude<Expected, ConfigActionRefusal>>().toEqualTypeOf<never>()
})
