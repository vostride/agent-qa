// A fresh init that chose Android or iOS downloads the pinned Playground app in a step of its own,
// here from a fake source. A download that fails is a failed step with its reason masked, and init
// carries on to exit 3; a Ctrl-C aborts the download and ends init interrupted; and an app-bundles
// that is not a plain folder is refused before init writes anything. The next steps name the
// starter of each runtime that has a device and whose app arrived.
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'

import type { AndroidHere, IOSHere } from '@vostride/agent-qa-core'
import { afterEach, describe, expect, it } from 'vitest'
import { parse } from 'yaml'

import type { InitCommandHooks } from '../commands/init.js'
import type { InitDocument } from '../commands/init-document.js'
import { installedAgentQaVersion } from '../commands/package-json-plan.js'
import type { PlaygroundAppFetch } from '../commands/playground-app.js'
import { PLAYGROUND_APP_PATHS, PLAYGROUND_APP_PIN } from '../commands/playground-app-pin.js'
import {
  buildZip,
  cleanupTempProjects,
  fakePlaygroundApp,
  fakePlaygroundIosEntries,
  fakeRunner,
  mobileInitFakes,
  tempProject,
  writeInstalledPackage,
  type FakeRunner,
  type MobileInitFakes,
} from './project-fixtures.js'
import { rerun } from './rerun-fixtures.js'

const PLAYGROUND_EXAMPLES = [
  'tests/examples/playground-android-open-komazon.yaml',
  'tests/examples/playground-android-cart-total.yaml',
  'tests/examples/playground-android-cart-total-bug.yaml',
  'tests/examples/playground-ios-open-komazon.yaml',
  'tests/examples/playground-ios-cart-total.yaml',
  'tests/examples/playground-ios-cart-total-bug.yaml',
]
const NOT_WRITTEN = 'package.json was not written'
const PIXEL: AndroidHere = {
  attached: [],
  avds: [{ name: 'Pixel_10_Pro', profile: 'pixel_10_pro', displayName: 'Pixel 10 Pro', os: '17' }],
}
const IPHONE: IOSHere = {
  simulators: [
    {
      name: 'iPhone 18 Pro',
      udid: '0A6B5E2C-4D1F-4A9E-9C3B-2F8E7D6A5B4C',
      os: '27.0',
      state: 'Booted',
      available: true,
    },
  ],
}
const RUN_WEB_STARTER = 'npx agent-qa run tests/examples/komazon-cart-total.yaml'
const RUN_ANDROID_STARTER = 'npx agent-qa run tests/examples/playground-android-open-komazon.yaml'
const RUN_IOS_STARTER = 'npx agent-qa run tests/examples/playground-ios-open-komazon.yaml'

interface WrittenConfig {
  registry: { targets: Record<string, { app?: { path?: string } }> }
}

interface FreshInitOptions {
  fakes?: MobileInitFakes
  args?: readonly string[]
  run?: FakeRunner
  hooks?: InitCommandHooks
  plain?: boolean
  prepare?: (root: string) => void
}

afterEach(() => {
  cleanupTempProjects()
})

async function freshInit(
  platform: string,
  {
    fakes = mobileInitFakes(),
    args = ['--pm', 'none', '--no-browsers'],
    run,
    hooks = {},
    plain = false,
    prepare,
  }: FreshInitOptions = {},
) {
  const project = tempProject('playground-app')
  prepare?.(project.root)
  const result = await rerun(
    project,
    ['--json', '--platform', platform, '--llm', 'gemini', '--agents', 'none', ...args],
    { hooks: { ...fakes.hooks, ...hooks }, plain, run },
  )
  return { root: project.root, result, fakes, doc: JSON.parse(result.stdout) as InitDocument }
}

// The install and validate go through a fake runner, over the agent-qa init declares already in
// node_modules, so both are done.
function throughInstall(): Pick<FreshInitOptions, 'args' | 'run' | 'prepare'> {
  return {
    args: ['--pm', 'npm'],
    run: fakeRunner(({ args }) => ({
      code: 0,
      signal: null,
      output: args[0] === '--version' ? '10.0.0\n' : '',
    })),
    prepare: (root) => {
      writeInstalledPackage(root, 'agent-qa', installedAgentQaVersion())
    },
  }
}

function stepOf(doc: InitDocument, name: string) {
  return doc.steps.find((step) => step.name === name)
}

function appFilesOf(doc: InitDocument) {
  return doc.files.filter((file) => file.step === 'playground-app')
}

