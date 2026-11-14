import { describe, it, expect } from 'vitest'
import { buildLiveSessionConfig, readDraftAuthStateName } from '../lib/live-session-config.js'
import type { GlobalUseConfig, TargetDetail } from '../hooks/use-target-details.js'

describe('buildLiveSessionConfig', () => {
  it('builds a web bootstrap payload from the selected target', () => {
    const targets: Record<string, TargetDetail> = {
      webTarget: {
        platform: 'web',
        url: 'https://example.com',
      },
    }

    const result = buildLiveSessionConfig({
      content: 'name: Demo\nuse:\n  browser:\n    headless: true\nsteps:\n  - Open the page\n',
      targetName: 'webTarget',
      targets,
      globalUse: null,
    })

    expect(result).toEqual({
      platform: 'web',
      targetName: 'webTarget',
      url: 'https://example.com',
      headless: true,
    })
  })

  it('builds an iOS mobile bootstrap payload that leaves the device and app to the server', () => {
    const targets: Record<string, TargetDetail> = {
      'release-ios-wdio': {
        platform: 'ios',
        bundleId: 'org.reactjs.native.example.wdiodemoapp',
      },
    }

    const result = buildLiveSessionConfig({
      content: 'name: Demo\nuse:\n  device: release-ios-sim\nsteps:\n  - Open the app\n',
      targetName: 'release-ios-wdio',
      targets,
      globalUse: null,
    })

    expect(result).toEqual({
      platform: 'ios',
      targetName: 'release-ios-wdio',
      useDeviceName: 'release-ios-sim',
      appState: undefined,
      headless: undefined,
    })
  })

  it('throws when the selected target is missing', () => {
    expect(() =>
      buildLiveSessionConfig({
        content: 'name: Demo\nsteps:\n  - Missing target\n',
        targetName: 'missing',
        targets: {},
        globalUse: null,
      }),
    ).toThrow('Selected target "missing" was not found in workspace config')
  })

  it('prefers draft headless overrides over global defaults', () => {
    const targets: Record<string, TargetDetail> = {
      webTarget: {
        platform: 'web',
        url: 'https://example.com',
      },
    }
    const globalUse: GlobalUseConfig = {
      browser: { headless: true },
    }

    const result = buildLiveSessionConfig({
      content: 'name: Demo\nuse:\n  browser:\n    headless: false\nsteps:\n  - Open the page\n',
      targetName: 'webTarget',
      targets,
      globalUse,
    })

    expect(result.headless).toBe(false)
  })

  it('ignores legacy root headless values in drafts and global config', () => {
    const targets: Record<string, TargetDetail> = {
      webTarget: {
        platform: 'web',
        url: 'https://example.com',
      },
    }
    const globalUse = { headless: true } as unknown as GlobalUseConfig

    const result = buildLiveSessionConfig({
      content: 'name: Demo\nuse:\n  headless: true\nsteps:\n  - Open the page\n',
      targetName: 'webTarget',
      targets,
      globalUse,
    })

    expect(result.headless).toBeUndefined()
  })

  it('builds an Android mobile bootstrap payload from draft device and global app state', () => {
    const targets: Record<string, TargetDetail> = {
      'release-android-wikipedia': {
        platform: 'android',
        appPackage: 'org.wikipedia.alpha',
        appActivity: 'org.wikipedia.main.MainActivity',
      },
    }

    const result = buildLiveSessionConfig({
      content: 'name: Demo\nuse:\n  device: release-android-emu\nsteps:\n  - Open the app\n',
      targetName: 'release-android-wikipedia',
      targets,
      globalUse: { mobile: { appState: 'preserve' } },
    })

    expect(result).toEqual({
      platform: 'android',
      targetName: 'release-android-wikipedia',
      useDeviceName: 'release-android-emu',
      appState: 'preserve',
      headless: undefined,
    })
  })

  it('lets draft app state override global app state and ignores global device', () => {
    const targets: Record<string, TargetDetail> = {
      'release-android-wikipedia': {
        platform: 'android',
        appPackage: 'org.wikipedia.alpha',
      },
    }
    const globalUse = {
      device: 'legacy-global-device',
      mobile: { appState: 'preserve' },
    } as unknown as GlobalUseConfig

    const result = buildLiveSessionConfig({
      content: 'name: Demo\nuse:\n  mobile:\n    appState: reset\nsteps:\n  - Open the app\n',
      targetName: 'release-android-wikipedia',
      targets,
      globalUse,
    })

    expect(result.useDeviceName).toBeUndefined()
    expect(result.appState).toBe('reset')
    expect('configDefaultDeviceName' in result).toBe(false)
  })

  it('sends no app ids or install path for a mobile target', () => {
    const targets: Record<string, TargetDetail> = {
      'release-android-wikipedia': {
        platform: 'android',
        appPackage: 'org.wikipedia.alpha',
        appActivity: 'org.wikipedia.main.MainActivity',
        app: {
          path: 'apps/wikipedia-alpha.apk',
        },
      },
    }

    const result = buildLiveSessionConfig({
      content: 'name: Demo\nuse:\n  device: release-android-emu\nsteps:\n  - Open the app\n',
      targetName: 'release-android-wikipedia',
      targets,
      globalUse: { mobile: { appState: 'reset' } },
    })

    expect(result).toEqual({
      platform: 'android',
      targetName: 'release-android-wikipedia',
      useDeviceName: 'release-android-emu',
      appState: 'reset',
      headless: undefined,
    })
  })
})

