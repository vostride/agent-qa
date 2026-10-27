// THE CONFIG PAGE'S CLOSED VOCABULARY (429 D-02/D-03/D-04 · PXH-CONF-01).
//
// Five tabs, their sections in order, the total map from the 21 live legacy `bucket:item` links,
// the resolver the page, the palette and the tour share, and every UI closed set. The type
// twins of the C429-*-EXACT cells are in config-tabs.test-d.ts.

import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

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
  configTabPath,
  resolveConfigTab,
  resolveLegacyConfigLink,
  searchConfigSections,
} from '../config-tabs'

const sectionsOf = (query: string) => searchConfigSections(query).map((entry) => entry.section)

describe('the tabs and their sections (429-12 Task 1)', () => {
  it('C429-CONFIG-TABS-EXACT: five tabs in the owner-locked order', () => {
    expect(CONFIG_TABS).toEqual(['models', 'targets', 'execution', 'project', 'advanced'])
  })

  it('C429-CONFIG-SECTIONS-EXACT: each tab lists its sections in the UI-SPEC S2 order', () => {
    expect(CONFIG_SECTIONS).toEqual({
      models: ['models', 'screenshot-size', 'planner-limits'],
      targets: ['targets', 'devices', 'device-farms', 'login-states', 'mobile-app-state'],
      execution: ['browser', 'timeouts', 'runs', 'cache', 'recording', 'accessibility', 'log-capture'],
      project: ['test-discovery', 'files', 'knowledge', 'dashboard', 'logging', 'pass-rate-scope'],
      advanced: ['mcp', 'config-file'],
    })
    expect(Object.keys(CONFIG_SECTIONS)).toEqual([...CONFIG_TABS])
    expect(CONFIG_SECTION_IDS).toEqual(CONFIG_TABS.flatMap((tab) => CONFIG_SECTIONS[tab]))
    expect(new Set(CONFIG_SECTION_IDS).size).toBe(CONFIG_SECTION_IDS.length)
  })

  it('the palette aliases carry no storage vocabulary: no bucket word and no dotted path', () => {
    expect(Object.keys(CONFIG_SECTION_ALIASES)).toEqual([...CONFIG_SECTION_IDS])
    const storageWords = ['bucket', 'workspace', 'services', 'registry', 'use', 'analytics']
    for (const aliases of Object.values(CONFIG_SECTION_ALIASES)) {
      for (const alias of aliases) {
        expect(alias).toBe(alias.toLowerCase())
        expect(alias).not.toContain('.')
        expect(storageWords).not.toContain(alias)
      }
    }
  })
})

describe('the legacy links (429-12 Task 1)', () => {
  it('LEGACY-LINKS-TOTAL: the 21 live pairs each map to exactly one tab and section', () => {
    expect(LEGACY_CONFIG_PAIRS).toEqual([
      'workspace:discovery',
      'workspace:files',
      'knowledge:store',
      'services:dashboard',
      'services:cache',
      'services:auth-states',
      'services:logging',
      'services:recording',
      'services:accessibility',
      'services:vision',
      'registry:llms',
      'registry:targets',
      'registry:devices',
      'registry:providers',
      'use:browser',
      'use:timeouts',
      'use:planner',
      'use:log-capture',
      'use:mobile',
      'use:execution-defaults',
      'analytics:pass-rate-scope',
    ])
    expect(LEGACY_CONFIG_LINKS).toEqual({
      'registry:llms': { tab: 'models', section: 'models' },
      'use:execution-defaults': { tab: 'models', section: 'models' },
      'services:vision': { tab: 'models', section: 'screenshot-size' },
      'use:planner': { tab: 'models', section: 'planner-limits' },
      'registry:targets': { tab: 'targets', section: 'targets' },
      'registry:devices': { tab: 'targets', section: 'devices' },
      'registry:providers': { tab: 'targets', section: 'device-farms' },
      'services:auth-states': { tab: 'targets', section: 'login-states' },
      'use:mobile': { tab: 'targets', section: 'mobile-app-state' },
      'use:browser': { tab: 'execution', section: 'browser' },
      'use:timeouts': { tab: 'execution', section: 'timeouts' },
      'services:cache': { tab: 'execution', section: 'cache' },
      'services:recording': { tab: 'execution', section: 'recording' },
      'services:accessibility': { tab: 'execution', section: 'accessibility' },
      'use:log-capture': { tab: 'execution', section: 'log-capture' },
      'workspace:discovery': { tab: 'project', section: 'test-discovery' },
      'workspace:files': { tab: 'project', section: 'files' },
      'knowledge:store': { tab: 'project', section: 'knowledge' },
      'services:dashboard': { tab: 'project', section: 'dashboard' },
      'services:logging': { tab: 'project', section: 'logging' },
      'analytics:pass-rate-scope': { tab: 'project', section: 'pass-rate-scope' },
    })
    expect(Object.keys(LEGACY_CONFIG_LINKS).sort()).toEqual([...LEGACY_CONFIG_PAIRS].sort())

    for (const pair of LEGACY_CONFIG_PAIRS) {
      const { tab, section } = LEGACY_CONFIG_LINKS[pair]
      expect(CONFIG_SECTIONS[tab] as readonly string[]).toContain(section)
      const [bucket, item] = pair.split(':')
      expect(resolveLegacyConfigLink(new URLSearchParams({ bucket, item }))).toEqual({
        kind: 'mapped',
        tab,
        section,
      })
    }

    const sectionsHit = LEGACY_CONFIG_PAIRS.map((pair) => LEGACY_CONFIG_LINKS[pair].section)
    expect(sectionsHit.filter((section) => section === 'models')).toHaveLength(2)
    expect(new Set(sectionsHit).size).toBe(20)
  })

  it('LEGACY-LINK-EMPTY: no bucket parameter is no legacy link at all', () => {
    expect(resolveLegacyConfigLink(new URLSearchParams(''))).toEqual({ kind: 'none' })
    expect(resolveLegacyConfigLink(new URLSearchParams('section=timeouts'))).toEqual({ kind: 'none' })
  })

  it('LEGACY-LINK-UNKNOWN: an empty or unknown bucket or item resolves unknown', () => {
    for (const search of [
      'bucket=workspace&item=nope',
      'bucket=&item=',
      'bucket=safety&item=trust',
      'bucket=registry',
      'bucket=constructor&item=prototype',
      'bucket=registry:llms&item=',
    ]) {
      expect(resolveLegacyConfigLink(new URLSearchParams(search)), search).toEqual({ kind: 'unknown' })
    }
  })
})

