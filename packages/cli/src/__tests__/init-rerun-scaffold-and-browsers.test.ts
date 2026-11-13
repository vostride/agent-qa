// A re-run's browsers and scaffold rows: what pre-checks them, what running them does, and when
// they are hidden. A re-run writes no Playground example, requests no Playground app and lists no
// device; init --force is a fresh init, so it requests the app again and replaces the one there.
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { stripVTControlCharacters } from 'node:util'

import { getAgentQaVersion, type AndroidHere } from '@vostride/agent-qa-core'
import { isNode, parseDocument } from 'yaml'
import { afterEach, describe, expect, it } from 'vitest'

import type { ChromiumResolver } from '../commands/browser-resolver.js'
import type { InitDocument } from '../commands/init-document.js'
import { EXAMPLE_PATHS } from '../commands/init-next-steps.js'
import { SETUP_MENU_QUESTION } from '../commands/init-rerun.js'
import { PLAYGROUND_APP_PATHS, playgroundAppUrl } from '../commands/playground-app-pin.js'
import type { FakeInitUiEntry } from './fake-init-ui.js'
import {
  cleanupTempProjects,
  fakePlaygroundApp,
  fakeRunner,
  mobileInitFakes,
} from './project-fixtures.js'
import {
  installAgentQaFixture,
  initializedProject,
  noChromium,
  rerun,
  type InitializedProject,
} from './rerun-fixtures.js'

const VERSION = getAgentQaVersion().trim()
const asked = { hooks: { isTTY: true } }

afterEach(() => {
  cleanupTempProjects()
})

function menuOf(
  entries: readonly FakeInitUiEntry[],
): Extract<FakeInitUiEntry, { kind: 'multiselect' }> | undefined {
  const entry = entries.find(
    (item) => item.kind === 'multiselect' && item.text === SETUP_MENU_QUESTION,
  )
  return entry?.kind === 'multiselect' ? entry : undefined
}

function labelOf(entries: readonly FakeInitUiEntry[], name: string): string {
  return menuOf(entries)?.labels.find((label) => label.startsWith(`${name} `)) ?? `no ${name} row`
}

function setupRow(doc: InitDocument, name: string): unknown {
  return doc.setup?.find((row) => row.name === name) ?? `no ${name} row`
}

function stepOf(doc: InitDocument, name: string): unknown {
  return doc.steps.find((step) => step.name === name) ?? `no ${name} step`
}

function editConfig(root: string, change: (doc: ReturnType<typeof parseDocument>) => void): void {
  const path = join(root, 'agent-qa.config.yaml')
  const doc = parseDocument(readFileSync(path, 'utf8'))
  change(doc)
  writeFileSync(path, doc.toString())
}

function everyWebRunRemote(project: InitializedProject): void {
  editConfig(project.root, (doc) => {
    doc.setIn(['use', 'browser', 'remote'], 'hyperbrowser')
  })
}

function browserInstalls(run: ReturnType<typeof fakeRunner>): string[][] {
  return run.calls.filter((call) => call.args.includes('install-browsers')).map((call) => call.args)
}

function refusalLines(stderr: string): string[] {
  return stripVTControlCharacters(stderr)
    .split('\n')
    .filter((line) => line !== '')
}