describe('buildLiveSessionConfig auth state', () => {
  const webTargets: Record<string, TargetDetail> = {
    webTarget: { platform: 'web', url: 'https://example.com' },
  }
  const androidTargets: Record<string, TargetDetail> = {
    phone: { platform: 'android', appPackage: 'org.example.shop' },
  }

  it('carries the draft use.authState name for a web target', () => {
    const result = buildLiveSessionConfig({
      content: 'name: Demo\nuse:\n  authState: buyer\nsteps:\n  - Open the page\n',
      targetName: 'webTarget',
      targets: webTargets,
      globalUse: null,
    })

    expect(result.authState).toBe('buyer')
  })

  it('carries the object form as written', () => {
    const result = buildLiveSessionConfig({
      content: 'name: Demo\nuse:\n  authState:\n    name: buyer\n    load: false\nsteps:\n  - Open the page\n',
      targetName: 'webTarget',
      targets: webTargets,
      globalUse: null,
    })

    expect(result.authState).toEqual({ name: 'buyer', load: false })
  })

  it.each([
    ['a draft with no use.authState', 'name: Demo\nsteps:\n  - Open the page\n'],
    ['a draft that does not parse', 'name: [unclosed\n'],
  ])('carries no auth state key for %s', (_label, content) => {
    const result = buildLiveSessionConfig({
      content,
      targetName: 'webTarget',
      targets: webTargets,
      globalUse: null,
    })

    expect('authState' in result).toBe(false)
  })

  it('carries the draft use.authState for a mobile target, which the server refuses as a run does', () => {
    const result = buildLiveSessionConfig({
      content: 'name: Demo\nuse:\n  authState: buyer\nsteps:\n  - Open the app\n',
      targetName: 'phone',
      targets: androidTargets,
      globalUse: null,
    })

    expect(result.authState).toBe('buyer')
  })

  it('carries no auth state key for a mobile draft that names none', () => {
    const result = buildLiveSessionConfig({
      content: 'name: Demo\nsteps:\n  - Open the app\n',
      targetName: 'phone',
      targets: androidTargets,
      globalUse: null,
    })

    expect('authState' in result).toBe(false)
  })
})

describe('readDraftAuthStateName', () => {
  it('returns the draft use.authState string', () => {
    expect(readDraftAuthStateName([
      'name: Authenticated flow',
      'use:',
      '  authState: admin',
      'steps:',
      '  - Open the dashboard',
      '',
    ].join('\n'))).toBe('admin')
  })

  it('returns the object form name', () => {
    expect(readDraftAuthStateName([
      'name: Authenticated flow',
      'use:',
      '  authState:',
      '    name: demo-acc',
      '    load: false',
      '    capture: true',
      'steps:',
      '  - Open the dashboard',
      '',
    ].join('\n'))).toBe('demo-acc')
  })

  it.each([
    ['an uppercase value', 'use:\n  authState: Admin\n', 'Admin'],
    ['a path-like value', 'use:\n  authState: ../admin.json\n', '../admin.json'],
    ['an object name with a key the schema refuses beside it', 'use:\n  authState:\n    name: admin\n    path: ../admin.json\n', 'admin'],
    ['a trimmed value', 'use:\n  authState: "  admin  "\n', 'admin'],
  ])('returns %s as written, for the capture form and the server to check', (_label, content, expected) => {
    expect(readDraftAuthStateName(content)).toBe(expected)
  })

  it.each([
    ['no value', 'name: No auth\nsteps: []\n'],
    ['an array value', 'use:\n  authState:\n    - admin\n'],
    ['an object with no name', 'use:\n  authState:\n    capture: true\n'],
    ['a draft that does not parse', 'use: [unclosed\n'],
  ])('returns null for %s', (_label, content) => {
    expect(readDraftAuthStateName(content)).toBeNull()
  })
})