describe('tab URLs and the section search (429-12 Task 1)', () => {
  it('builds the tab and section URLs and resolves only a known tab', () => {
    expect(configTabPath('models')).toBe('/config/models')
    expect(configTabPath('execution', 'timeouts')).toBe('/config/execution?section=timeouts')
    expect(resolveConfigTab('nope')).toBeUndefined()
    expect(resolveConfigTab(undefined)).toBeUndefined()
    expect(resolveConfigTab(null)).toBeUndefined()
    expect(resolveConfigTab('')).toBeUndefined()
    expect(resolveConfigTab('constructor')).toBeUndefined()
    for (const tab of CONFIG_TABS) expect(resolveConfigTab(tab)).toBe(tab)
  })

  it('SEARCH-ORDER-STABLE: matches come back in CONFIG_SECTIONS order', () => {
    expect(sectionsOf('')).toEqual([...CONFIG_SECTION_IDS])
    expect(sectionsOf('   ')).toEqual([...CONFIG_SECTION_IDS])
    expect(sectionsOf('time')).toEqual(['timeouts'])
    expect(sectionsOf('TIME')).toEqual(['timeouts'])
    expect(sectionsOf('device')).toEqual(['devices', 'device-farms'])
    // No section is about tokens any more.
    expect(sectionsOf('tokens')).toEqual([])
    for (const entry of searchConfigSections('')) {
      expect(CONFIG_SECTIONS[entry.tab] as readonly string[]).toContain(entry.section)
    }
  })

  it('finds each section by its label and by a re-homed alias', () => {
    expect(sectionsOf('screenshot size')).toEqual(['screenshot-size'])
    expect(sectionsOf('env file')).toEqual(['files'])
    expect(sectionsOf('saved login')).toEqual(['login-states'])
    expect(sectionsOf('reset app data')).toEqual(['mobile-app-state'])
    expect(sectionsOf('pass rate')).toEqual(['pass-rate-scope'])
    expect(sectionsOf('default model')).toEqual(['models'])
    expect(sectionsOf('parallel')).toEqual(['runs'])
    expect(sectionsOf('no such setting')).toEqual([])
  })

  it('config-tabs.ts reads nothing from the navigation map it replaces', () => {
    const source = readFileSync(new URL('../config-tabs.ts', import.meta.url), 'utf-8')
    const imports = source.match(/^import[\s\S]*?from '([^']+)'/gmu) ?? []
    expect(imports.length, 'the witness: the scan found the module imports').toBeGreaterThan(0)
    expect(source).not.toContain('config-navigation')
  })
})

describe('the UI closed sets (429-12 Task 1)', () => {
  it('C429-SAVE-STATES-EXACT', () => {
    expect(SAVE_STATES).toEqual(['idle', 'saving', 'saved', 'draft', 'failed', 'undo'])
  })

  it('C429-FIELD-STATES-EXACT', () => {
    expect(FIELD_STATES).toEqual(['clean', 'draft', 'saving', 'failed'])
  })

  it('C429-CONNECTION-CHOICES-EXACT: five choices, each naming its provider', () => {
    expect(CONNECTION_CHOICES).toEqual([
      'chatgpt-sign-in',
      'claude-sign-in',
      'openai-compatible-key',
      'anthropic-compatible-key',
      'gemini-key',
    ])
    expect(CONNECTION_CHOICE_PROVIDERS).toEqual({
      'chatgpt-sign-in': 'openai-subscription',
      'claude-sign-in': 'anthropic-subscription',
      'openai-compatible-key': 'openai-compatible',
      'anthropic-compatible-key': 'anthropic-compatible',
      'gemini-key': 'gemini',
    })
  })

  it('C429-MODEL-STATUSES-EXACT', () => {
    expect(MODEL_STATUSES).toEqual(['signed-in', 'key-saved', 'not-connected', 'sign-in-expired'])
  })

  it('C429-TEST-RESULTS-EXACT', () => {
    expect(TEST_RESULTS).toEqual(['testing', 'connected', 'connected-without-key', 'failed'])
  })

  // 432-22 (D-12): the two token deletes left with the token lists (eleven -> nine).
  it('C429-EXPLICIT-ACTION-KINDS-EXACT: the nine kinds of S6', () => {
    expect(EXPLICIT_ACTION_KINDS).toEqual([
      'delete-model',
      'delete-target',
      'delete-device',
      'delete-device-farm',
      'sign-out',
      'remove-key',
      'change-knowledge-dir',
      'change-db-path',
      'change-artifacts-dir',
    ])
  })
})
