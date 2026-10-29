import { readFileSync, readdirSync } from 'node:fs'
import { join as joinPath, resolve as resolvePath, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, it, expect } from 'vitest'

import { CONFIG_SECTIONS, CONFIG_TABS, LEGACY_CONFIG_LINKS, LEGACY_CONFIG_PAIRS } from '@/lib/config-tabs'
import { routes } from '@/lib/routes'

describe('canonical dashboard routes', () => {
  it('encodes raw run-detail IDs as exactly one segment, preserving canonical IDs', () => {
    expect(routes.runDetail('r_canonical-run')).toBe('/runs/r_canonical-run')
    for (const raw of ['a/b', 'a?b', 'a#b', 'a%b', 'a b', 'a%2Fb']) {
      const href = routes.runDetail(raw)
      expect(href).toBe(`/runs/${encodeURIComponent(raw)}`)
      const url = new URL(href, 'https://dashboard.test')
      expect(url.pathname.split('/')).toHaveLength(3)
      expect(decodeURIComponent(url.pathname.slice('/runs/'.length))).toBe(raw)
      expect(url.search).toBe('')
      expect(url.hash).toBe('')
    }
  })
  it('keeps only the live top-level helpers', () => {
    expect(routes.runs).toBe('/runs')
    expect(routes.tests).toBe('/tests')
    expect(routes.testNew).toBe('/tests/new')
    expect(routes.hooks).toBe('/hooks')
    expect(routes.hookNew).toBe('/hooks/new')
    expect(routes.insights).toBe('/insights')
    expect(routes.config).toBe('/config')
  })

  it('does not expose stale analytics/trends helpers', () => {
    expect('analytics' in routes).toBe(false)
    expect('trends' in routes).toBe(false)
  })

  it('does not expose retired memory routes', () => {
    expect('memory' in routes).toBe(false)
    expect('memoryProduct' in routes).toBe(false)
  })
})

describe('hook route helpers', () => {
  it('hookView returns /hook/:id (singular)', () => {
    expect(routes.hookView('h_foo-bar')).toBe('/hook/h_foo-bar')
  })

  it('hookEdit returns /hook/:id/edit', () => {
    expect(routes.hookEdit('h_foo-bar')).toBe('/hook/h_foo-bar/edit')
  })

  it('hooks list remains plural and hookNew unchanged', () => {
    expect(routes.hooks).toBe('/hooks')
    expect(routes.hookNew).toBe('/hooks/new')
  })
})

describe('suite route helpers', () => {
  it('suiteView returns /suite/:suite-id (singular)', () => {
    expect(routes.suiteView('s_foo-bar')).toBe('/suite/s_foo-bar')
  })
  it('suiteEdit returns /suite/:suite-id/edit', () => {
    expect(routes.suiteEdit('s_foo-bar')).toBe('/suite/s_foo-bar/edit')
  })
  it('suites list remains plural and suiteNew unchanged', () => {
    expect(routes.suites).toBe('/suites')
    expect(routes.suiteNew).toBe('/suites/new')
  })
  it('does not percent-encode opaque suite ids', () => {
    expect(routes.suiteView('s_abc-def')).not.toContain('%')
  })
})

describe('config route helpers', () => {
  it('CONFIG-ITEM-ALIAS: configItem returns the mapped tab URL for a legacy pair, and Models otherwise', () => {
    expect(routes.configItem('registry', 'llms')).toBe('/config/models?section=models')
    expect(routes.configItem('registry', 'targets')).toBe('/config/targets?section=targets')
    expect(routes.configItem('use', 'execution-defaults')).toBe('/config/models?section=models')
    expect(routes.configItem('registry', 'unknown')).toBe('/config/models')
    expect(routes.configItem('nope', 'llms')).toBe('/config/models')
    for (const pair of LEGACY_CONFIG_PAIRS) {
      const [bucket, item] = pair.split(':')
      const { tab, section } = LEGACY_CONFIG_LINKS[pair]
      expect(routes.configItem(bucket, item)).toBe(`/config/${tab}?section=${section}`)
    }
  })

  it('CONFIG-TAB-PATH: configTab builds /config/{tab} with an optional section', () => {
    expect(routes.configTab('models')).toBe('/config/models')
    expect(routes.configTab('advanced')).toBe('/config/advanced')
    expect(routes.configTab('execution', 'timeouts')).toBe('/config/execution?section=timeouts')
    for (const tab of CONFIG_TABS) {
      expect(routes.configTab(tab)).toBe(`/config/${tab}`)
      for (const section of CONFIG_SECTIONS[tab]) {
        expect(routes.configTab(tab, section)).toBe(`/config/${tab}?section=${section}`)
      }
    }
    expect(routes.config).toBe('/config')
  })
})

// The run id is encoded and the sha is not: the store validates it, and encoding hides a bad one.

describe('artifact route helper', () => {
  const SHA = 'a'.repeat(64)

  it('mints /api/runs/<encoded runId>/artifacts/<sha>', () => {
    expect(routes.runArtifact('r 1', SHA)).toBe(`/api/runs/r%201/artifacts/${SHA}`)
  })

  it('passes the sha through verbatim — never encoded, never re-cased', () => {
    const mixed = `${'A'.repeat(32)}${'f'.repeat(32)}`
    const href = routes.runArtifact('run_1', mixed)

    expect(href).toBe(`/api/runs/run_1/artifacts/${mixed}`)
    expect(href.endsWith(mixed)).toBe(true)
  })

  it('is the only artifact-href minter in the UI source tree', () => {
    // Concatenated so this assertion cannot satisfy the inventory by matching itself.
    const needle = '/artifacts' + '/'
    const srcRoot = resolvePath(fileURLToPath(new URL('../../', import.meta.url)))

    const offenders: string[] = []
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = joinPath(dir, entry.name)
        if (entry.isDirectory()) {
          if (entry.name === '__tests__' || entry.name === 'node_modules') continue
          walk(full)
          continue
        }
        if (!/\.tsx?$/.test(entry.name)) continue
        if (full.endsWith(`${sep}lib${sep}routes.ts`)) continue
        if (/\.test\.tsx?$/.test(entry.name)) continue
        if (readFileSync(full, 'utf8').includes(needle)) offenders.push(full.slice(srcRoot.length))
      }
    }
    walk(srcRoot)

    expect(offenders).toEqual([])
  })
})