describe("a re-run's browsers row", () => {
  it("labels a missing Chromium as no Chromium for agent-qa's Playwright and pre-checks it", async () => {
    const project = await initializedProject('rerun-browsers-missing')

    const result = await rerun(project, [], { hooks: { isTTY: true, chromium: noChromium } })

    expect(result.exit, result.stderr).toBe(0)
    expect(labelOf(result.entries, 'browsers')).toBe(
      "browsers   no Chromium for agent-qa's Playwright",
    )
    expect(menuOf(result.entries)?.initialValues ?? 'no menu').toContain('browsers')
  })

  it('with --yes installs Chromium through agent-qa and records the row done', async () => {
    const project = await initializedProject('rerun-browsers-installs')
    const run = fakeRunner()

    const result = await rerun(project, ['--yes', '--json'], {
      plain: true,
      run,
      hooks: { chromium: noChromium },
    })

    expect(result.exit, result.stderr).toBe(0)
    expect(browserInstalls(run).map((args) => args.slice(1))).toEqual([
      ['install-browsers', '--chromium'],
    ])
    expect(stepOf(JSON.parse(result.stdout) as InitDocument, 'browsers')).toEqual({
      name: 'browsers',
      outcome: 'done',
    })
  })

  it('tries the Chromium install a second time when the first attempt fails', async () => {
    const project = await initializedProject('rerun-browsers-retries')
    let attempts = 0
    const run = fakeRunner(({ args }) => {
      if (!args.includes('install-browsers')) return { code: 0, signal: null, output: '' }
      attempts += 1
      return { code: attempts === 1 ? 1 : 0, signal: null, output: 'download failed\n' }
    })

    const result = await rerun(project, ['--yes'], { run, hooks: { chromium: noChromium } })

    expect(result.exit, result.stderr).toBe(0)
    expect(browserInstalls(run)).toHaveLength(2)
    expect(result.entries).toContainEqual({ kind: 'done', text: 'browsers: Chromium installed' })
  })

  it('fails the row with the install command after two failed attempts, and exits 3', async () => {
    const project = await initializedProject('rerun-browsers-fails')
    const run = fakeRunner(({ args }) =>
      args.includes('install-browsers')
        ? { code: 1, signal: null, output: 'download failed\n' }
        : { code: 0, signal: null, output: '' },
    )

    const result = await rerun(project, ['--yes', '--json'], {
      plain: true,
      run,
      hooks: { chromium: noChromium },
    })

    expect(result.exit, result.stderr).toBe(3)
    expect(browserInstalls(run)).toHaveLength(2)
    expect(stepOf(JSON.parse(result.stdout) as InitDocument, 'browsers')).toEqual({
      name: 'browsers',
      outcome: 'failed',
      reason: 'Chromium download failed twice: download failed',
      command: 'npx agent-qa install-browsers --chromium',
    })
  })

  it('says Chromium found and leaves the row unchecked when the resolver finds it', async () => {
    const project = await initializedProject('rerun-browsers-found')

    const result = await rerun(project, [], asked)

    expect(result.exit, result.stderr).toBe(0)
    expect(labelOf(result.entries, 'browsers')).toBe('browsers   Chromium found')
    expect(menuOf(result.entries)?.initialValues ?? 'no menu').not.toContain('browsers')
  })

  it('says every web run uses a remote and leaves the row unchecked without asking the resolver', async () => {
    const project = await initializedProject('rerun-browsers-remote')
    everyWebRunRemote(project)
    const asks: string[] = []
    const chromium: ChromiumResolver = () => {
      asks.push('asked')
      return { found: false, reason: 'no file' }
    }

    const result = await rerun(project, [], { hooks: { isTTY: true, chromium } })

    expect(result.exit, result.stderr).toBe(0)
    expect(labelOf(result.entries, 'browsers')).toBe('browsers   every web run uses a remote')
    expect(menuOf(result.entries)?.initialValues ?? 'no menu').not.toContain('browsers')
    expect(asks).toEqual([])
  })

  it("asks the resolver with the real folder of the project's installed agent-qa", async () => {
    const project = await initializedProject('rerun-browsers-project-copy')
    installAgentQaFixture(project.root, VERSION)
    const asks: unknown[] = []
    const chromium: ChromiumResolver = (options) => {
      asks.push(options)
      return { found: true, path: '/fake/chromium' }
    }

    const result = await rerun(project, ['--yes'], { hooks: { chromium } })

    expect(result.exit, result.stderr).toBe(0)
    expect(asks).toEqual([
      { projectAgentQaDir: realpathSync(join(project.root, 'node_modules', 'agent-qa')) },
    ])
  })
})

describe('a re-run over a target that is not a mapping', () => {
  it('runs its rows and validate, and prints no crash', async () => {
    const project = await initializedProject('rerun-target-not-a-mapping')
    editConfig(project.root, (doc) => {
      doc.setIn(['registry', 'targets', 'broken'], null)
    })

    const result = await rerun(project, ['--yes', '--json'])

    expect(result.stderr).not.toContain('TypeError')
    const doc = JSON.parse(result.stdout) as InitDocument
    expect(doc.message).toBeUndefined()
    expect(stepOf(doc, 'validate')).toMatchObject({ name: 'validate' })
  })
})

