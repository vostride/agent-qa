import { describe, expect, it } from 'vitest'

import {
  CONFIG_NAVIGATION_ITEMS,
  DEFAULT_CONFIG_SELECTION,
  getConfigCommandLabel,
  normalizeConfigSelection,
  searchConfigNavigationItems,
} from '@/lib/config-navigation'

describe('config navigation inventory', () => {
  it('contains every UI-SPEC config destination', () => {
    expect(CONFIG_NAVIGATION_ITEMS.map((item) => `${item.bucket}:${item.item}`)).toEqual([
      'workspace:discovery',
      'workspace:files',
      'workspace:agent-rules',
      'services:dashboard',
      'services:cache',
      'services:auth-states',
      'services:logging',
      'services:recording',
      'services:accessibility',
      'services:memory',
      'registry:llms',
      'registry:targets',
      'registry:devices',
      'registry:providers',
      'use:browser',
      'use:timeouts',
      'use:healing',
      'use:planner',
      'use:log-capture',
      'use:mobile',
      'use:execution-defaults',
      'analytics:pass-rate-scope',
    ])
  })

  it('normalizes missing selection to the default config destination', () => {
    expect(normalizeConfigSelection(new URLSearchParams())).toEqual(DEFAULT_CONFIG_SELECTION)
  })

  it('normalizes invalid selection to the nearest valid destination', () => {
    expect(normalizeConfigSelection(new URLSearchParams('bucket=workspace&item=bogus'))).toEqual({
      bucket: 'workspace',
      item: 'discovery',
    })

    expect(normalizeConfigSelection(new URLSearchParams('bucket=bogus&item=bogus'))).toEqual(DEFAULT_CONFIG_SELECTION)
  })

  it('finds config destinations by label and alias', () => {
    expect(searchConfigNavigationItems('targets').map((item) => item.item)).toContain('targets')
    expect(searchConfigNavigationItems('env file').map((item) => item.item)).toContain('files')
    expect(searchConfigNavigationItems('log capture').map((item) => item.item)).toContain('log-capture')
    expect(searchConfigNavigationItems('reset app data').map((item) => item.item)).toContain('mobile')
    expect(searchConfigNavigationItems('pass rate').map((item) => item.item)).toContain('pass-rate-scope')
    expect(searchConfigNavigationItems('saved auth').map((item) => item.item)).toContain('auth-states')
    expect(searchConfigNavigationItems('browser headless').map((item) => item.item)).toEqual(['browser'])
  })

  it('keeps browser-scoped headless in the Browser destination only', () => {
    const browserItem = CONFIG_NAVIGATION_ITEMS.find(
      (item) => item.bucket === 'use' && item.item === 'browser',
    )
    const defaultsItem = CONFIG_NAVIGATION_ITEMS.find(
      (item) => item.bucket === 'use' && item.item === 'execution-defaults',
    )

    expect(browserItem?.fieldPaths).toContain('use.browser.headless')
    expect(defaultsItem?.fieldPaths).not.toContain('use.headless')
    expect(defaultsItem?.fieldPaths).not.toContain('use.browser.headless')
    expect(defaultsItem?.fieldPaths).not.toContain('use.device')
  })

  it('indexes audited services runtime path fields', () => {
    const dashboardItem = CONFIG_NAVIGATION_ITEMS.find((item) => item.bucket === 'services' && item.item === 'dashboard')
    const cacheItem = CONFIG_NAVIGATION_ITEMS.find((item) => item.bucket === 'services' && item.item === 'cache')
    const authStatesItem = CONFIG_NAVIGATION_ITEMS.find((item) => item.bucket === 'services' && item.item === 'auth-states')
    const memoryItem = CONFIG_NAVIGATION_ITEMS.find((item) => item.bucket === 'services' && item.item === 'memory')

    expect(dashboardItem?.fieldPaths).toEqual(expect.arrayContaining([
      'services.dashboard',
      'services.dashboard.dbPath',
      'services.dashboard.artifactsDir',
    ]))
    expect(cacheItem?.fieldPaths).toEqual(expect.arrayContaining([
      'services.cache',
      'services.cache.dir',
      'services.cache.ttl',
    ]))
    expect(authStatesItem?.fieldPaths).toEqual(expect.arrayContaining([
      'services.authState',
      'services.authState.dir',
    ]))
    expect(memoryItem?.fieldPaths).toEqual(expect.arrayContaining([
      'services.memory',
      'services.memory.dir',
      'services.memory.provider',
      'services.memory.curatorEnabled',
    ]))
    expect(searchConfigNavigationItems('memory directory').map((item) => item.item)).toEqual(['memory'])
  })

  it('formats the shared command label contract', () => {
    const targetItem = CONFIG_NAVIGATION_ITEMS.find((item) => item.bucket === 'registry' && item.item === 'targets')
    expect(targetItem).toBeDefined()
    expect(getConfigCommandLabel(targetItem!)).toBe('Config: Registry / Targets')
  })
})
