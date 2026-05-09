import { describe, it, expect, vi, beforeEach } from 'vitest'
import { resolveDevice, loadLocalBindings, resolveProviderCredentials } from '../devices.js'
import type { AgentQaConfig } from '@vostride/agent-qa-core'

function makeConfig(devices?: Record<string, unknown>, providers?: Record<string, unknown>): AgentQaConfig {
  return {
    registry: {
      llms: [],
      ...(devices ? { devices } : {}),
      ...(providers ? { providers } : {}),
    },
  } as unknown as AgentQaConfig
}

const sampleDevices = {
  'pixel-7': {
    platform: 'android',
    transport: 'local',
    match: { automationName: 'UiAutomator2' },
  },
  'iphone-15': {
    platform: 'ios',
    transport: 'local',
    match: { automationName: 'XCUITest' },
  },
  'bs-pixel': {
    platform: 'android',
    transport: 'browserstack',
    match: { deviceName: 'Google Pixel 8', platformVersion: '14.0' },
  },
}

describe('resolveDevice', () => {
  it('resolves a valid device name with merged fields', () => {
    const config = makeConfig(sampleDevices)
    const localBindings = {
      devices: { 'pixel-7': { avd: 'Pixel_7_API_34' } },
    }
    const resolved = resolveDevice(config, 'pixel-7', localBindings)
    expect(resolved.name).toBe('pixel-7')
    expect(resolved.platform).toBe('android')
    expect(resolved.transport).toBe('local')
    expect(resolved.match.avd).toBe('Pixel_7_API_34')
    expect(resolved.match.automationName).toBe('UiAutomator2')
  })

  it('throws for unknown device name', () => {
    const config = makeConfig(sampleDevices)
    expect(() => resolveDevice(config, 'nonexistent')).toThrow(
      'Device "nonexistent" not found in registry.devices',
    )
  })

  it('throws when no devices configured', () => {
    const config = makeConfig()
    expect(() => resolveDevice(config, 'anything')).toThrow('not found')
  })

  it('throws for transport:local with no local binding (D-10)', () => {
    const config = makeConfig(sampleDevices)
    expect(() => resolveDevice(config, 'pixel-7')).toThrow(
      'transport: local but no binding found in agent-qa.local.yaml',
    )
  })

  it('succeeds for transport:browserstack without local binding (D-11)', () => {
    const config = makeConfig(sampleDevices)
    const resolved = resolveDevice(config, 'bs-pixel')
    expect(resolved.name).toBe('bs-pixel')
    expect(resolved.transport).toBe('browserstack')
    expect(resolved.match.deviceName).toBe('Google Pixel 8')
  })

  it('deep-merges local match into shared match (D-02, local overrides shared)', () => {
    const config = makeConfig(sampleDevices)
    const localBindings = {
      devices: {
        'pixel-7': { avd: 'Pixel_7_API_34', automationName: 'Espresso' },
      },
    }
    const resolved = resolveDevice(config, 'pixel-7', localBindings)
    expect(resolved.match.automationName).toBe('Espresso')
    expect(resolved.match.avd).toBe('Pixel_7_API_34')
  })

  it('farm transport can optionally use local binding overrides', () => {
    const config = makeConfig(sampleDevices)
    const localBindings = {
      devices: { 'bs-pixel': { deviceName: 'Samsung Galaxy S24' } },
    }
    const resolved = resolveDevice(config, 'bs-pixel', localBindings)
    expect(resolved.match.deviceName).toBe('Samsung Galaxy S24')
  })

  it('returns ResolvedDevice shape', () => {
    const config = makeConfig(sampleDevices)
    const localBindings = {
      devices: { 'iphone-15': { udid: '00008120-001E44F11ABC001E' } },
    }
    const resolved = resolveDevice(config, 'iphone-15', localBindings)
    expect(resolved).toHaveProperty('name')
    expect(resolved).toHaveProperty('platform')
    expect(resolved).toHaveProperty('transport')
    expect(resolved).toHaveProperty('match')
  })
})

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

describe('resolveProviderCredentials', () => {
  beforeEach(() => {
    delete process.env.BROWSERSTACK_USERNAME
    delete process.env.BROWSERSTACK_ACCESS_KEY
  })

  it('returns credentials from local file providers section', () => {
    const localBindings = {
      providers: {
        browserstack: { username: 'user1', accessKey: 'key1' },
      },
    }
    const creds = resolveProviderCredentials('browserstack', localBindings)
    expect(creds.username).toBe('user1')
    expect(creds.accessKey).toBe('key1')
  })

  it('falls back to env vars when local file has no entry', () => {
    process.env.BROWSERSTACK_USERNAME = 'envuser'
    process.env.BROWSERSTACK_ACCESS_KEY = 'envkey'
    const creds = resolveProviderCredentials('browserstack')
    expect(creds.username).toBe('envuser')
    expect(creds.accessKey).toBe('envkey')
  })

  it('throws when neither source has credentials', () => {
    expect(() => resolveProviderCredentials('browserstack')).toThrow(
      'credentials not found',
    )
    expect(() => resolveProviderCredentials('browserstack')).toThrow(
      'agent-qa.local.yaml',
    )
  })

  it('rejects unsupported provider env surfaces', () => {
    expect(() => resolveProviderCredentials('saucelabs')).toThrow(
      'Unknown provider',
    )
    expect(() => resolveProviderCredentials('lambdatest')).toThrow(
      'Unknown provider',
    )
  })

  it('throws for unknown provider', () => {
    expect(() => resolveProviderCredentials('unknown')).toThrow(
      'Unknown provider',
    )
  })
})