describe('a browsers row that cannot apply', () => {
  it('is hidden in a project with no web target and recorded hidden in the document', async () => {
    const project = await initializedProject('rerun-browsers-mobile', { platform: 'android' })

    const result = await rerun(project, ['--json'], {
      plain: true,
      hooks: { chromium: noChromium },
    })

    expect(result.exit, result.stderr).toBe(0)
    const doc = JSON.parse(result.stdout) as InitDocument
    expect(setupRow(doc, 'browsers')).toEqual({
      name: 'browsers',
      state: 'no web target',
      prechecked: false,
      selected: false,
      hidden: 'no web target',
    })
    expect(stepOf(doc, 'browsers')).toBe('no browsers step')
  })

  it('named in --setup is skipped with its reason in the step line and the document, exit 0', async () => {
    const project = await initializedProject('rerun-browsers-mobile-setup', { platform: 'android' })
    const run = fakeRunner()

    const result = await rerun(project, ['--setup', 'browsers'], {
      run,
      hooks: { chromium: noChromium },
    })
    const json = await rerun(project, ['--setup', 'browsers', '--json'], {
      plain: true,
      run,
      hooks: { chromium: noChromium },
    })

    expect(result.exit, result.stderr).toBe(0)
    expect(result.entries).toContainEqual({
      kind: 'skipped',
      text: 'browsers: skipped (no web target)',
    })
    expect(json.exit, json.stderr).toBe(0)
    expect(stepOf(JSON.parse(json.stdout) as InitDocument, 'browsers')).toEqual({
      name: 'browsers',
      outcome: 'skipped',
      reason: 'no web target',
    })
    expect(browserInstalls(run)).toEqual([])
  })

  it('is left out of --setup all', async () => {
    const project = await initializedProject('rerun-browsers-mobile-all', { platform: 'android' })
    const run = fakeRunner()

    const result = await rerun(project, ['--setup', 'all', '--json'], {
      plain: true,
      run,
      hooks: { chromium: noChromium },
    })

    expect(result.exit, result.stderr).toBe(0)
    expect(stepOf(JSON.parse(result.stdout) as InitDocument, 'browsers')).toBe('no browsers step')
    expect(browserInstalls(run)).toEqual([])
  })
})

describe('--no-browsers on a re-run', () => {
  it('leaves a missing Chromium unchecked', async () => {
    const project = await initializedProject('rerun-no-browsers-unchecked')

    const result = await rerun(project, ['--no-browsers'], {
      hooks: { isTTY: true, chromium: noChromium },
    })

    expect(result.exit, result.stderr).toBe(0)
    expect(labelOf(result.entries, 'browsers')).toBe(
      "browsers   no Chromium for agent-qa's Playwright",
    )
    expect(menuOf(result.entries)?.initialValues ?? 'no menu').not.toContain('browsers')
  })

  it('leaves browsers out of --setup all and skips it as --no-browsers', async () => {
    const project = await initializedProject('rerun-no-browsers-all')
    const run = fakeRunner()

    const result = await rerun(project, ['--setup', 'all', '--no-browsers', '--json'], {
      plain: true,
      run,
      hooks: { chromium: noChromium },
    })

    expect(result.exit, result.stderr).toBe(0)
    const doc = JSON.parse(result.stdout) as InitDocument
    expect(setupRow(doc, 'browsers')).toMatchObject({ prechecked: false, selected: false })
    expect(stepOf(doc, 'browsers')).toMatchObject({ outcome: 'skipped', reason: '--no-browsers' })
    expect(browserInstalls(run)).toEqual([])
  })

  it('with --setup browsers is refused with one line, exit 2, drawing nothing', async () => {
    const project = await initializedProject('rerun-no-browsers-setup-refused')

    const result = await rerun(project, ['--setup', 'browsers', '--no-browsers'], {
      hooks: { isTTY: true, chromium: noChromium },
    })

    expect(result.exit).toBe(2)
    expect(refusalLines(result.stderr)).toEqual([
      '--setup browsers asks for Chromium and --no-browsers refuses it; drop one of them.',
    ])
    expect(result.entries).toEqual([])
  })
})

