import { createRequire } from 'node:module'

import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)

interface Manifest {
  version: string
  dependencies?: Record<string, string>
}

const exactVersion = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u

describe('package.json dependencies', () => {
  it('declares every Appium package, and every package Appium asks for by range, at exactly the version installed for Appium', () => {
    const appiumManifest = require.resolve('appium/package.json')
    const appium = require(appiumManifest) as Manifest
    const requireFromAppium = createRequire(appiumManifest)
    const own = require('../../package.json') as Manifest

    const pinned = Object.entries(appium.dependencies ?? {})
      .filter(([name, spec]) => name.startsWith('@appium/') || !exactVersion.test(spec))
      .map(([name]) => name)
      .sort()
    const declared = Object.fromEntries(pinned.map((name) => [name, own.dependencies?.[name]]))
    const installed = Object.fromEntries(
      pinned.map((name) => [name, (requireFromAppium(`${name}/package.json`) as Manifest).version]),
    )

    expect(declared).toEqual(installed)
  })
})
