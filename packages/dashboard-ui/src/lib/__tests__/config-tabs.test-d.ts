// THE CONFIG PAGE'S CLOSED SETS, PINNED BY TYPE (429 D-02/D-03, v54 bar).
//
// Each runtime array and its union are two spellings of one closed set; the runtime twins are the
// C429-*-EXACT cells in config-tabs.test.ts.

import { expectTypeOf, test } from 'vitest'

import {
  CONFIG_SECTION_ALIASES,
  CONFIG_SECTION_IDS,
  CONFIG_SECTIONS,
  CONFIG_TABS,
  CONNECTION_CHOICE_PROVIDERS,
  CONNECTION_CHOICES,
  EXPLICIT_ACTION_KINDS,
  FIELD_STATES,
  LEGACY_CONFIG_LINKS,
  LEGACY_CONFIG_PAIRS,
  MODEL_STATUSES,
  SAVE_STATES,
  TEST_RESULTS,
  resolveLegacyConfigLink,
  type ConfigSectionId,
  type ConfigTab,
  type ConnectionChoice,
  type ExplicitActionKind,
  type FieldState,
  type LegacyConfigPair,
  type ModelStatus,
  type SaveState,
  type TestResult,
} from '../config-tabs'

test('C429-CONFIG-TABS-EXACT', () => {
  type Expected = 'models' | 'targets' | 'execution' | 'project' | 'advanced'
  expectTypeOf<ConfigTab>().toEqualTypeOf<Expected>()
  expectTypeOf<(typeof CONFIG_TABS)[number]>().toEqualTypeOf<Expected>()
  expectTypeOf<Exclude<ConfigTab, (typeof CONFIG_TABS)[number]>>().toEqualTypeOf<never>()
  expectTypeOf<Exclude<(typeof CONFIG_TABS)[number], ConfigTab>>().toEqualTypeOf<never>()
})

test('C429-CONFIG-SECTIONS-EXACT', () => {
  type Expected =
    | 'models'
    | 'screenshot-size'
    | 'planner-limits'
    | 'targets'
    | 'devices'
    | 'login-states'
    | 'mobile-app-state'
    | 'browser'
    | 'timeouts'
    | 'runs'
    | 'cache'
    | 'recording'
    | 'accessibility'
    | 'log-capture'
    | 'test-discovery'
    | 'files'
    | 'knowledge'
    | 'dashboard'
    | 'logging'
    | 'pass-rate-scope'
    | 'mcp'
    | 'config-file'
  type Listed = (typeof CONFIG_SECTIONS)[ConfigTab][number]
  expectTypeOf<ConfigSectionId>().toEqualTypeOf<Expected>()
  expectTypeOf<(typeof CONFIG_SECTION_IDS)[number]>().toEqualTypeOf<Expected>()
  expectTypeOf<Exclude<ConfigSectionId, (typeof CONFIG_SECTION_IDS)[number]>>().toEqualTypeOf<never>()
  expectTypeOf<Exclude<(typeof CONFIG_SECTION_IDS)[number], ConfigSectionId>>().toEqualTypeOf<never>()
  expectTypeOf<Listed>().toEqualTypeOf<Expected>()
  expectTypeOf<keyof typeof CONFIG_SECTIONS>().toEqualTypeOf<ConfigTab>()
  expectTypeOf<keyof typeof CONFIG_SECTION_ALIASES>().toEqualTypeOf<ConfigSectionId>()
})

test('LEGACY-LINKS-TOTAL: the map is keyed by exactly the 21 pairs', () => {
  type Expected =
    | 'workspace:discovery'
    | 'workspace:files'
    | 'knowledge:store'
    | 'services:dashboard'
    | 'services:cache'
    | 'services:auth-states'
    | 'services:logging'
    | 'services:recording'
    | 'services:accessibility'
    | 'services:vision'
    | 'registry:llms'
    | 'registry:targets'
    | 'registry:devices'
    | 'use:browser'
    | 'use:timeouts'
    | 'use:planner'
    | 'use:log-capture'
    | 'use:mobile'
    | 'use:execution-defaults'
    | 'analytics:pass-rate-scope'
  expectTypeOf<LegacyConfigPair>().toEqualTypeOf<Expected>()
  expectTypeOf<(typeof LEGACY_CONFIG_PAIRS)[number]>().toEqualTypeOf<Expected>()
  expectTypeOf<keyof typeof LEGACY_CONFIG_LINKS>().toEqualTypeOf<LegacyConfigPair>()
  expectTypeOf<ReturnType<typeof resolveLegacyConfigLink>>().toEqualTypeOf<
    { kind: 'none' } | { kind: 'mapped'; tab: ConfigTab; section: ConfigSectionId } | { kind: 'unknown' }
  >()
})

