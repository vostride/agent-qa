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

  it('builds an iOS mobile bootstrap payload without target device settings', () => {
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
      bundleId: 'org.reactjs.native.example.wdiodemoapp',
      appPackage: undefined,
      appActivity: undefined,
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

    expect(result).toMatchObject({
      platform: 'android',
      targetName: 'release-android-wikipedia',
      useDeviceName: 'release-android-emu',
      appState: 'preserve',
      appPackage: 'org.wikipedia.alpha',
      appActivity: 'org.wikipedia.main.MainActivity',
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

  it('keeps mobile app install fields server-side for live bootstrap', () => {
    const targets: Record<string, TargetDetail> = {
      'release-android-wikipedia': {
        platform: 'android',
        appPackage: 'org.wikipedia.alpha',
        appActivity: 'org.wikipedia.main.MainActivity',
        app: {
          path: 'apps/wikipedia-alpha.apk',
          browserstack: 'bs://uploaded-app',
        },
      },
    }

    const result = buildLiveSessionConfig({
      content: 'name: Demo\nuse:\n  device: release-android-emu\nsteps:\n  - Open the app\n',
      targetName: 'release-android-wikipedia',
      targets,
      globalUse: { mobile: { appState: 'reset' } },
    })

    expect(result).toMatchObject({
      platform: 'android',
      targetName: 'release-android-wikipedia',
      useDeviceName: 'release-android-emu',
      appState: 'reset',
      appPackage: 'org.wikipedia.alpha',
      appActivity: 'org.wikipedia.main.MainActivity',
    })
    expect('appPath' in result).toBe(false)
    expect('browserstackApp' in result).toBe(false)
  })
})

describe('readDraftAuthStateName', () => {
  it('returns a valid draft use.authState slug', () => {
    expect(readDraftAuthStateName([
      'name: Authenticated flow',
      'use:',
      '  authState: admin',
      'steps:',
      '  - Open the dashboard',
      '',
    ].join('\n'))).toBe('admin')
  })

  it('returns a valid draft use.authState.name slug from object form', () => {
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
    ['missing value', 'name: No auth\nsteps: []\n', ''],
    ['uppercase value', 'use:\n  authState: Admin\n', 'Admin'],
    ['slash value', 'use:\n  authState: admin/state\n', 'admin/state'],
    ['path-like value', 'use:\n  authState: ../admin.json\n', '../admin.json'],
    ['uppercase object name', 'use:\n  authState:\n    name: Admin\n', 'Admin'],
    ['path-like object name', 'use:\n  authState:\n    name: ../admin.json\n', '../admin.json'],
    ['array value', 'use:\n  authState:\n    - admin\n', 'admin'],
    ['missing object name', 'use:\n  authState:\n    capture: true\n', 'capture'],
    ['unsafe object', 'use:\n  authState:\n    name: admin\n    path: ../admin.json\n', '../admin.json'],
    ['unsafe load value', 'use:\n  authState:\n    name: admin\n    load: sometimes\n', 'sometimes'],
  ])('returns null for %s without echoing unsafe input', (_label, content, unsafeValue) => {
    const result = readDraftAuthStateName(content)

    expect(result).toBeNull()
    if (unsafeValue) {
      expect(JSON.stringify(result)).not.toContain(unsafeValue)
    }
  })
})
