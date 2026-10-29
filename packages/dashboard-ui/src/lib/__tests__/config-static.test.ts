import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

// Source-level cells for the Config page's deletions and house rules.
const srcRoot = new URL('../../', import.meta.url)
const CONFIG_MANAGER_DIR = 'components/config-manager/'
const CONFIG_PAGE = 'pages/config.tsx'
const CONFIG_TABS_COMPONENT = `${CONFIG_MANAGER_DIR}config-tabs.tsx`
const CONFIG_COPY_SOURCES = ['lib/config-tabs.ts', 'lib/config-copy.ts', 'lib/product-tour-steps.ts'] as const

function listSources(relativeDir: string): string[] {
  const files: string[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(new URL(dir, srcRoot))) {
      if (entry === '__tests__') continue
      const child = `${dir}${entry}`
      if (statSync(new URL(child, srcRoot)).isDirectory()) {
        walk(`${child}/`)
      } else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.(ts|tsx)$/.test(entry)) {
        files.push(child)
      }
    }
  }
  walk(relativeDir)
  return files.sort()
}

function read(relativePath: string): string {
  return readFileSync(new URL(relativePath, srcRoot), 'utf-8')
}

const configSources = new Map<string, string>(
  [...listSources(CONFIG_MANAGER_DIR), CONFIG_PAGE].map((file) => [file, read(file)]),
)
const copySources = new Map<string, string>([
  ...configSources,
  ...CONFIG_COPY_SOURCES.map((file) => [file, read(file)] as const),
])

function offenders(sources: Map<string, string>, test: (source: string) => boolean): string[] {
  return [...sources].filter(([, source]) => test(source)).map(([file]) => file)
}

const DIALOG_IMPORT = /from\s+["'](?:[^"']*\/ui\/(?:dialog|alert-dialog|sheet)|@radix-ui\/react-(?:dialog|alert-dialog))["']/
const SONNER_IMPORT = /from\s+["']sonner["']/
const TOAST_CALL = /\btoast\s*(?:\.\s*\w+\s*)?\(/
const SELECT_IMPORT = /from\s+["'][^"']*\/ui\/select["']/

const REMOVED_SAVE_LABELS = ['Save Changes', 'Save Runtime Defaults', 'Save Credential'] as const

const REMOVED_COPY = [
  'Save Changes',
  'Save Runtime Defaults',
  'Save Credential',
  'Configuration saved',
  'Runtime defaults saved',
  'Failed to save configuration',
  'Connection successful',
  'Add Configuration',
  'Edit ${',
  'Delete Configuration',
  'LLM Configurations',
  'Choose the active default in Use / Execution Defaults.',
  'Select Setting',
  'Setting not found.',
  'Manage workspace, services, registry, and runtime defaults.',
  'save the config',
  'No targets configured.',
  'No devices configured.',
  'No providers configured.',
  'No auth states saved',
  'Save auth state from a connected web Live Mode session.',
  'Loading auth states...',
  'Could not load saved auth states.',
] as const

describe('Config static cells', () => {
  it('reads every Config source file (witness)', () => {
    expect(configSources.size).toBeGreaterThan(20)
    expect(configSources.has(CONFIG_PAGE)).toBe(true)
    expect(configSources.has(CONFIG_TABS_COMPONENT)).toBe(true)
    expect(copySources.size).toBe(configSources.size + CONFIG_COPY_SOURCES.length)
  })

  it('EXECUTION-DEFAULTS-GONE: the separate execution-defaults destination does not exist', () => {
    expect(existsSync(new URL(`${CONFIG_MANAGER_DIR}execution-defaults-section.tsx`, srcRoot))).toBe(false)
    const importers = offenders(
      new Map(listSources('').map((file) => [file, read(file)])),
      (source) => /execution-defaults-section|ExecutionDefaultsSection/.test(source),
    )
    expect(importers, `EXECUTION-DEFAULTS-GONE: ${importers.join(', ')}`).toEqual([])
  })

  it('CONFIG-NAVIGATION-GONE: the bucket navigation map does not exist', () => {
    expect(existsSync(new URL('lib/config-navigation.ts', srcRoot))).toBe(false)
    const importers = offenders(
      new Map(listSources('').map((file) => [file, read(file)])),
      (source) => /["'][^"']*config-navigation["']/.test(source),
    )
    expect(importers, `CONFIG-NAVIGATION-GONE: ${importers.join(', ')}`).toEqual([])
  })

  it('NO-DIALOG-IN-CONFIG-SOURCE: no Config source imports a dialog, alert-dialog or sheet or writes aria-modal', () => {
    const found = offenders(configSources, (source) => DIALOG_IMPORT.test(source) || source.includes('aria-modal'))
    expect(found, `NO-DIALOG-IN-CONFIG-SOURCE: ${found.join(', ')}`).toEqual([])
  })

  it('NO-TOAST-IN-CONFIG-SOURCE: no Config source imports sonner or calls toast', () => {
    const found = offenders(configSources, (source) => SONNER_IMPORT.test(source) || TOAST_CALL.test(source))
    expect(found, `NO-TOAST-IN-CONFIG-SOURCE: ${found.join(', ')}`).toEqual([])
  })

  it('NO-SAVE-BUTTON-IN-CONFIG-SOURCE: no Config source renders a removed save label', () => {
    for (const label of REMOVED_SAVE_LABELS) {
      const found = offenders(configSources, (source) => source.includes(label))
      expect(found, `NO-SAVE-BUTTON-IN-CONFIG-SOURCE "${label}": ${found.join(', ')}`).toEqual([])
    }
  })

  it('NO-RAIL-SOURCE: no Config source renders the rail or the mobile selector', () => {
    const found = offenders(
      configSources,
      (source) => /data-config-rail|data-config-mobile-selector|ConfigBucketNav/.test(source),
    )
    expect(found, `NO-RAIL-SOURCE: ${found.join(', ')}`).toEqual([])
  })

  it('NO-NAV-SELECT-SOURCE: the page and the tab strip import no Select and render no select', () => {
    const navSources = new Map([CONFIG_PAGE, CONFIG_TABS_COMPONENT].map((file) => [file, configSources.get(file)!]))
    const found = offenders(
      navSources,
      (source) => SELECT_IMPORT.test(source) || /<Select\b|<select\b/.test(source),
    )
    expect(found, `NO-NAV-SELECT-SOURCE: ${found.join(', ')}`).toEqual([])
  })

  it('NO-PATH-BADGES-SOURCE: no Config source renders fieldPaths badges', () => {
    const found = offenders(configSources, (source) => /\bfieldPaths\b/.test(source))
    expect(found, `NO-PATH-BADGES-SOURCE: ${found.join(', ')}`).toEqual([])
  })

  it('REMOVED-COPY-ABSENT: every string in the removed-copy list is absent from every Config source', () => {
    for (const text of REMOVED_COPY) {
      const found = offenders(copySources, (source) => source.includes(text))
      expect(found, `REMOVED-COPY-ABSENT "${text}": ${found.join(', ')}`).toEqual([])
    }
  })
})
