import { readFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Command } from 'commander'
import { parse as parseYaml } from 'yaml'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { isCanonicalSuiteId } from '@vostride/agent-qa-ids'
import { createCreateSuiteCommand } from '../commands/create-suite.js'

const tempDirs: string[] = []

vi.spyOn(console, 'log').mockImplementation(() => {})

afterEach(async () => {
  process.exitCode = 0
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })))
  tempDirs.length = 0
})

async function runCreateSuite(outputPath: string): Promise<void> {
  const parent = new Command()
  parent.addCommand(createCreateSuiteCommand())
  await parent.parseAsync(['node', 'test', 'create-suite', outputPath])
}

describe('create-suite command', () => {
  it('writes a canonical 10-word suite-id into new YAML files', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'agent-qa-create-suite-'))
    tempDirs.push(rootDir)
    const suitePath = join(rootDir, 'tests', 'smoke.suite.yaml')

    await runCreateSuite(suitePath)

    const content = await readFile(suitePath, 'utf-8')
    const parsed = parseYaml(content) as Record<string, unknown>
    expect(typeof parsed['suite-id']).toBe('string')
    expect(isCanonicalSuiteId(parsed['suite-id'] as string)).toBe(true)
  })
})
