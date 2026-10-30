import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentQaConfig } from '../../types/config.js'
import {
  discoverWorkspaceFiles,
  resolveWorkspaceFileTarget,
  resolveWorkspacePaths,
} from '../workspace-paths.js'

// `discoverWorkspaceFiles` is deterministic and non-empty for an existing matching target.

const tempRoots: string[] = []

async function writeFile_(root: string, relativePath: string, content = ''): Promise<void> {
  const absolutePath = path.join(root, relativePath)
  await mkdir(path.dirname(absolutePath), { recursive: true })
  await writeFile(absolutePath, content)
}

async function makeFixture(): Promise<{ config: AgentQaConfig; configPath: string; root: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-qa-discovery-cold-'))
  tempRoots.push(root)

  const config: AgentQaConfig = {
    workspace: {
      testMatch: ['tests/**/*.yaml'],
      suiteMatch: ['suites/**/*.suite.yaml'],
      hooksFile: 'hooks.yaml',
      envFile: '.env',
      secretsFile: '.env.secrets.local',
    },
  } as AgentQaConfig

  // Exactly one matching test file, the `tests/example-pass.yaml` that `init` scaffolds.
  await writeFile_(root, 'tests/example-pass.yaml', 'name: Example\nsteps: []\n')
  await writeFile_(root, 'hooks.yaml', '')
  await writeFile_(root, '.env', '')
  await writeFile_(root, '.env.secrets.local', '')

  return { config, configPath: path.join(root, 'agent-qa.config.yaml'), root }
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('discoverWorkspaceFiles — cold-call determinism', () => {
  it('finds exactly the one existing matching test on the FIRST call (no cold-call empty)', async () => {
    const { config, configPath } = await makeFixture()
    const workspace = resolveWorkspacePaths({ config, configPath })

    const records = await discoverWorkspaceFiles({ workspace, kind: 'test' })

    expect(records).toHaveLength(1)
    expect(records[0].workspaceRelativePath).toBe('tests/example-pass.yaml')
  })

  it('is deterministic across repeated cold discoveries over fresh resolved paths', async () => {
    const { config, configPath } = await makeFixture()

    const counts: number[] = []
    const relPaths: string[][] = []
    // Re-resolve workspace paths each iteration so no in-process cache warms the result.
    for (let i = 0; i < 25; i++) {
      const workspace = resolveWorkspacePaths({ config, configPath })
      const records = await discoverWorkspaceFiles({ workspace, kind: 'test' })
      counts.push(records.length)
      relPaths.push(records.map(r => r.workspaceRelativePath))
    }

    // Every call returns exactly one record — never an empty-on-first result.
    expect(new Set(counts)).toEqual(new Set([1]))
    for (const paths of relPaths) {
      expect(paths).toEqual(['tests/example-pass.yaml'])
    }
  })

  it('resolves the explicit existing target on a cold call (the `run <file>` path)', async () => {
    const { config, configPath } = await makeFixture()
    const workspace = resolveWorkspacePaths({ config, configPath })

    const record = await resolveWorkspaceFileTarget({
      workspace,
      kind: 'test',
      filePath: 'tests/example-pass.yaml',
      requireExisting: true,
    })

    expect(record.workspaceRelativePath).toBe('tests/example-pass.yaml')
  })
})
