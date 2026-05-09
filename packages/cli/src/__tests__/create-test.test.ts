import { readFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Command } from 'commander'
import { parse as parseYaml } from 'yaml'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { isCanonicalTestId } from '@vostride/agent-qa-ids'
import { createCreateTestCommand } from '../commands/create-test.js'

const tempDirs: string[] = []

vi.spyOn(console, 'log').mockImplementation(() => {})

afterEach(async () => {
  process.exitCode = 0
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })))
  tempDirs.length = 0
})

async function runCreateTest(outputPath: string): Promise<void> {
  const parent = new Command()
  parent.addCommand(createCreateTestCommand())
  await parent.parseAsync(['node', 'test', 'create-test', outputPath])
}

describe('create-test command', () => {
  it('writes a canonical 10-word test-id into new YAML files', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'agent-qa-create-test-'))
    tempDirs.push(rootDir)
    const testPath = join(rootDir, 'tests', 'login.yaml')

    await runCreateTest(testPath)

    const content = await readFile(testPath, 'utf-8')
    const parsed = parseYaml(content) as Record<string, unknown>
    expect(typeof parsed['test-id']).toBe('string')
    expect(isCanonicalTestId(parsed['test-id'] as string)).toBe(true)
  })
})
