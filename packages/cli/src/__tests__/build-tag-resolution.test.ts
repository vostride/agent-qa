import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { createRunCommand } from '../commands/run.js'
import {
  resolveBuildTagSetting,
  resolveRunBuildOrdinal,
} from '@vostride/agent-qa-agent-local'

const tempDirs: string[] = []

async function createConfigDir(): Promise<string> {
  const configDir = await mkdtemp(join(tmpdir(), 'agent-qa-build-tag-'))
  tempDirs.push(configDir)
  await mkdir(join(configDir, '.agent-qa'))
  return configDir
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('resolveBuildTagSetting', () => {
  it('uses flag, then env, then use.buildTag precedence', () => {
    expect(resolveBuildTagSetting({ flag: ' A ', env: 'B', use: { buildTag: 'C' } })).toBe('A')
    expect(resolveBuildTagSetting({ env: ' B ', use: { buildTag: 'C' } })).toBe('B')
    expect(resolveBuildTagSetting({ use: { buildTag: ' C ' } })).toBe('C')
  })

  it('treats missing and whitespace-only values as absent', () => {
    expect(resolveBuildTagSetting({})).toBeUndefined()
    expect(resolveBuildTagSetting({ flag: ' ', env: '\t', use: { buildTag: '\n' } })).toBeUndefined()
  })
})

describe('resolveRunBuildOrdinal build-tag recording', () => {
  it('records the freshly advanced ordinal and preserves the first-seen mapping', async () => {
    const configDir = await createConfigDir()

    const first = await resolveRunBuildOrdinal({ configDir, product: 'checkout', buildTag: 'v1' })
    const second = await resolveRunBuildOrdinal({ configDir, product: 'checkout', buildTag: 'v1' })
    const map = JSON.parse(
      await readFile(join(configDir, '.agent-qa', 'build-tags.json'), 'utf-8'),
    ) as unknown

    expect(first).toBe(1)
    expect(second).toBe(2)
    expect(map).toEqual({ checkout: { v1: 1 } })
  })

  it('advances without creating build-tags.json when no tag is supplied', async () => {
    const configDir = await createConfigDir()

    await expect(resolveRunBuildOrdinal({ configDir, product: 'checkout' })).resolves.toBe(1)
    expect(existsSync(join(configDir, '.agent-qa', 'build-tags.json'))).toBe(false)
  })
})

describe('run command build-tag option', () => {
  it('documents the flag and its env/config fallbacks', () => {
    const help = createRunCommand().helpInformation()

    expect(help).toContain('--build-tag <tag>')
    expect(help).toContain('AGENT_QA_BUILD_TAG')
    expect(help).toContain('use.buildTag')
  })
})
