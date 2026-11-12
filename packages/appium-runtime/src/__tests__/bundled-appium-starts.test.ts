import { spawn as nodeSpawn } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { resolveBundledAppium } from '../bundled-appium'
import { startAppiumServer, type AppiumServer, type AppiumSpawn } from '../start-appium-server'

const require = createRequire(import.meta.url)

function installedVersion(manifest: string): string {
  return (require(manifest) as { version: string }).version
}

async function waitUntil(done: () => boolean, ms: number): Promise<void> {
  const deadline = Date.now() + ms
  while (!done() && Date.now() < deadline) {
    await new Promise((settle) => setTimeout(settle, 100))
  }
}

let server: AppiumServer | undefined

afterEach(async () => {
  await server?.stop()
  server = undefined
})

describe('startAppiumServer', () => {
  it('starts the bundled Appium on loopback with both drivers, and stop removes its home and leaves the drivers', async () => {
    const appiumHomeBefore = process.env.APPIUM_HOME
    let childEnv: NodeJS.ProcessEnv | undefined
    const spawn: AppiumSpawn = (command, args, options) => {
      childEnv = options.env
      return nodeSpawn(command, [...args], options)
    }
    let output = ''

    server = await startAppiumServer({
      spawn,
      onOutput: (text) => {
        output += text
      },
    })

    expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u)
    const status = (await (await fetch(`${server.url}/status`)).json()) as {
      value: { ready: boolean; build: { version: string } }
    }
    expect(status.value.ready).toBe(true)
    expect(status.value.build.version).toBe(installedVersion('appium/package.json'))

    const drivers = [
      `uiautomator2@${installedVersion('appium-uiautomator2-driver/package.json')}`,
      `xcuitest@${installedVersion('appium-xcuitest-driver/package.json')}`,
    ]
    await waitUntil(() => drivers.every((driver) => output.includes(driver)), 10_000)
    for (const driver of drivers) expect(output).toContain(driver)

    const home = childEnv?.APPIUM_HOME ?? ''
    expect(dirname(home)).toBe(await realpath(tmpdir()))
    expect(basename(home)).toMatch(/^agent-qa-appium-/u)
    expect(statSync(home).isDirectory()).toBe(true)
    expect(process.env.APPIUM_HOME).toBe(appiumHomeBefore)

    await server.stop()

    expect(existsSync(home)).toBe(false)
    for (const folder of resolveBundledAppium().driverFolders) {
      expect(existsSync(join(folder, 'package.json'))).toBe(true)
    }
  }, 60_000)
})
