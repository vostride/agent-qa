import { describe, expect, it } from 'vitest'

import { CONFIG_SECTION_LABELS, configCommandLabel } from '@/lib/config-copy'
import {
  CONFIG_SECTION_ALIASES,
  CONFIG_TABS,
  LEGACY_CONFIG_PAIRS,
  resolveConfigTab,
  resolveLegacyConfigLink,
  searchConfigSections,
} from '@/lib/config-tabs'

function sectionsFor(query: string): string[] {
  return searchConfigSections(query).map((entry) => entry.section)
}

describe('config navigation inventory', () => {
  it('contains every UI-SPEC config destination', () => {
    expect([...LEGACY_CONFIG_PAIRS]).toEqual([
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
      'use:browser',
      'use:timeouts',
      'use:planner',
      'use:log-capture',
      'use:mobile',
      'use:execution-defaults',
      'analytics:pass-rate-scope',
    ])
  })

  it('normalizes missing selection to the default config destination', () => {
    expect(resolveLegacyConfigLink(new URLSearchParams())).toEqual({ kind: 'none' })
    expect(CONFIG_TABS[0]).toBe('models')
  })

  it('normalizes invalid selection to the nearest valid destination', () => {
    expect(resolveLegacyConfigLink(new URLSearchParams('bucket=workspace&item=bogus'))).toEqual({
      kind: 'unknown',
    })
    expect(resolveLegacyConfigLink(new URLSearchParams('bucket=bogus&item=bogus'))).toEqual({
      kind: 'unknown',
    })
    expect(resolveConfigTab('bogus')).toBeUndefined()
  })

  it('finds config destinations by label and alias', () => {
    expect(sectionsFor('targets')).toContain('targets')
    expect(sectionsFor('env file')).toContain('files')
    expect(sectionsFor('log capture')).toContain('log-capture')
    expect(sectionsFor('reset app data')).toContain('mobile-app-state')
    expect(sectionsFor('pass rate')).toContain('pass-rate-scope')
    expect(sectionsFor('saved auth')).toContain('login-states')
    expect(sectionsFor('browser headless')).toEqual(['browser'])
  })

  it('keeps browser-scoped headless in the Browser destination only', () => {
    expect(sectionsFor('headless')).toEqual(['browser'])
    expect(CONFIG_SECTION_ALIASES.models).not.toContain('headless')
    expect(CONFIG_SECTION_ALIASES.models).not.toContain('device')
  })

  it('finds the runtime storage sections by their words, never by a dotted path', () => {
    expect(sectionsFor('db path')).toEqual(['dashboard'])
    expect(sectionsFor('artifacts dir')).toEqual(['dashboard'])
    expect(sectionsFor('cache dir')).toEqual(['cache'])
    expect(sectionsFor('saved auth')).toEqual(['login-states'])
    expect(sectionsFor('commit artifacts')).toEqual(['knowledge'])
    expect(sectionsFor('context budget')).toEqual(['knowledge'])
    expect(sectionsFor('knowledge dir')).toEqual(['knowledge'])
    expect(sectionsFor('screenshot size')).toEqual(['screenshot-size'])
    for (const dotted of [
      'services.dashboard.dbPath',
      'services.authState.dir',
      'knowledge.dir',
      'services.vision.screenshotSize',
    ]) {
      expect(sectionsFor(dotted), dotted).toEqual([])
    }
  })

  it('formats the shared command label contract', () => {
    expect(CONFIG_SECTION_LABELS.targets).toBe('Targets')
    expect(configCommandLabel('targets', 'targets')).toBe('Config: Targets / Targets')
  })
})
