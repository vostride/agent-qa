import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { afterEach, describe, expect, it } from 'vitest'
import { isCanonicalTestId } from '@vostride/agent-qa-ids'
import { resolveWorkspacePaths } from '@vostride/agent-qa-core'
import { TestFileManager } from '../tests/test-file-manager.js'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })))
  tempDirs.length = 0
})

describe('TestFileManager missing-id backfill', () => {
  it('writes a canonical 10-word test-id when list() finds a file without one', async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), 'agent-qa-test-file-manager-ids-'))
    tempDirs.push(workspaceDir)
    const testPath = join(workspaceDir, 'specs/web/login.yaml')
    await mkdir(dirname(testPath), { recursive: true })
    await writeFile(
      testPath,
      ['name: Login', 'target: web', 'steps:', '  - Click login', ''].join('\n'),
      'utf-8',
    )

    const manager = new TestFileManager(resolveWorkspacePaths({
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
    expect(files[0].testId).not.toBeNull()
    expect(isCanonicalTestId(files[0].testId!)).toBe(true)

    const content = await readFile(testPath, 'utf-8')
    const parsed = parseYaml(content) as Record<string, unknown>
    expect(parsed['test-id']).toBe(files[0].testId)
  })
})