const EXAMPLE_FILES = [
  'tests/examples/komazon-checkout.yaml',
  'suites/examples.suite.yaml',
  'scripts/examples/make-shipping-address.mjs',
] as const

function snapshot(root: string): Record<string, string> {
  const files: Record<string, string> = {}
  for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue
    const path = join(entry.parentPath, entry.name)
    files[path] = readFileSync(path, 'base64')
  }
  return files
}

describe("a re-run's scaffold row", () => {
  it('pre-checks the row and names the file when hooks.yaml was deleted', async () => {
    const project = await initializedProject('rerun-scaffold-hooks-missing')
    unlinkSync(join(project.root, 'hooks.yaml'))

    const result = await rerun(project, [], asked)

    expect(result.exit, result.stderr).toBe(0)
    expect(labelOf(result.entries, 'scaffold')).toBe('scaffold   hooks.yaml missing')
    expect(menuOf(result.entries)?.initialValues ?? 'no menu').toContain('scaffold')
  })

  it("with --yes writes every missing scaffold file and keeps every existing file's bytes", async () => {
    const project = await initializedProject('rerun-scaffold-writes-missing')
    const hooks = readFileSync(join(project.root, 'hooks.yaml'), 'utf8')
    const script = readFileSync(join(project.root, EXAMPLE_FILES[2]), 'utf8')
    unlinkSync(join(project.root, 'hooks.yaml'))
    unlinkSync(join(project.root, EXAMPLE_FILES[2]))
    writeFileSync(join(project.root, EXAMPLE_FILES[0]), 'name: my own checkout\n')
    writeFileSync(join(project.root, '.env'), 'MY_OWN=1\n')
    const before = snapshot(project.root)

    const result = await rerun(project, ['--yes', '--json'], { plain: true })

    expect(result.exit, result.stderr).toBe(0)
    expect(readFileSync(join(project.root, 'hooks.yaml'), 'utf8')).toBe(hooks)
    expect(readFileSync(join(project.root, EXAMPLE_FILES[2]), 'utf8')).toBe(script)
    const after = snapshot(project.root)
    for (const [path, bytes] of Object.entries(before)) expect(after[path], path).toBe(bytes)
    const doc = JSON.parse(result.stdout) as InitDocument
    expect(stepOf(doc, 'scaffold')).toEqual({ name: 'scaffold', outcome: 'done' })
    expect(doc.files.filter((file) => file.step === 'scaffold')).toEqual([
      { path: 'hooks.yaml', outcome: 'created', step: 'scaffold' },
      { path: EXAMPLE_FILES[2], outcome: 'created', step: 'scaffold' },
    ])
  })

  it('leaves the row unchecked when only examples and knowledge docs are missing', async () => {
    const project = await initializedProject('rerun-scaffold-examples-missing')
    for (const path of EXAMPLE_FILES) unlinkSync(join(project.root, path))
    unlinkSync(join(project.root, 'agent-qa-knowledge', 'README.md'))
    unlinkSync(join(project.root, 'agent-qa-knowledge', 'policies', 'global.md'))

    const result = await rerun(project, [], asked)

    expect(result.exit, result.stderr).toBe(0)
    expect(labelOf(result.entries, 'scaffold')).toBe('scaffold   nothing needed is missing')
    expect(menuOf(result.entries)?.initialValues ?? 'no menu').not.toContain('scaffold')
    for (const path of EXAMPLE_FILES) expect(existsSync(join(project.root, path))).toBe(false)
  })

  it('checked, writes the deleted examples and knowledge docs back', async () => {
    const project = await initializedProject('rerun-scaffold-examples-back')
    const readme = join(project.root, 'agent-qa-knowledge', 'README.md')
    const texts = EXAMPLE_FILES.map((path) => readFileSync(join(project.root, path), 'utf8'))
    const readmeText = readFileSync(readme, 'utf8')
    for (const path of EXAMPLE_FILES) unlinkSync(join(project.root, path))
    unlinkSync(readme)

    const result = await rerun(project, ['--setup', 'scaffold'])

    expect(result.exit, result.stderr).toBe(0)
    expect(EXAMPLE_FILES.map((path) => readFileSync(join(project.root, path), 'utf8'))).toEqual(
      texts,
    )
    expect(readFileSync(readme, 'utf8')).toBe(readmeText)
    expect(result.entries).toContainEqual({ kind: 'done', text: 'scaffold: wrote 4 files' })
  })

  it('reads the hooks file the config points at, and writes the scaffold hooks there', async () => {
    const project = await initializedProject('rerun-scaffold-custom-hooks')
    const hooks = readFileSync(join(project.root, 'hooks.yaml'), 'utf8')
    editConfig(project.root, (doc) => {
      doc.setIn(['workspace', 'hooksFile'], 'hooks/custom.yaml')
    })

    const menu = await rerun(project, [], { ...asked, answers: { [SETUP_MENU_QUESTION]: [] } })
    const result = await rerun(project, ['--yes'])

    expect(menu.exit, menu.stderr).toBe(0)
    expect(labelOf(menu.entries, 'scaffold')).toBe('scaffold   hooks/custom.yaml missing')
    expect(menuOf(menu.entries)?.initialValues ?? 'no menu').toContain('scaffold')
    expect(result.exit, result.stderr).toBe(0)
    expect(readFileSync(join(project.root, 'hooks', 'custom.yaml'), 'utf8')).toBe(hooks)
    expect(readFileSync(join(project.root, 'hooks.yaml'), 'utf8')).toBe(hooks)
  })

  it('leaves a missing secrets file the config points outside the project out of the row', async () => {
    const project = await initializedProject('rerun-scaffold-outside-secrets')
    const outside = join(project.home, 'secrets', '.env.secrets.local')
    editConfig(project.root, (doc) => {
      doc.setIn(['workspace', 'secretsFile'], outside)
    })

    const menu = await rerun(project, [], { ...asked, answers: { [SETUP_MENU_QUESTION]: [] } })
    const result = await rerun(project, ['--yes', '--json'])

    expect(menu.exit, menu.stderr).toBe(0)
    expect(labelOf(menu.entries, 'scaffold')).toBe('scaffold   nothing missing')
    expect(menuOf(menu.entries)?.initialValues ?? 'no menu').not.toContain('scaffold')
    const doc = JSON.parse(result.stdout) as InitDocument
    expect(stepOf(doc, 'scaffold')).toEqual({
      name: 'scaffold',
      outcome: 'skipped',
      reason: 'current',
    })
    expect(existsSync(outside)).toBe(false)
  })

  it('writes a missing .env.secrets.local readable by its owner only', async () => {
    const project = await initializedProject('rerun-scaffold-secrets')
    unlinkSync(join(project.root, '.env.secrets.local'))

    const result = await rerun(project, ['--yes'])

    expect(result.exit, result.stderr).toBe(0)
    expect(statSync(join(project.root, '.env.secrets.local')).mode & 0o777).toBe(0o600)
    expect(result.entries).toContainEqual({
      kind: 'done',
      text: 'scaffold: wrote .env.secrets.local',
    })
  })

  it('counts the needed files that are missing', async () => {
    const project = await initializedProject('rerun-scaffold-counts')
    unlinkSync(join(project.root, '.env'))
    unlinkSync(join(project.root, 'agent-qa-knowledge', '.gitignore'))

    const result = await rerun(project, [], asked)

    expect(result.exit, result.stderr).toBe(0)
    expect(labelOf(result.entries, 'scaffold')).toBe('scaffold   2 needed files missing')
  })

  it('says nothing missing and leaves the row unchecked after a fresh init', async () => {
    const project = await initializedProject('rerun-scaffold-current')

    const result = await rerun(project, [], asked)

    expect(result.exit, result.stderr).toBe(0)
    expect(labelOf(result.entries, 'scaffold')).toBe('scaffold   nothing missing')
    expect(menuOf(result.entries)?.initialValues ?? 'no menu').not.toContain('scaffold')
  })
})

