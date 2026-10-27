import { describe, it, expect } from 'vitest'
import { loadLocalBindings } from '../devices.js'

describe('loadLocalBindings', () => {
  it('returns null when file does not exist', () => {
    const result = loadLocalBindings('/tmp/nonexistent-dir-' + Date.now())
    expect(result).toBeNull()
  })

  it('parses valid YAML with devices + providers + apps keys', async () => {
    const { writeFileSync, mkdirSync, rmSync } = await import('node:fs')
    const { join } = await import('node:path')
    const dir = `/tmp/test-bindings-${Date.now()}`
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'agent-qa.local.yaml'),
      `devices:
  pixel-7:
    avd: Pixel_7_API_34
providers:
  browserstack:
    username: testuser
    accessKey: testkey123
apps:
  release-android-wikipedia:
    path: build/wikipedia.apk
    browserstack: build/wikipedia.apk
`,
    )
    try {
      const result = loadLocalBindings(dir)
      expect(result).not.toBeNull()
      expect(result!.devices?.['pixel-7']).toEqual({ avd: 'Pixel_7_API_34' })
      expect(result!.providers?.browserstack).toEqual({
        username: 'testuser',
        accessKey: 'testkey123',
      })
      expect(result!.apps?.['release-android-wikipedia']).toEqual({
        path: 'build/wikipedia.apk',
        browserstack: 'build/wikipedia.apk',
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('parses generated-style comment-only local sections as empty bindings', async () => {
    const { writeFileSync, mkdirSync, rmSync } = await import('node:fs')
    const { join } = await import('node:path')
    const dir = `/tmp/test-bindings-empty-${Date.now()}`
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'agent-qa.local.yaml'),
      `# This file is for machine-specific device, app, and provider bindings.
# Keep it out of git.

devices:
  # android-emu:
  #   avd: Pixel_8_API_35

apps:
  # example-android:
  #   path: apps/example.apk

providers:
  # browserstack:
  #   username: \${BROWSERSTACK_USERNAME}
  #   accessKey: \${BROWSERSTACK_ACCESS_KEY}
`,
    )

    try {
      const result = loadLocalBindings(dir)
      expect(result).not.toBeNull()
      expect(result!.devices).toEqual({})
      expect(result!.apps).toEqual({})
      expect(result!.providers).toEqual({})
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('still rejects incomplete non-empty provider entries', async () => {
    const { writeFileSync, mkdirSync, rmSync } = await import('node:fs')
    const { join } = await import('node:path')
    const dir = `/tmp/test-bindings-incomplete-provider-${Date.now()}`
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'agent-qa.local.yaml'),
      `providers:
  browserstack:
    username: testuser
`,
    )

    try {
      expect(() => loadLocalBindings(dir)).toThrow()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('does not fall back to agent-qa.devices.local.yaml', async () => {
    const { writeFileSync, mkdirSync, rmSync } = await import('node:fs')
    const { join } = await import('node:path')
    const dir = `/tmp/test-bindings-no-fallback-${Date.now()}`
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'agent-qa.devices.local.yaml'),
      `devices:
  pixel-7:
    avd: Pixel_7_API_34
`,
    )

    try {
      expect(loadLocalBindings(dir)).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
