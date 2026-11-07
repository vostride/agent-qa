// Which package.json entries init pins at the running version and which it leaves as declared.
import { describe, expect, it } from 'vitest'

import {
  planPackageJson,
  projectDependencies,
  type PackageJsonPlan,
} from '../commands/package-json-plan.js'
import { SUBSCRIPTION_AUTH_PACKAGE } from '../commands/scaffold-content.js'

const PATH = '/project/package.json'

function plan(manifest: Record<string, unknown>, version = '0.3.3'): PackageJsonPlan {
  return planPackageJson({
    path: PATH,
    text: `${JSON.stringify(manifest, null, 2)}\n`,
    folderName: 'project',
    dependencies: [{ name: 'agent-qa', version }],
  })
}

function written(result: PackageJsonPlan): Record<string, Record<string, string>> {
  return JSON.parse(result.content)
}

describe('package.json entries pin the running version', () => {
  it('a new entry goes in devDependencies', () => {
    const result = plan({ name: 'shop', dependencies: { react: '19.0.0' } })

    expect(written(result)).toEqual({
      name: 'shop',
      dependencies: { react: '19.0.0' },
      devDependencies: { 'agent-qa': '0.3.3' },
    })
    expect(result.entries).toEqual([
      { name: 'agent-qa', version: '0.3.3', spec: '0.3.3', block: 'devDependencies', outcome: 'added' },
    ])
  })

  it('an entry in dependencies stays there and is pinned', () => {
    const result = plan({ dependencies: { 'agent-qa': '^0.3.0', react: '19.0.0' } })

    expect(written(result)).toEqual({ dependencies: { 'agent-qa': '0.3.3', react: '19.0.0' } })
    expect(result.entries[0]).toMatchObject({ block: 'dependencies', outcome: 'pinned' })
  })

  it.each(['^0.3.0', 'latest', '0.2.6'])('%s becomes the running version', (spec) => {
    const result = plan({ devDependencies: { 'agent-qa': spec } })

    expect(written(result).devDependencies).toEqual({ 'agent-qa': '0.3.3' })
    expect(result.entries[0]).toMatchObject({ spec: '0.3.3', outcome: 'pinned' })
  })

  it.each([
    'file:../x',
    'link:../x',
    'portal:../x',
    'workspace:*',
    'github:acme/x',
    'https://example.com/x.tgz',
    'npm:other@1.0.0',
  ])('%s is left as declared', (spec) => {
    const manifest = { devDependencies: { 'agent-qa': spec } }
    const result = plan(manifest)

    expect(result.changed).toBe(false)
    expect(written(result)).toEqual(manifest)
    expect(result.entries[0]).toMatchObject({ spec, outcome: 'kept' })
  })

  it.each(['0.4.0', '^0.4.0'])('%s is newer and never lowered', (spec) => {
    const manifest = { devDependencies: { 'agent-qa': spec } }
    const result = plan(manifest)

    expect(result.changed).toBe(false)
    expect(written(result)).toEqual(manifest)
    expect(result.entries[0]).toMatchObject({ spec, outcome: 'newer' })
  })

  it('an entry in two blocks stays in both and nothing is removed', () => {
    const result = plan({
      dependencies: { 'agent-qa': '^0.3.0', react: '19.0.0' },
      devDependencies: { 'agent-qa': '0.2.6', typescript: '6.0.0' },
      peerDependencies: { 'agent-qa': '*' },
    })

    const after = written(result)
    expect(after.dependencies).toEqual({ 'agent-qa': '^0.3.0', react: '19.0.0' })
    expect(after.devDependencies).toEqual({ 'agent-qa': '0.3.3', typescript: '6.0.0' })
    expect(after.peerDependencies).toEqual({ 'agent-qa': '*' })
  })

  it('a prerelease running version pins an older release up', () => {
    const result = plan({ devDependencies: { 'agent-qa': '0.3.3' } }, '0.3.4-beta.0')

    expect(written(result).devDependencies).toEqual({ 'agent-qa': '0.3.4-beta.0' })
    expect(result.entries[0]).toMatchObject({ outcome: 'pinned' })
  })

  it('a release is newer than a prerelease of it and is left as declared', () => {
    const result = plan({ devDependencies: { 'agent-qa': '0.3.4' } }, '0.3.4-beta.0')

    expect(result.changed).toBe(false)
    expect(result.entries[0]).toMatchObject({ spec: '0.3.4', outcome: 'newer' })
  })
})

describe('the dependencies init declares', () => {
  it('the subscription plugin is declared only for a subscription model', () => {
    const names = (usesSubscription: boolean) =>
      projectDependencies({ version: '0.3.3', usesSubscription, plugins: [] }).map(
        (dependency) => dependency.name,
      )

    expect(names(true)).toEqual(['agent-qa', SUBSCRIPTION_AUTH_PACKAGE])
    expect(names(false)).toEqual(['agent-qa'])
  })

  it('a first-party plugin is declared at the version given and a third-party or path plugin adds nothing', () => {
    const dependencies = projectDependencies({
      version: '0.3.3',
      usesSubscription: false,
      plugins: [
        { package: '@vostride/agent-qa-plugin-kernel' },
        { package: '@acme/agent-qa-plugin-grid' },
        { package: './plugins/local-grid' },
      ],
    })

    expect(dependencies).toEqual([
      { name: 'agent-qa', version: '0.3.3' },
      { name: '@vostride/agent-qa-plugin-kernel', version: '0.3.3' },
    ])
  })
})