// The shape of a mobile project an older init made: a bare target, no examples and no app.
function asAnOlderInitMadeIt(project: InitializedProject): void {
  editConfig(project.root, (doc) => {
    doc.deleteIn(['registry', 'targets', 'playground-android'])
    doc.setIn(['registry', 'targets', 'example-android'], { platform: 'android' })
  })
  rmSync(join(project.root, 'tests', 'examples'), { recursive: true })
  rmSync(join(project.root, 'app-bundles'), { recursive: true, force: true })
}

describe('a re-run and the Playground examples', () => {
  it.each(['scaffold', 'all'])(
    '--setup %s leaves a deleted Playground example deleted and the other examples as they were',
    async (rows) => {
      const project = await initializedProject(`rerun-playground-deleted-${rows}`, {
        platform: 'android',
      })
      const examples = join(project.root, 'tests', 'examples')
      unlinkSync(join(project.root, EXAMPLE_PATHS.androidStarter))
      const before = snapshot(examples)

      const result = await rerun(project, ['--setup', rows, '--json'], { plain: true })

      expect(result.exit, result.stderr).toBe(0)
      expect(existsSync(join(project.root, EXAMPLE_PATHS.androidStarter))).toBe(false)
      expect(snapshot(examples)).toEqual(before)
      const doc = JSON.parse(result.stdout) as InitDocument
      expect(setupRow(doc, 'scaffold')).toMatchObject({
        state: 'nothing missing',
        prechecked: false,
      })
      expect(doc.files.filter((file) => file.step === 'scaffold')).toEqual([])
    },
  )

  it.each(['scaffold', 'all'])(
    '--setup %s writes no examples folder into a mobile project an older init made',
    async (rows) => {
      const project = await initializedProject(`rerun-playground-older-${rows}`, {
        platform: 'android',
      })
      asAnOlderInitMadeIt(project)

      const result = await rerun(project, ['--setup', rows, '--json'], { plain: true })

      expect(result.exit, result.stderr).toBe(0)
      expect(existsSync(join(project.root, 'tests', 'examples'))).toBe(false)
      const doc = JSON.parse(result.stdout) as InitDocument
      expect(setupRow(doc, 'scaffold')).toMatchObject({
        state: 'nothing missing',
        prechecked: false,
      })
      expect(doc.files.filter((file) => file.step === 'scaffold')).toEqual([])
    },
  )
})