function configOf(root: string): WrittenConfig {
  return parse(readFileSync(join(root, 'agent-qa.config.yaml'), 'utf8')) as WrittenConfig
}

function sigintListeners(): ((...args: unknown[]) => void)[] {
  return process.listeners('SIGINT') as ((...args: unknown[]) => void)[]
}

function nextCommandsOf(doc: InitDocument): string[] {
  return doc.nextSteps.map((step) => step.command)
}

describe('a fresh mobile init downloads the Playground app', () => {
  it('an Android and iOS init downloads both apps into app-bundles in a step right after chromium', async () => {
    const { root, result, doc } = await freshInit('android,ios')

    expect(result.exit).toBe(0)
    expect(doc).toMatchObject({ outcome: 'done', exitCode: 0 })
    expect(stepOf(doc, 'playground-app')).toEqual({ name: 'playground-app', outcome: 'done' })
    const names = doc.steps.map((step) => step.name)
    expect(names.indexOf('playground-app')).toBe(names.indexOf('chromium') + 1)
    expect(result.entries).toContainEqual({
      kind: 'done',
      text: `Playground app: ${PLAYGROUND_APP_PATHS.android} and ${PLAYGROUND_APP_PATHS.ios}`,
    })
    const apk = readFileSync(join(root, PLAYGROUND_APP_PATHS.android))
    expect(apk).toEqual(Buffer.from(fakePlaygroundApp().bytes.android))
    for (const entry of fakePlaygroundIosEntries()) {
      if (entry.name.endsWith('/')) continue
      const file = readFileSync(join(root, 'app-bundles', entry.name))
      expect(file, entry.name).toEqual(Buffer.from(entry.bytes))
    }
    const bundled = readdirSync(join(root, 'app-bundles'), { recursive: true, encoding: 'utf8' })
    expect(bundled.filter((name) => name.endsWith('.zip'))).toEqual([])
    expect(appFilesOf(doc)).toEqual([
      { path: PLAYGROUND_APP_PATHS.android, outcome: 'created', step: 'playground-app' },
      { path: PLAYGROUND_APP_PATHS.ios, outcome: 'created', step: 'playground-app' },
    ])
  })

  it('an Android init requests only the Android file and writes nothing for iOS', async () => {
    const { root, result, fakes, doc } = await freshInit('android')

    expect(result.exit).toBe(0)
    expect(fakes.requests.map((request) => request.url.split('/').at(-1))).toEqual([
      PLAYGROUND_APP_PIN.android.file,
    ])
    expect(result.entries).toContainEqual({
      kind: 'done',
      text: `Playground app: ${PLAYGROUND_APP_PATHS.android}`,
    })
    expect(appFilesOf(doc)).toEqual([
      { path: PLAYGROUND_APP_PATHS.android, outcome: 'created', step: 'playground-app' },
    ])
    expect(existsSync(join(root, PLAYGROUND_APP_PATHS.ios))).toBe(false)
  })

  it('a web init has no Playground step and requests nothing', async () => {
    const { root, result, fakes, doc } = await freshInit('web')

    expect(result.exit).toBe(0)
    expect(doc.steps.map((step) => step.name)).not.toContain('playground-app')
    expect(fakes.requests).toEqual([])
    expect(existsSync(join(root, 'app-bundles'))).toBe(false)
  })

  it('an Android file whose sha256 is not the pinned one fails the step, and init carries on through validate to exit 3', async () => {
    const fakes = mobileInitFakes({}, { android: new TextEncoder().encode('another build\n') })
    const { root, result, doc } = await freshInit('android,ios', { fakes, ...throughInstall() })

    expect(result.exit).toBe(3)
    expect(doc).toMatchObject({ outcome: 'failed', exitCode: 3 })
    const step = stepOf(doc, 'playground-app')
    expect(step).toEqual({ name: 'playground-app', outcome: 'failed', reason: expect.any(String) })
    expect(step).not.toHaveProperty('command')
    expect(step?.reason).toContain(PLAYGROUND_APP_PIN.android.file)
    expect(step?.reason).toContain(PLAYGROUND_APP_PIN.tag)
    expect(result.entries).toContainEqual({ kind: 'failed', text: step?.reason })
    expect(doc.nextSteps.map((next) => next.description)).not.toContain(
      'Download the Playground app',
    )
    expect(stepOf(doc, 'validate')).toEqual({ name: 'validate', outcome: 'done' })
    const { targets } = configOf(root).registry
    expect(targets['playground-android']?.app?.path).toBe(PLAYGROUND_APP_PATHS.android)
    expect(targets['playground-ios']?.app?.path).toBe(PLAYGROUND_APP_PATHS.ios)
    for (const path of PLAYGROUND_EXAMPLES) {
      expect(existsSync(join(root, path)), path).toBe(true)
    }
    expect(existsSync(join(root, PLAYGROUND_APP_PATHS.android))).toBe(false)
    expect(existsSync(join(root, PLAYGROUND_APP_PATHS.ios))).toBe(true)
    expect(appFilesOf(doc)).toEqual([
      { path: PLAYGROUND_APP_PATHS.ios, outcome: 'created', step: 'playground-app' },
    ])
  })

  it('a fetch that rejects with a TypeError fails the step without stopping init as a bug', async () => {
    const offline = new TypeError('fetch failed', {
      cause: new Error('getaddrinfo ENOTFOUND github.com'),
    })
    const fakes = mobileInitFakes({}, { android: offline, ios: offline })
    const { root, result, doc } = await freshInit('android,ios', {
      fakes,
      ...throughInstall(),
      // The real pin's sizes make the title; the fetch rejects before any sha256 is compared.
      hooks: { playgroundApp: { ...fakes.hooks.playgroundApp, pin: PLAYGROUND_APP_PIN } },
    })

    expect(result.exit).toBe(3)
    expect(doc).toMatchObject({ outcome: 'failed', exitCode: 3 })
    expect(doc).not.toHaveProperty('message')
    expect(result.entries).toContainEqual({
      kind: 'step',
      text: 'Downloading the Playground app (66 MB)',
    })
    const step = stepOf(doc, 'playground-app')
    expect(step).toEqual({ name: 'playground-app', outcome: 'failed', reason: expect.any(String) })
    const said = 'was not downloaded: fetch failed (getaddrinfo ENOTFOUND github.com). It is '
    expect(step?.reason?.split('\n')).toEqual([
      expect.stringContaining(`The Playground app for Android ${said}`),
      expect.stringContaining(`The Playground app for iOS ${said}`),
    ])
    expect(stepOf(doc, 'skills')).toEqual({
      name: 'skills',
      outcome: 'skipped',
      reason: 'none chosen',
    })
    expect(stepOf(doc, 'validate')).toEqual({ name: 'validate', outcome: 'done' })
    expect(existsSync(join(root, 'agent-qa.config.yaml'))).toBe(true)
    for (const path of PLAYGROUND_EXAMPLES) {
      expect(existsSync(join(root, path)), path).toBe(true)
    }
    expect(existsSync(join(root, 'app-bundles'))).toBe(false)
  })

  it('keeps an Android app that is already at its path and requests nothing', async () => {
    const kept = 'an APK that was here before init\n'
    const { root, result, fakes, doc } = await freshInit('android', {
      prepare: (folder) => {
        const apk = join(folder, PLAYGROUND_APP_PATHS.android)
        mkdirSync(dirname(apk), { recursive: true })
        writeFileSync(apk, kept)
      },
    })

    expect(result.exit).toBe(0)
    expect(fakes.requests).toEqual([])
    expect(stepOf(doc, 'playground-app')).toEqual({ name: 'playground-app', outcome: 'done' })
    expect(appFilesOf(doc)).toEqual([
      { path: PLAYGROUND_APP_PATHS.android, outcome: 'kept', step: 'playground-app' },
    ])
    expect(readFileSync(join(root, PLAYGROUND_APP_PATHS.android), 'utf8')).toBe(kept)
  })

  it('an iOS build whose file cannot be written fails the step and leaves no Playground.app, and a forced init then downloads the build', async () => {
    const text = (value: string) => new TextEncoder().encode(value)
    // A file at Info.plist and a file under it: the second cannot be written once the first is.
    const crafted = buildZip([
      { name: 'Playground.app/Info.plist', bytes: text('a stand-in for the Info.plist\n') },
      { name: 'Playground.app/Info.plist/inner', bytes: text('a file under a file\n') },
    ])
    const fakes = mobileInitFakes({ ios: IPHONE }, { ios: crafted })
    const { pin } = fakes.hooks.playgroundApp
    const craftedPin = {
      ...pin,
      ios: {
        ...pin.ios,
        sha256: createHash('sha256').update(crafted).digest('hex'),
        bytes: crafted.byteLength,
      },
    }
    const project = tempProject('playground-app')
    const args = ['--json', '--platform', 'ios', '--llm', 'gemini', '--agents', 'none']
    const quick = ['--pm', 'none', '--no-browsers']

    const failed = await rerun(project, [...args, ...quick], {
      hooks: { ...fakes.hooks, playgroundApp: { ...fakes.hooks.playgroundApp, pin: craftedPin } },
    })

    const failedDoc = JSON.parse(failed.stdout) as InitDocument
    expect(failed.exit).toBe(3)
    expect(stepOf(failedDoc, 'playground-app')).toEqual({
      name: 'playground-app',
      outcome: 'failed',
      reason: expect.stringMatching(/^The Playground app for iOS was not downloaded: /u),
    })
    expect(appFilesOf(failedDoc)).toEqual([])
    expect(readdirSync(join(project.root, 'app-bundles'))).toEqual([])
    expect(nextCommandsOf(failedDoc)).not.toContain(RUN_IOS_STARTER)

    const again = mobileInitFakes({ ios: IPHONE })
    const forced = await rerun(project, [...args, ...quick, '--force'], { hooks: again.hooks })

    const forcedDoc = JSON.parse(forced.stdout) as InitDocument
    expect(forced.exit).toBe(0)
    expect(again.requests.map((request) => request.url.split('/').at(-1))).toEqual([
      PLAYGROUND_APP_PIN.ios.file,
    ])
    expect(appFilesOf(forcedDoc)).toEqual([
      { path: PLAYGROUND_APP_PATHS.ios, outcome: 'created', step: 'playground-app' },
    ])
    expect(readdirSync(join(project.root, 'app-bundles'))).toEqual(['Playground.app'])
    expect(nextCommandsOf(forcedDoc)).toContain(RUN_IOS_STARTER)
  })

  it("adds no app-bundles line to the project's .gitignore", async () => {
    const { root, result } = await freshInit('android,ios')

    expect(result.exit).toBe(0)
    expect(existsSync(join(root, PLAYGROUND_APP_PATHS.android))).toBe(true)
    const lines = readFileSync(join(root, '.gitignore'), 'utf8').split('\n')
    expect(lines.filter((line) => line.includes('app-bundles'))).toEqual([])
  })

  it('skips the step between the Chromium and coding agents lines when package.json was not written', async () => {
    const { result, fakes, doc } = await freshInit('android', {
      plain: true,
      hooks: {
        afterWrite: (written) => {
          if (written.path.endsWith('package.json')) throw new Error('EACCES: permission denied')
        },
      },
    })

    expect(result.exit).toBe(3)
    expect(result.stderr).toContain(
      `– Chromium: skipped (${NOT_WRITTEN})\n` +
        `– Playground app: skipped (${NOT_WRITTEN})\n` +
        `– Coding agents: skipped (${NOT_WRITTEN})\n`,
    )
    expect(stepOf(doc, 'playground-app')).toEqual({
      name: 'playground-app',
      outcome: 'skipped',
      reason: NOT_WRITTEN,
    })
    expect(fakes.requests).toEqual([])
  })

  it('a Ctrl-C during the download aborts the request, and init ends interrupted with exit 130', async () => {
    const before = sigintListeners()
    const fakes = mobileInitFakes()
    const handed: AbortSignal[] = []
    // A person's Ctrl-C arrives while the request is in flight.
    const interrupted: PlaygroundAppFetch = async (request) => {
      handed.push(request.signal)
      for (const listener of sigintListeners()) {
        if (!before.includes(listener)) listener('SIGINT')
      }
      if (request.signal.aborted) throw request.signal.reason
      return await fakes.hooks.playgroundApp.fetch(request)
    }

    const { result, doc } = await freshInit('android', {
      fakes,
      hooks: { playgroundApp: { ...fakes.hooks.playgroundApp, fetch: interrupted } },
    })

    expect(handed.map((signal) => signal.aborted)).toEqual([true])
    expect(result.exit).toBe(130)
    expect(doc).toMatchObject({ outcome: 'interrupted', exitCode: 130 })
    expect(stepOf(doc, 'playground-app')).toEqual({
      name: 'playground-app',
      outcome: 'failed',
      reason: 'interrupted',
    })
    expect(sigintListeners()).toEqual(before)
  })

  it('refuses an app-bundles that links out of the project before writing anything', async () => {
    const outside = join(tempProject('playground-app-outside').root, 'elsewhere')
    mkdirSync(outside)

    const { root, result, fakes, doc } = await freshInit('android', {
      prepare: (folder) => {
        symlinkSync(outside, join(folder, 'app-bundles'), 'dir')
      },
    })

    expect(result.exit).toBe(2)
    expect(doc).toMatchObject({ outcome: 'refused', exitCode: 2 })
    expect(doc.message).toMatch(
      /^Refusing init destination .+: symbolic link parent .+app-bundles$/u,
    )
    expect(existsSync(join(root, 'agent-qa.config.yaml'))).toBe(false)
    expect(existsSync(join(root, 'package.json'))).toBe(false)
    expect(readdirSync(outside)).toEqual([])
    expect(fakes.requests).toEqual([])
  })

  it('refuses a Playground.app that is a file before writing anything', async () => {
    const { root, result, fakes, doc } = await freshInit('ios', {
      prepare: (folder) => {
        mkdirSync(join(folder, 'app-bundles'))
        writeFileSync(join(folder, PLAYGROUND_APP_PATHS.ios), 'not a folder\n')
      },
    })

    expect(result.exit).toBe(2)
    expect(doc).toMatchObject({ outcome: 'refused', exitCode: 2 })
    expect(doc.message).toMatch(/^Refusing init destination .+ parent .+Playground\.app$/u)
    expect(existsSync(join(root, 'agent-qa.config.yaml'))).toBe(false)
    expect(existsSync(join(root, 'package.json'))).toBe(false)
    expect(readFileSync(join(root, PLAYGROUND_APP_PATHS.ios), 'utf8')).toBe('not a folder\n')
    expect(fakes.requests).toEqual([])
  })

  it("shows a declared secret in a failed download's reason by its name, not its value", async () => {
    const secret = 'pr0xy-t0ken-in-an-error'
    const refused = new TypeError('fetch failed', {
      cause: new Error(`the proxy refused ${secret}`),
    })
    const fakes = mobileInitFakes({}, { android: refused })

    const { result, doc } = await freshInit('android', {
      fakes,
      prepare: (folder) => {
        writeFileSync(join(folder, '.env.secrets.local'), `PROXY_TOKEN=${secret}\n`)
      },
    })

    expect(result.exit).toBe(3)
    const step = stepOf(doc, 'playground-app')
    expect(step).toEqual({ name: 'playground-app', outcome: 'failed', reason: expect.any(String) })
    expect(step?.reason).toContain('fetch failed (the proxy refused [secret:PROXY_TOKEN])')
    expect(step?.reason).not.toContain(secret)
    expect(result.entries).toContainEqual({ kind: 'failed', text: step?.reason })
    expect(result.stdout).not.toContain(secret)
  })
})

