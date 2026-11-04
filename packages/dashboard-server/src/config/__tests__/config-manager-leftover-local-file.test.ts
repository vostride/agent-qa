import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { inspect } from 'node:util'

import { afterEach, describe, expect, it } from 'vitest'

import { ConfigManager, readConfigValues } from '../index.js'

const CONFIG = [
  'workspace:',
  '  testMatch:',
  '    - tests/**/*.yaml',
  '  suiteMatch:',
  '    - suites/**/*.suite.yaml',
  '  hooksFile: hooks.yaml',
  '  envFile: .env',
  '  secretsFile: .env.secrets.local',
  '',
].join('\n')

const RETIRED_LOCAL_FILE =
  'agent-qa.local.yaml is no longer read: describe each device under registry.devices with model and os (id pins one unit), and set app.path on the target. Delete the file.'

const PLANTED_KEY = 'bs-access-key-PLANTEDFIXTUREONLY'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function project(options: { leftover: boolean }): Promise<{
  manager: ConfigManager
  line: string
}> {
  const dir = await mkdtemp(join(tmpdir(), 'agent-qa-leftover-local-'))
  tempDirs.push(dir)
  await writeFile(join(dir, 'agent-qa.config.yaml'), CONFIG, 'utf-8')
  const localPath = join(dir, 'agent-qa.local.yaml')
  if (options.leftover) {
    await writeFile(localPath, `providers:\n  browserstack:\n    accessKey: ${PLANTED_KEY}\n`)
  }
  return {
    manager: new ConfigManager(join(dir, 'agent-qa.config.yaml'), (value) => value),
    line: `${localPath}: ${RETIRED_LOCAL_FILE}`,
  }
}

describe('agent-qa.local.yaml beside the config', () => {
  it('when present refuses readConfigValues with its path and the retirement message', async () => {
    const { manager, line } = await project({ leftover: true })

    const error = await readConfigValues(manager).then(
      () => undefined,
      (err: unknown) => err as Error,
    )

    expect(error?.message).toBe(line)
    expect(inspect(error)).not.toContain(PLANTED_KEY)
  })

  it('when present shows the Config page the same line as a config error', async () => {
    const { manager, line } = await project({ leftover: true })

    const read = await manager.readMasked()

    expect(read).toMatchObject({ kind: 'file_invalid', message: line })
    expect(JSON.stringify(read)).not.toContain(PLANTED_KEY)
  })

  it('when absent leaves the config reading as written', async () => {
    const { manager } = await project({ leftover: false })

    await expect(readConfigValues(manager)).resolves.toMatchObject({
      workspace: { hooksFile: 'hooks.yaml' },
    })
    await expect(manager.readMasked()).resolves.toMatchObject({ kind: 'ok' })
  })
})