const PIXEL: AndroidHere = {
  attached: [],
  avds: [{ name: 'Pixel_10_Pro', profile: 'pixel_10_pro', displayName: 'Pixel 10 Pro', os: '17' }],
}

// The registry block's bytes as the config file holds them.
function registryText(root: string): string {
  const text = readFileSync(join(root, 'agent-qa.config.yaml'), 'utf8')
  const registry = parseDocument(text).get('registry', true)
  if (!isNode(registry) || !registry.range) return 'no registry block'
  return text.slice(registry.range[0], registry.range[2])
}

// Every file under a folder, by its path inside it, with its bytes.
function filesUnder(folder: string): Record<string, string> {
  return Object.fromEntries(
    Object.entries(snapshot(folder)).map(([path, bytes]) => [relative(folder, path), bytes]),
  )
}

// A forced init of an Android and iOS project, with nothing installed and no coding agent.
const FORCED_MOBILE_INIT = [
  '--force',
  '--yes',
  '--pm',
  'none',
  '--no-browsers',
  '--agents',
  'none',
  '--llm',
  'gemini',
  '--platform',
  'android,ios',
  '--json',
]

// A fresh Android and iOS project, then a framework of an older build put inside Playground.app
// and the APK's bytes changed by hand.
async function projectWithAnOlderApp(
  label: string,
): Promise<{ project: InitializedProject; old: string }> {
  const project = await initializedProject(label, { platform: 'android,ios' })
  const old = join(project.root, PLAYGROUND_APP_PATHS.ios, 'Frameworks', 'old.framework', 'old')
  mkdirSync(dirname(old), { recursive: true })
  writeFileSync(old, 'a framework the new build does not have\n')
  writeFileSync(join(project.root, PLAYGROUND_APP_PATHS.android), 'an older APK\n')
  return { project, old }
}

