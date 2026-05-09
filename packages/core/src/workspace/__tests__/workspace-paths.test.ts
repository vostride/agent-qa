import { mkdtemp, mkdir, rm, unlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentQaConfig } from '../../types/config.js'
import {
  discoverWorkspaceFiles,
  resolveWorkspaceFileTarget,
  resolveWorkspacePaths,
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
      agentRules: 'config/agent-rules.md',
      envFile: 'config/env/public.env',
      secretsFile: 'config/env/secrets.local',
    },
    services: {
      dashboard: {
        port: 3470,
        artifactsDir: '.agent-qa/custom-artifacts',
      },
      cache: {
        dir: '.agent-qa/custom-cache',
        ttl: 604_800_000,
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
      memory: {
        enabled: true,
        provider: 'local',
        dir: '.agent-qa/custom-memory',
        minTrust: 0.3,
        maxInjections: 3,
        curatorEnabled: true,
        curatorLockTimeout: 120_000,
        trustConfirmDelta: 0.05,
        trustContradictDelta: 0.10,
        ablationEnabled: true,
        circuitBreakerEnabled: true,
        circuitBreakerWindowSize: 20,
        circuitBreakerBaselineSize: 3,
        circuitBreakerThreshold: 0.15,
      },
    },
  }

  await Promise.all([
    writeFixtureFile(root, 'specs/web/login.yaml', 'name: Login\n'),
    writeFixtureFile(root, 'specs/mobile/alarm.yaml', 'name: Alarm\n'),
    writeFixtureFile(root, 'cases/smoke.suite.yaml', 'name: Smoke\ntests: []\n'),
    writeFixtureFile(root, 'runtime/hooks/custom-hooks.yaml', 'hooks: []\n'),
    writeFixtureFile(root, 'runtime/hooks/set-env.js', 'export default async function setup() {}\n'),
    writeFixtureFile(root, 'config/agent-rules.md', '# Rules\n'),
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
    expect(workspace.agentRules.absolutePath).toBe(path.join(fixture.root, 'config/agent-rules.md'))
    expect(workspace.envFile.absolutePath).toBe(path.join(fixture.root, 'config/env/public.env'))
    expect(workspace.secretsFile.absolutePath).toBe(path.join(fixture.root, 'config/env/secrets.local'))
  })

  it('keeps service runtime path fixture values relative before runtime resolution', async () => {
    const fixture = await createSampleWorkspaceConfigFixture()

    expect(fixture.config.services?.dashboard?.artifactsDir).toBe('.agent-qa/custom-artifacts')
    expect(fixture.config.services?.cache?.dir).toBe('.agent-qa/custom-cache')
    expect(fixture.config.services?.cache?.ttl).toBe(604_800_000)
    expect(fixture.config.services?.logging?.level).toBe('warn')
    expect(fixture.config.services?.recording?.enabled).toBe(false)
    expect(fixture.config.services?.accessibility?.enabled).toBe(false)
    expect(fixture.config.services?.memory?.provider).toBe('local')
    expect(fixture.config.services?.memory?.curatorEnabled).toBe(true)
    expect(fixture.config.services?.memory?.dir).toBe('.agent-qa/custom-memory')
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
