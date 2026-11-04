// Spawns the built `dist/cli.js`; run `pnpm build` at the repository root first.

import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { afterEach, beforeAll, describe, expect, it } from 'vitest'

import {
  CLI_ENTRY,
  REBUILD_INSTRUCTION,
  buildFreshness,
  cleanupTempRoots,
  fixtureProject,
  spawnCollecting,
} from './conformance/spawned-chat.js'

function devicesProject(label: string): string {
  const { root, configPath } = fixtureProject(`devices-${label}`)
  const config = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>
  config.registry = {
    remotes: [{ name: 'farm', protocol: 'appium', url: 'https://farm.example.com/wd/hub' }],
    devices: {
      pixel: { platform: 'android', model: 'Pixel 8' },
      'galaxy-farm': { platform: 'android', model: 'Galaxy S24', remote: 'farm' },
    },
  }
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
  writeFileSync(join(root, '.env'), '', 'utf8')
  writeFileSync(join(root, 'hooks.yaml'), 'hooks: []\n', 'utf8')
  return root
}

describe('agent-qa devices', () => {
  beforeAll(() => {
    expect(buildFreshness(), REBUILD_INSTRUCTION).toEqual({ missing: [], stale: [] })
  })

  afterEach(() => {
    cleanupTempRoots()
  })

  it('devices init is refused with what replaced it and writes no file', async () => {
    const root = devicesProject('init')
    const before = readdirSync(root).sort()

    const outcome = await spawnCollecting(root, [CLI_ENTRY, 'devices', 'init'])

    expect(outcome.code).toBe(1)
    expect(outcome.stderr.trim()).toBe(
      'agent-qa devices init was removed: devices are found by model and os, so nothing needs binding. Run agent-qa devices to see what this machine has.',
    )
    expect(readdirSync(root).sort()).toEqual(before)
  })

  it('bare devices lists each profile with its platform and the remote it runs on', async () => {
    const root = devicesProject('list')

    const outcome = await spawnCollecting(root, [CLI_ENTRY, 'devices'])

    expect(outcome.code).toBe(0)
    expect(outcome.stdout).toMatch(/^\s+pixel\s+android\s*$/mu)
    expect(outcome.stdout).toMatch(
      /^\s+galaxy-farm\s+android\s+farm \(appium https:\/\/farm\.example\.com:443\)$/mu,
    )
  })
})