describe('the Playground app and the devices on a project that already has a config', () => {
  it('a re-run with --setup all requests no app, has no playground-app step and leaves the app as it was', async () => {
    const project = await initializedProject('rerun-playground-app', { platform: 'android' })
    const app = join(project.root, 'app-bundles')
    const before = snapshot(app)
    const fakes = mobileInitFakes()

    const result = await rerun(project, ['--setup', 'all', '--json'], {
      plain: true,
      hooks: fakes.hooks,
    })

    expect(result.exit, result.stderr).toBe(0)
    expect(fakes.requests).toEqual([])
    const doc = JSON.parse(result.stdout) as InitDocument
    expect(stepOf(doc, 'playground-app')).toBe('no playground-app step')
    expect(Object.keys(before)).toContain(join(project.root, PLAYGROUND_APP_PATHS.android))
    expect(snapshot(app)).toEqual(before)
  })

  it('a re-run with --setup all requests no app and leaves a deleted app-bundles deleted', async () => {
    const project = await initializedProject('rerun-playground-app-deleted', { platform: 'android' })
    rmSync(join(project.root, 'app-bundles'), { recursive: true })
    const fakes = mobileInitFakes()

    const result = await rerun(project, ['--setup', 'all', '--json'], {
      plain: true,
      hooks: fakes.hooks,
    })

    expect(result.exit, result.stderr).toBe(0)
    expect(fakes.requests).toEqual([])
    const doc = JSON.parse(result.stdout) as InitDocument
    expect(stepOf(doc, 'playground-app')).toBe('no playground-app step')
    expect(existsSync(join(project.root, 'app-bundles'))).toBe(false)
  })

  it('a re-run with --setup all lists no device and leaves the registry block byte for byte as it was', async () => {
    const project = await initializedProject('rerun-playground-device', {
      platform: 'android',
      hooks: mobileInitFakes({ android: PIXEL }).hooks,
    })
    const before = registryText(project.root)
    const fakes = mobileInitFakes()

    const result = await rerun(project, ['--setup', 'all', '--json'], {
      plain: true,
      hooks: fakes.hooks,
    })

    expect(result.exit, result.stderr).toBe(0)
    expect(fakes.listed).toEqual([])
    expect(before).toContain('model: Pixel 10 Pro')
    expect(registryText(project.root)).toBe(before)
  })

  it('init --force requests both apps again, replaces the APK and leaves Playground.app holding what a fresh init writes and nothing else', async () => {
    const { project, old } = await projectWithAnOlderApp('force-playground-app')
    const fresh = await initializedProject('force-playground-app-fresh', {
      platform: 'android,ios',
    })
    const fakes = mobileInitFakes()

    const result = await rerun(project, FORCED_MOBILE_INIT, { plain: true, hooks: fakes.hooks })

    expect(result.exit, result.stderr).toBe(0)
    const pin = fakes.hooks.playgroundApp.pin
    expect(fakes.requests.map((request) => request.url)).toEqual([
      playgroundAppUrl(pin, 'android'),
      playgroundAppUrl(pin, 'ios'),
    ])
    const doc = JSON.parse(result.stdout) as InitDocument
    expect(stepOf(doc, 'playground-app')).toEqual({ name: 'playground-app', outcome: 'done' })
    expect(existsSync(old)).toBe(false)
    expect(readFileSync(join(project.root, PLAYGROUND_APP_PATHS.android))).toEqual(
      Buffer.from(fakePlaygroundApp().bytes.android),
    )
    const freshApp = filesUnder(join(fresh.root, PLAYGROUND_APP_PATHS.ios))
    expect(freshApp).not.toEqual({})
    expect(filesUnder(join(project.root, PLAYGROUND_APP_PATHS.ios))).toEqual(freshApp)
    expect(doc.files.filter((file) => file.step === 'playground-app')).toEqual([
      { path: PLAYGROUND_APP_PATHS.android, outcome: 'updated', step: 'playground-app' },
      { path: PLAYGROUND_APP_PATHS.ios, outcome: 'updated', step: 'playground-app' },
    ])
  })
})
