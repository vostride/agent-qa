// A fresh init that chose Android or iOS downloads the pinned Playground app in a step of its own,
// here from a fake source. A download that fails is a failed step, and init carries on to exit 3;
// a Ctrl-C aborts the download and ends init interrupted.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'
import { parse } from 'yaml'

import type { InitCommandHooks } from '../commands/init.js'
import type { InitDocument } from '../commands/init-document.js'
import { installedAgentQaVersion } from '../commands/package-json-plan.js'
import type { PlaygroundAppFetch } from '../commands/playground-app.js'
import { PLAYGROUND_APP_PATHS, PLAYGROUND_APP_PIN } from '../commands/playground-app-pin.js'
import {
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
    const offline = new TypeError('fetch failed')
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
    expect(step?.reason?.split('\n')).toEqual([
      expect.stringMatching(/^The Playground app for Android was not downloaded: fetch failed\. /u),
      expect.stringMatching(/^The Playground app for iOS was not downloaded: fetch failed\. /u),
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
})
