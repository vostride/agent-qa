import { mkdtemp, mkdir, rm, unlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentQaConfig } from '../../types/config.js'
import {
  discoverWorkspaceFiles,
  resolveWorkspaceFileTarget,
  resolveWorkspacePaths,
  workspaceRelativeIdentityPath,
} from '../workspace-paths.js'

interface SampleWorkspaceConfigFixture {
  config: AgentQaConfig
  configPath: string
  root: string
}

const tempRoots: string[] = []

async function writeFixtureFile(root: string, relativePath: string, content = ''): Promise<void> {
  const absolutePath = path.join(root, relativePath)
  await mkdir(path.dirname(absolutePath), { recursive: true })
  await writeFile(absolutePath, content)
}

export async function createSampleWorkspaceConfigFixture(): Promise<SampleWorkspaceConfigFixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-qa-workspace-paths-'))
  tempRoots.push(root)

  const config: AgentQaConfig = {
    workspace: {
      testMatch: ['specs/web/**/*.yaml', 'specs/mobile/**/*.yaml'],
      suiteMatch: ['cases/**/*.suite.yaml'],
      hooksFile: 'runtime/hooks/custom-hooks.yaml',
      envFile: 'config/env/public.env',
      secretsFile: 'config/env/secrets.local',
    },
    knowledge: { dir: 'agent-qa-knowledge' },
    services: {
      dashboard: {
        port: 3470,
        artifactsDir: '.agent-qa/custom-artifacts',
        // `runServiceTokens` is deleted, so the parsed shape no longer carries it.
      },
      cache: {
        dir: '.agent-qa/custom-cache',
      },
      logging: {
        level: 'warn',
      },
      recording: {
        enabled: false,
      },
      accessibility: {
        enabled: false,
      },
    },
  }

  await Promise.all([
    writeFixtureFile(root, 'specs/web/login.yaml', 'name: Login\n'),
    writeFixtureFile(root, 'specs/mobile/alarm.yaml', 'name: Alarm\n'),
    writeFixtureFile(root, 'cases/smoke.suite.yaml', 'name: Smoke\ntests: []\n'),
    writeFixtureFile(root, 'runtime/hooks/custom-hooks.yaml', 'hooks: []\n'),
    writeFixtureFile(root, 'runtime/hooks/set-env.js', 'export default async function setup() {}\n'),
    writeFixtureFile(root, 'config/env/public.env', 'PUBLIC_VALUE=1\n'),
    writeFixtureFile(root, 'config/env/secrets.local', 'SECRET_VALUE=1\n'),
    writeFixtureFile(root, 'tests/legacy.yaml', 'name: Legacy\n'),
  ])

  return {
    config,
    configPath: path.join(root, 'agent-qa.config.yaml'),
    root,
  }
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('workspace path resolver', () => {
  it('resolves scalar workspace paths relative to the config directory', async () => {
    const fixture = await createSampleWorkspaceConfigFixture()

    const workspace = resolveWorkspacePaths({
      config: fixture.config,
      configPath: fixture.configPath,
      requireExistingFiles: true,
    })

    expect(workspace.configPath).toBe(path.resolve(fixture.configPath))
    expect(workspace.configDir).toBe(fixture.root)
    expect(workspace.hooksFile.absolutePath).toBe(path.join(fixture.root, 'runtime/hooks/custom-hooks.yaml'))
    expect(workspace.hooksFile.workspaceRelativePath).toBe('runtime/hooks/custom-hooks.yaml')
    expect(workspace.envFile.absolutePath).toBe(path.join(fixture.root, 'config/env/public.env'))
    expect(workspace.secretsFile.absolutePath).toBe(path.join(fixture.root, 'config/env/secrets.local'))
  })

  it('keeps service runtime path fixture values relative before runtime resolution', async () => {
    const fixture = await createSampleWorkspaceConfigFixture()

    expect(fixture.config.services?.dashboard?.artifactsDir).toBe('.agent-qa/custom-artifacts')
    expect(fixture.config.services?.cache?.dir).toBe('.agent-qa/custom-cache')
    expect(fixture.config.services?.logging?.level).toBe('warn')
    expect(fixture.config.services?.recording?.enabled).toBe(false)
    expect(fixture.config.services?.accessibility?.enabled).toBe(false)
  })

  it('discovers test files from non-default testMatch patterns only', async () => {
    const fixture = await createSampleWorkspaceConfigFixture()
    const workspace = resolveWorkspacePaths({ config: fixture.config, configPath: fixture.configPath })

    const records = await discoverWorkspaceFiles({ workspace, kind: 'test' })

    expect(records.map(record => record.workspaceRelativePath)).toEqual([
      'specs/mobile/alarm.yaml',
      'specs/web/login.yaml',
    ])
  })

  it('discovers suite files from non-default suiteMatch patterns only', async () => {
    const fixture = await createSampleWorkspaceConfigFixture()
    const workspace = resolveWorkspacePaths({ config: fixture.config, configPath: fixture.configPath })

    const records = await discoverWorkspaceFiles({ workspace, kind: 'suite' })

    expect(records.map(record => record.workspaceRelativePath)).toEqual(['cases/smoke.suite.yaml'])
  })

  it('resolves an in-pattern test target', async () => {
    const fixture = await createSampleWorkspaceConfigFixture()
    const workspace = resolveWorkspacePaths({ config: fixture.config, configPath: fixture.configPath })

    await expect(resolveWorkspaceFileTarget({
      workspace,
      kind: 'test',
      filePath: 'specs/web/login.yaml',
      requireExisting: true,
    })).resolves.toMatchObject({
      kind: 'test',
      workspaceRelativePath: 'specs/web/login.yaml',
    })
  })

  it('rejects an out-of-pattern legacy test target', async () => {
    const fixture = await createSampleWorkspaceConfigFixture()
    const workspace = resolveWorkspacePaths({ config: fixture.config, configPath: fixture.configPath })

    await expect(resolveWorkspaceFileTarget({
      workspace,
      kind: 'test',
      filePath: 'tests/legacy.yaml',
    })).rejects.toThrow(/not matched by configured workspace patterns/)
  })

  it('rejects path traversal outside the config directory', async () => {
    const fixture = await createSampleWorkspaceConfigFixture()
    const workspace = resolveWorkspacePaths({ config: fixture.config, configPath: fixture.configPath })

    await expect(resolveWorkspaceFileTarget({
      workspace,
      kind: 'test',
      filePath: '../outside.yaml',
    })).rejects.toThrow(/escapes config directory/)
  })

  it('fails explicitly when a required scalar workspace file is missing', async () => {
    const fixture = await createSampleWorkspaceConfigFixture()
    await unlink(path.join(fixture.root, 'config/env/public.env'))

    expect(() => resolveWorkspacePaths({
      config: fixture.config,
      configPath: fixture.configPath,
      requireExistingFiles: true,
    })).toThrow(/workspace\.envFile/)
  })
})