test('C429-SAVE-STATES-EXACT', () => {
  type Expected = 'idle' | 'saving' | 'saved' | 'draft' | 'failed' | 'undo'
  expectTypeOf<SaveState>().toEqualTypeOf<Expected>()
  expectTypeOf<(typeof SAVE_STATES)[number]>().toEqualTypeOf<Expected>()
  expectTypeOf<Exclude<SaveState, (typeof SAVE_STATES)[number]>>().toEqualTypeOf<never>()
  expectTypeOf<Exclude<(typeof SAVE_STATES)[number], SaveState>>().toEqualTypeOf<never>()
})

test('C429-FIELD-STATES-EXACT', () => {
  type Expected = 'clean' | 'draft' | 'saving' | 'failed'
  expectTypeOf<FieldState>().toEqualTypeOf<Expected>()
  expectTypeOf<(typeof FIELD_STATES)[number]>().toEqualTypeOf<Expected>()
  expectTypeOf<Exclude<FieldState, (typeof FIELD_STATES)[number]>>().toEqualTypeOf<never>()
  expectTypeOf<Exclude<(typeof FIELD_STATES)[number], FieldState>>().toEqualTypeOf<never>()
})

test('C429-CONNECTION-CHOICES-EXACT', () => {
  type Expected =
    | 'chatgpt-sign-in'
    | 'claude-sign-in'
    | 'openai-compatible-key'
    | 'anthropic-compatible-key'
    | 'gemini-key'
  expectTypeOf<ConnectionChoice>().toEqualTypeOf<Expected>()
  expectTypeOf<(typeof CONNECTION_CHOICES)[number]>().toEqualTypeOf<Expected>()
  expectTypeOf<Exclude<ConnectionChoice, (typeof CONNECTION_CHOICES)[number]>>().toEqualTypeOf<never>()
  expectTypeOf<Exclude<(typeof CONNECTION_CHOICES)[number], ConnectionChoice>>().toEqualTypeOf<never>()
  expectTypeOf<keyof typeof CONNECTION_CHOICE_PROVIDERS>().toEqualTypeOf<ConnectionChoice>()
})

test('C429-MODEL-STATUSES-EXACT', () => {
  type Expected = 'signed-in' | 'key-saved' | 'not-connected' | 'sign-in-expired'
  expectTypeOf<ModelStatus>().toEqualTypeOf<Expected>()
  expectTypeOf<(typeof MODEL_STATUSES)[number]>().toEqualTypeOf<Expected>()
  expectTypeOf<Exclude<ModelStatus, (typeof MODEL_STATUSES)[number]>>().toEqualTypeOf<never>()
  expectTypeOf<Exclude<(typeof MODEL_STATUSES)[number], ModelStatus>>().toEqualTypeOf<never>()
})

test('C429-TEST-RESULTS-EXACT', () => {
  type Expected = 'testing' | 'connected' | 'connected-without-key' | 'failed'
  expectTypeOf<TestResult>().toEqualTypeOf<Expected>()
  expectTypeOf<(typeof TEST_RESULTS)[number]>().toEqualTypeOf<Expected>()
  expectTypeOf<Exclude<TestResult, (typeof TEST_RESULTS)[number]>>().toEqualTypeOf<never>()
  expectTypeOf<Exclude<(typeof TEST_RESULTS)[number], TestResult>>().toEqualTypeOf<never>()
})

test('C429-EXPLICIT-ACTION-KINDS-EXACT', () => {
  type Expected =
    | 'delete-model'
    | 'delete-target'
    | 'delete-device'
    | 'sign-out'
    | 'remove-key'
    | 'change-knowledge-dir'
    | 'change-db-path'
    | 'change-artifacts-dir'
  expectTypeOf<ExplicitActionKind>().toEqualTypeOf<Expected>()
  expectTypeOf<(typeof EXPLICIT_ACTION_KINDS)[number]>().toEqualTypeOf<Expected>()
  expectTypeOf<Exclude<ExplicitActionKind, (typeof EXPLICIT_ACTION_KINDS)[number]>>().toEqualTypeOf<never>()
  expectTypeOf<Exclude<(typeof EXPLICIT_ACTION_KINDS)[number], ExplicitActionKind>>().toEqualTypeOf<never>()
})
