import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { generateSuiteId, generateTestId } from '@vostride/agent-qa-ids'
import { afterAll, describe, expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'

import { selectSuitePlace, selectWebPlace } from '../../remote/select-place.js'
import { AgentQaConfigSchema } from '../../schema/config-schema.js'
import { RemoteEntrySchema } from '../../schema/remote-schema.js'
import type { AgentQaConfig } from '../../types/config.js'
import { resolveWorkspacePaths } from '../../workspace/workspace-paths.js'
import { validateProject, type ValidationDiagnostic } from '../validate.js'

const projects: string[] = []
afterAll(() => {
  for (const project of projects.splice(0)) rmSync(project, { recursive: true, force: true })
})

const remoteEntries = [
  { name: 'grid', protocol: 'playwright', url: 'ws://127.0.0.1:3000/' },
  { name: 'devtools', protocol: 'cdp', url: 'http://127.0.0.1:9222' },
]
const remotes = remoteEntries.map((entry) => RemoteEntrySchema.parse(entry))

function configYaml(configPick?: string): string {
  return [
    'workspace:',
    '  testMatch:',
    "    - 'tests/**/*.yaml'",
    '  suiteMatch:',
    "    - 'suites/**/*.suite.yaml'",
    '  hooksFile: hooks.yaml',
    '  envFile: .env',
    '  secretsFile: .env.secrets.local',
    'registry:',
    '  targets:',
    '    shop:',
    '      platform: web',
    '      url: http://127.0.0.1:8080',
    '  remotes:',
    ...remoteEntries.flatMap((entry) => [
      `    - name: ${entry.name}`,
      `      protocol: ${entry.protocol}`,
      `      url: ${JSON.stringify(entry.url)}`,
    ]),
    ...(configPick === undefined
      ? []
      : [
          'use:',
          '  browser:',
          '    name: chromium',
          '    headless: true',
          `    remote: ${configPick}`,
        ]),
    '',
  ].join('\n')
}

function browserUse(browser: { remote?: string; name?: string }): string[] {
  if (browser.remote === undefined && browser.name === undefined) return []
  return [
    'use:',
    '  browser:',
    ...(browser.name === undefined ? [] : [`    name: ${browser.name}`]),
    ...(browser.remote === undefined ? [] : [`    remote: ${browser.remote}`]),
  ]
}

function testYaml(id: string, browser: { remote?: string; name?: string } = {}): string {
  return [
    `test-id: ${id}`,
    'name: a checkout test',
    'target: shop',
    ...browserUse(browser),
    'steps:',
    '  - Verify the page says "Example"',
    '',
  ].join('\n')
}

function suiteYaml(entries: readonly { test: string; id: string }[], remote?: string): string {
  return [
    `suite-id: ${generateSuiteId()}`,
    'name: checkout',
    'target: shop',
    ...browserUse({ remote }),
    'tests:',
    ...entries.flatMap((entry) => [`  - test: ${entry.test}`, `    id: ${entry.id}`]),
    '',
  ].join('\n')
}

interface Project {
  dir: string
  configPath: string
  file(relative: string): string
  validate(files?: string[]): Promise<ValidationDiagnostic[]>
}

function project(configPick: string | undefined, files: Record<string, string>): Project {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'remote-picks-')))
  projects.push(dir)
  mkdirSync(path.join(dir, 'tests'))
  mkdirSync(path.join(dir, 'suites'))
  const configPath = path.join(dir, 'agent-qa.config.yaml')
  writeFileSync(configPath, configYaml(configPick))
  writeFileSync(path.join(dir, 'hooks.yaml'), 'hooks: []\n')
  writeFileSync(path.join(dir, '.env'), '')
  writeFileSync(path.join(dir, '.env.secrets.local'), '')
  for (const [relative, content] of Object.entries(files)) {
    writeFileSync(path.join(dir, relative), content)
  }
  const config = AgentQaConfigSchema.parse(parseYaml(configYaml(configPick))) as AgentQaConfig
  const workspace = resolveWorkspacePaths({ config, configPath })
  return {
    dir,
    configPath,
    file: (relative) => path.join(dir, relative),
    validate: async (only) => {
      const scope = only === undefined ? {} : { files: only }
      return (await validateProject({ configPath, workspace, ...scope })).diagnostics
    },
  }
}

function diagnostic(file: string, message: string): ValidationDiagnostic {
  return { file, line: 1, column: 1, message, severity: 'error' }
}

function refusal(result: ReturnType<typeof selectWebPlace>): string {
  if (!('refusal' in result)) throw new Error('the selector placed it')
  return result.refusal
}