// The ONE spelling of the durable identity recipe. The committed quarantine
// ledger keys entries on this string, so "the same file under a different checkout root answers
// the same bytes" is not a convenience — it is the property that lets a ledger written on one
// machine suppress on another.
describe('workspaceRelativeIdentityPath', () => {
  const CHECKOUT_A = path.join(path.sep, 'Users', 'someone', 'repo')
  const CHECKOUT_B = path.join(path.sep, 'var', 'ci', 'workspace', '4711', 'repo')

  it('answers identical bytes for the same file under two different checkout roots', () => {
    const underA = workspaceRelativeIdentityPath(CHECKOUT_A, path.join(CHECKOUT_A, 'tests', 'checkout.yaml'))
    const underB = workspaceRelativeIdentityPath(CHECKOUT_B, path.join(CHECKOUT_B, 'tests', 'checkout.yaml'))

    expect(underA).toBe('tests/checkout.yaml')
    expect(underB).toBe('tests/checkout.yaml')
    expect(underA).toBe(underB)
    // Anchored on the bytes themselves, not on a relation between the two answers: no root
    // prefix survives, the separators are forward slashes, and there is no leading './' or '/'.
    expect(underA.startsWith('/')).toBe(false)
    expect(underA).not.toContain('\\')
    expect(underA).not.toContain(CHECKOUT_A)
    expect(underB).not.toContain(CHECKOUT_B)
  })

  it('trims a leading ./ and normalizes nested segments', () => {
    expect(workspaceRelativeIdentityPath(CHECKOUT_A, path.join(CHECKOUT_A, 'a', 'b', 'c.yaml')))
      .toBe('a/b/c.yaml')
    expect(workspaceRelativeIdentityPath(CHECKOUT_A, path.join(CHECKOUT_A, '.', 'tests', 'x.yaml')))
      .toBe('tests/x.yaml')
  })

  it('is idempotent — re-minting an already-relative identity is a no-op', () => {
    // A second mint must not resolve against process.cwd() and silently produce a different (or
    // escaping) answer: identity has to survive being handed through a layer twice.
    const once = workspaceRelativeIdentityPath(CHECKOUT_A, path.join(CHECKOUT_A, 'tests', 'checkout.yaml'))
    expect(workspaceRelativeIdentityPath(CHECKOUT_A, once)).toBe(once)
  })

  it('REFUSES a path that escapes the config directory', () => {
    expect(() => workspaceRelativeIdentityPath(CHECKOUT_A, path.join(CHECKOUT_A, '..', 'outside.yaml')))
      .toThrow(/escapes config directory/)
    expect(() => workspaceRelativeIdentityPath(CHECKOUT_A, path.join(path.sep, 'etc', 'passwd')))
      .toThrow(/escapes config directory/)
    // The config directory itself is not a file identity.
    expect(() => workspaceRelativeIdentityPath(CHECKOUT_A, CHECKOUT_A))
      .toThrow(/escapes config directory/)
  })
})
