import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { afterEach, describe, expect, it } from 'vitest'
import { isCanonicalSuiteId } from '@vostride/agent-qa-ids'
import { resolveWorkspacePaths } from '@vostride/agent-qa-core'
import { SuiteFileManager } from '../tests/suite-file-manager.js'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })))
  tempDirs.length = 0
})

describe('SuiteFileManager missing-id backfill', () => {
  it('writes a canonical 10-word suite-id when list() finds a file without one', async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), 'agent-qa-suite-file-manager-ids-'))
    tempDirs.push(workspaceDir)
    const suitePath = join(workspaceDir, 'cases/smoke.suite.yaml')
    await mkdir(dirname(suitePath), { recursive: true })
    await writeFile(
      suitePath,
      ['name: Smoke', 'target: web', 'tests: []', ''].join('\n'),
      'utf-8',
    )

    const manager = new SuiteFileManager(resolveWorkspacePaths({
      config: {
        workspace: {
          testMatch: ['specs/web/**/*.yaml'],
          suiteMatch: ['cases/**/*.suite.yaml'],
          hooksFile: 'runtime/hooks/custom-hooks.yaml',
          agentRules: 'agent-rules.md',
          envFile: '.env',
          secretsFile: '.env.secrets.local',
        },
      },
      configPath: join(workspaceDir, 'agent-qa.config.yaml'),
    }))
    const files = await manager.list()

    expect(files).toHaveLength(1)
    expect(files[0].suiteId).not.toBeNull()
    expect(isCanonicalSuiteId(files[0].suiteId!)).toBe(true)

    const content = await readFile(suitePath, 'utf-8')
    const parsed = parseYaml(content) as Record<string, unknown>
    expect(parsed['suite-id']).toBe(files[0].suiteId)
  })
})
