import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdir, writeFile, rm, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { Command } from 'commander'

function hashStepInstruction(step: string, platform = 'web', configContent = '', testFileContent = '', stepIndex = 0): string {
  return createHash('sha256').update(configContent + '||' + '' + '||' + '0' + '||' + testFileContent + '||' + step + '||' + platform + '||' + String(stepIndex)).digest('hex').slice(0, 16)
}

const TMP_DIR = join(tmpdir(), 'agent-qa-cache-purge-test-' + process.pid)
const CONFIG_CONTENT = 'cache:\n  dir: .agent-qa/cache\n'

beforeEach(async () => {
  await mkdir(TMP_DIR, { recursive: true })
})

afterEach(async () => {
  await rm(TMP_DIR, { recursive: true, force: true })
})

describe('purgeTest', () => {
  it('deletes cache directories matching step hashes from test YAML', async () => {
    const { purgeTest } = await import('../commands/cache.js')
    const cacheDir = join(TMP_DIR, 'cache')
    await mkdir(cacheDir, { recursive: true })

    const steps = ['Click the login button', 'Enter username']
    const testYaml = `url: https://example.com\nsteps:\n  - ${steps[0]}\n  - ${steps[1]}\n`
    const testPath = join(TMP_DIR, 'login.yaml')
    await writeFile(testPath, testYaml)

    for (let i = 0; i < steps.length; i++) {
      const hash = hashStepInstruction(steps[i], 'web', CONFIG_CONTENT, testYaml, i)
      await mkdir(join(cacheDir, hash), { recursive: true })
      await writeFile(join(cacheDir, hash, 'abc123.json'), '{}')
    }
    // Add an unrelated cache entry that should NOT be deleted
    await mkdir(join(cacheDir, 'unrelated123456'), { recursive: true })

    const count = await purgeTest(testPath, cacheDir, CONFIG_CONTENT)
    expect(count).toBe(2)

    const remaining = await readdir(cacheDir)
    expect(remaining).toEqual(['unrelated123456'])
  })

  it('returns 0 for test YAML with no steps', async () => {
    const { purgeTest } = await import('../commands/cache.js')
    const cacheDir = join(TMP_DIR, 'cache')
    await mkdir(cacheDir, { recursive: true })

    const testPath = join(TMP_DIR, 'empty.yaml')
    await writeFile(testPath, 'url: https://example.com\nsteps: []\n')

    const count = await purgeTest(testPath, cacheDir, CONFIG_CONTENT)
    expect(count).toBe(0)
  })

  it('throws for non-existent test file', async () => {
    const { purgeTest } = await import('../commands/cache.js')
    const cacheDir = join(TMP_DIR, 'cache')
    await mkdir(cacheDir, { recursive: true })

    await expect(purgeTest(join(TMP_DIR, 'nope.yaml'), cacheDir)).rejects.toThrow()
  })

  it('hashes with declared platform from YAML', async () => {
    const { purgeTest } = await import('../commands/cache.js')
    const cacheDir = join(TMP_DIR, 'cache')
    await mkdir(cacheDir, { recursive: true })

    const step = 'Tap the submit button'
    const testYaml = `url: https://example.com\nplatform: android\nsteps:\n  - ${step}\n`
    const androidHash = hashStepInstruction(step, 'android', CONFIG_CONTENT, testYaml, 0)
    const webHash = hashStepInstruction(step, 'web', '', '', 0)

    // Create android cache entry
    await mkdir(join(cacheDir, androidHash), { recursive: true })
    // Create web cache entry — should NOT be deleted since test declares android
    await mkdir(join(cacheDir, webHash), { recursive: true })

    const testPath = join(TMP_DIR, 'mobile.yaml')
    await writeFile(testPath, testYaml)

    const count = await purgeTest(testPath, cacheDir, CONFIG_CONTENT)
    expect(count).toBe(1)

    const remaining = await readdir(cacheDir)
    expect(remaining).toContain(webHash)
    expect(remaining).not.toContain(androidHash)
  })

  it('handles step objects with step field', async () => {
    const { purgeTest } = await import('../commands/cache.js')
    const cacheDir = join(TMP_DIR, 'cache')
    await mkdir(cacheDir, { recursive: true })

    const step = 'Click the button'
    const testYaml = `url: https://example.com\nsteps:\n  - step: ${step}\n    assertion: Button clicked\n`
    const hash = hashStepInstruction(step, 'web', CONFIG_CONTENT, testYaml, 0)
    await mkdir(join(cacheDir, hash), { recursive: true })

    const testPath = join(TMP_DIR, 'object-steps.yaml')
    await writeFile(testPath, testYaml)

    const count = await purgeTest(testPath, cacheDir, CONFIG_CONTENT)
    expect(count).toBe(1)
  })
})

describe('purgeAll', () => {
  it('deletes all entries in cache dir with force=true', async () => {
    const { purgeAll } = await import('../commands/cache.js')
    const cacheDir = join(TMP_DIR, 'cache')
    await mkdir(cacheDir, { recursive: true })

    // Create some cache entries
    for (let i = 0; i < 5; i++) {
      await mkdir(join(cacheDir, `entry${i}`), { recursive: true })
      await writeFile(join(cacheDir, `entry${i}`, 'data.json'), '{}')
    }

    const count = await purgeAll(cacheDir, true)
    expect(count).toBe(5)

    const remaining = await readdir(cacheDir)
    expect(remaining).toEqual([])
  })

  it('returns 0 for non-existent cache dir', async () => {
    const { purgeAll } = await import('../commands/cache.js')
    const count = await purgeAll(join(TMP_DIR, 'nonexistent'), true)
    expect(count).toBe(0)
  })

  it('returns 0 for empty cache dir', async () => {
    const { purgeAll } = await import('../commands/cache.js')
    const cacheDir = join(TMP_DIR, 'empty-cache')
    await mkdir(cacheDir, { recursive: true })

    const count = await purgeAll(cacheDir, true)
    expect(count).toBe(0)
  })

  it('uses .agent-qa/cache as the command fallback cache directory', async () => {
    const { createCacheCommand } = await import('../commands/cache.js')
    const cacheDir = join(TMP_DIR, '.agent-qa', 'cache')
    await mkdir(join(cacheDir, 'entry'), { recursive: true })
    await writeFile(join(cacheDir, 'entry', 'data.json'), '{}')
    await writeFile(join(TMP_DIR, 'agent-qa.config.yaml'), `
workspace:
  testMatch:
    - tests/**/*.yaml
  suiteMatch:
    - suites/**/*.suite.yaml
  hooksFile: hooks.yaml
  agentRules: agent-rules.md
  envFile: .env
  secretsFile: .env.secrets.local
use:
  mobile:
    appState: preserve
`)

    const parent = new Command()
    parent.exitOverride()
    parent.addCommand(createCacheCommand())

    const originalCwd = process.cwd()
    process.chdir(TMP_DIR)
    try {
      await parent.parseAsync(['node', 'test', 'cache', 'purge', '--all', '--force'])
    } finally {
      process.chdir(originalCwd)
    }

    expect(await readdir(cacheDir)).toEqual([])
  })
})