describe('validateProject and remote picks', () => {
  it('reports an unknown pick in a test file on that file with the selector sentence', async () => {
    const p = project(undefined, {
      'tests/a.test.yaml': testYaml(generateTestId(), { remote: 'nope' }),
    })
    const message = refusal(selectWebPlace({ remotes, test: 'nope', file: 'tests/a.test.yaml' }))
    expect(message).toBe(
      'Unknown remote "nope" in tests/a.test.yaml. registry.remotes lists: grid, devtools.',
    )
    expect(await p.validate()).toEqual([diagnostic(p.file('tests/a.test.yaml'), message)])
  })

  it('reports an unknown pick in a suite file on the suite file', async () => {
    const id = generateTestId()
    const p = project(undefined, {
      'tests/a.test.yaml': testYaml(id),
      'suites/checkout.suite.yaml': suiteYaml([{ test: 'tests/a.test.yaml', id }], 'nope'),
    })
    const message = refusal(
      selectSuitePlace({
        remotes,
        suiteName: 'checkout',
        suiteFile: 'suites/checkout.suite.yaml',
        suite: 'nope',
        members: [{ file: 'tests/a.test.yaml' }],
      }),
    )
    expect(await p.validate()).toEqual([diagnostic(p.file('suites/checkout.suite.yaml'), message)])
  })

  it('reports a suite whose members disagree, naming members by config-relative path', async () => {
    const a = generateTestId()
    const b = generateTestId()
    const p = project(undefined, {
      'tests/a.test.yaml': testYaml(a, { remote: 'grid' }),
      'tests/b.test.yaml': testYaml(b),
      'suites/checkout.suite.yaml': suiteYaml([
        { test: './tests/a.test.yaml', id: a },
        { test: 'tests/b.test.yaml', id: b },
      ]),
    })
    const message = refusal(
      selectSuitePlace({
        remotes,
        suiteName: 'checkout',
        suiteFile: 'suites/checkout.suite.yaml',
        members: [{ file: 'tests/a.test.yaml', pick: 'grid' }, { file: 'tests/b.test.yaml' }],
      }),
    )
    expect(message).toBe(
      'Suite checkout runs its tests in one place, but tests/a.test.yaml picks grid and ' +
        'tests/b.test.yaml picks local. ' +
        'Set use.browser.remote in the suite or make the tests agree.',
    )
    expect(await p.validate()).toEqual([diagnostic(p.file('suites/checkout.suite.yaml'), message)])
  })

  it('reads the members of a suite validated alone from disk', async () => {
    const a = generateTestId()
    const b = generateTestId()
    const p = project('grid', {
      'tests/a.test.yaml': testYaml(a),
      'tests/b.test.yaml': testYaml(b, { remote: 'local' }),
      'suites/checkout.suite.yaml': suiteYaml([
        { test: 'tests/a.test.yaml', id: a },
        { test: 'tests/b.test.yaml', id: b },
      ]),
    })
    const message = refusal(
      selectSuitePlace({
        remotes,
        suiteName: 'checkout',
        suiteFile: 'suites/checkout.suite.yaml',
        config: 'grid',
        members: [{ file: 'tests/a.test.yaml' }, { file: 'tests/b.test.yaml', pick: 'local' }],
      }),
    )
    expect(await p.validate([p.file('suites/checkout.suite.yaml')])).toEqual([
      diagnostic(p.file('suites/checkout.suite.yaml'), message),
    ])
  })

  it('reports a cdp remote asked for firefox on the test file', async () => {
    const p = project(undefined, {
      'tests/a.test.yaml': testYaml(generateTestId(), { remote: 'devtools', name: 'firefox' }),
    })
    const message = refusal(
      selectWebPlace({ remotes, test: 'devtools', file: 'tests/a.test.yaml', engine: 'firefox' }),
    )
    expect(message).toBe('Remote devtools serves Chromium only; this test asks for firefox.')
    expect(await p.validate()).toEqual([diagnostic(p.file('tests/a.test.yaml'), message)])
  })

  it('reports nothing for picks every level can honour', async () => {
    const a = generateTestId()
    const b = generateTestId()
    const c = generateTestId()
    const p = project('grid', {
      'tests/a.test.yaml': testYaml(a, { remote: 'devtools', name: 'chromium' }),
      'tests/b.test.yaml': testYaml(b, { remote: 'local', name: 'firefox' }),
      'tests/c.test.yaml': testYaml(c, { name: 'webkit' }),
      'suites/checkout.suite.yaml': suiteYaml(
        [
          { test: 'tests/a.test.yaml', id: a },
          { test: 'tests/b.test.yaml', id: b },
        ],
        'grid',
      ),
      'suites/agreeing.suite.yaml': suiteYaml([{ test: 'tests/c.test.yaml', id: c }]),
    })
    expect(await p.validate()).toEqual([])
  })
})
