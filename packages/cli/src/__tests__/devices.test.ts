import { describe, it, expect } from 'vitest'
import { loadLocalBindings } from '../devices.js'

describe('loadLocalBindings', () => {
  it('returns null when file does not exist', () => {
    const result = loadLocalBindings('/tmp/nonexistent-dir-' + Date.now())
    expect(result).toBeNull()
  })

  it('parses valid YAML with devices + apps keys', async () => {
    const { writeFileSync, mkdirSync, rmSync } = await import('node:fs')
    const { join } = await import('node:path')
    const dir = `/tmp/test-bindings-${Date.now()}`
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'agent-qa.local.yaml'),
      `devices:
  pixel-7:
    avd: Pixel_7_API_34
apps:
  release-android-wikipedia:
    path: build/wikipedia.apk
`,
    )
    try {
      const result = loadLocalBindings(dir)
      expect(result).not.toBeNull()
      expect(result!.devices?.['pixel-7']).toEqual({ avd: 'Pixel_7_API_34' })
      expect(result!.apps?.['release-android-wikipedia']).toEqual({
        path: 'build/wikipedia.apk',
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
      `# This file is for machine-specific device and app bindings.
# Keep it out of git.
# Add agent-qa.local.yaml to .gitignore.

devices:
  # Example local device binding:
  # android-emu:
  #   avd: Pixel_8_API_35

apps:
  # Example app install binding:
  # example-android:
  #   path: apps/example.apk
`,
    )

    try {
      const result = loadLocalBindings(dir)
      expect(result).not.toBeNull()
      expect(result!.devices).toEqual({})
      expect(result!.apps).toEqual({})
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('refuses a local file that an older init wrote with a providers block', async () => {
    const { writeFileSync, mkdirSync, rmSync } = await import('node:fs')
    const { join } = await import('node:path')
    const dir = `/tmp/test-bindings-old-init-${Date.now()}`
    mkdirSync(dir, { recursive: true })
    const filePath = join(dir, 'agent-qa.local.yaml')
    writeFileSync(
      filePath,
      `# This file is for machine-specific device, app, and provider bindings.
# Keep it out of git.
# Add agent-qa.local.yaml to .gitignore.

devices:
  # Example local device binding:
  # android-emu:
  #   avd: Pixel_8_API_35

apps:
  # Example app install binding:
  # example-android:
  #   path: apps/example.apk

providers:
  # Example cloud provider credentials:
  # browserstack:
  #   username: \${BROWSERSTACK_USERNAME}
  #   accessKey: \${BROWSERSTACK_ACCESS_KEY}
`,
    )

    try {
      expect(() => loadLocalBindings(dir)).toThrow(
        `${filePath}:\n  providers: providers was removed: BrowserStack is no longer supported. Delete this block.`,
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("refuses a local app's browserstack with its removal message", async () => {
    const { writeFileSync, mkdirSync, rmSync } = await import('node:fs')
    const { join } = await import('node:path')
    const dir = `/tmp/test-bindings-app-browserstack-${Date.now()}`
    mkdirSync(dir, { recursive: true })
    const filePath = join(dir, 'agent-qa.local.yaml')
    writeFileSync(
      filePath,
      `apps:
  release-android-wikipedia:
    path: build/wikipedia.apk
    browserstack: bs://wikipedia
`,
    )

    try {
      expect(() => loadLocalBindings(dir)).toThrow(
        `${filePath}:\n  apps.release-android-wikipedia.browserstack: apps.<name>.browserstack was removed: BrowserStack is no longer supported; apps.<name>.path is the app file. Delete this line.`,
      )
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