describe('the next steps after a fresh mobile init', () => {
  it('name the web starter, then the Android starter, then the iOS starter, and only files in the project', async () => {
    const fakes = mobileInitFakes({ android: PIXEL, ios: IPHONE })
    const { root, result, doc } = await freshInit('web,android,ios', { fakes })

    expect(result.exit).toBe(0)
    const commands = nextCommandsOf(doc)
    const starters = [RUN_WEB_STARTER, RUN_ANDROID_STARTER, RUN_IOS_STARTER]
    expect(commands.filter((command) => starters.includes(command))).toEqual(starters)
    const named = commands.flatMap(
      (command) => command.match(/\b(?:tests|suites|scripts)\/[\w./-]+/gu) ?? [],
    )
    for (const path of named) {
      expect(existsSync(join(root, path)), `the next steps name ${path}`).toBe(true)
    }
  })

  it('name no starter for a runtime with no device', async () => {
    const fakes = mobileInitFakes({ android: PIXEL })
    const { result, doc } = await freshInit('android,ios', { fakes })

    expect(result.exit).toBe(0)
    expect(stepOf(doc, 'playground-app')).toEqual({ name: 'playground-app', outcome: 'done' })
    expect(doc.nextSteps).toContainEqual({
      command: RUN_ANDROID_STARTER,
      description: 'Start with the two-step test, which passes:',
    })
    expect(nextCommandsOf(doc)).not.toContain(RUN_IOS_STARTER)
  })

  it('name no starter for a runtime whose app did not arrive, and no command for the app', async () => {
    const fakes = mobileInitFakes(
      { android: PIXEL, ios: IPHONE },
      { android: new TextEncoder().encode('another build\n') },
    )
    const { result, doc } = await freshInit('android,ios', { fakes })

    expect(result.exit).toBe(3)
    expect(stepOf(doc, 'playground-app')?.outcome).toBe('failed')
    const commands = nextCommandsOf(doc)
    expect(commands).toContain(RUN_IOS_STARTER)
    expect(commands).not.toContain(RUN_ANDROID_STARTER)
    expect(commands.filter((command) => command.includes('app-bundles'))).toEqual([])
  })
})
