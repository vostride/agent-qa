import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { stripVTControlCharacters } from 'node:util'

import { getAgentQaVersion, getAuthPath } from '@vostride/agent-qa-core'
import { parseDocument } from 'yaml'

import { afterEach, describe, expect, it } from 'vitest'

import {
  AGENT_SETUP_MANIFEST_PATH,
  writeAgentSetupManifest,
} from '../commands/agent-setup-manifest.js'
import type { InitDocument } from '../commands/init-document.js'
import { composeAnalyticsHost } from '../composition/analytics-host.js'
import { createClackUi } from '../init-ui/clack-ui.js'
import { brandPalette } from '../init-ui/palette.js'
import { clackStreams } from './clack-keys.js'
import type { FakeInitUiEntry } from './fake-init-ui.js'
import {
  cleanupTempProjects,
  fakeRunner,
  tempProject,
  writeInstalledPackage,
} from './project-fixtures.js'
import { initializedProject, rerun } from './rerun-fixtures.js'

const OLD_STOP = /already initialized|Use --force to rebuild/u
const VERSION = getAgentQaVersion().trim()

afterEach(() => {
  cleanupTempProjects()
})

function plantMalformedManifest(root: string): void {
  mkdirSync(join(root, '.agents'), { recursive: true })
  writeFileSync(join(root, AGENT_SETUP_MANIFEST_PATH), '{ not json')
}

function summaryLines(entries: readonly FakeInitUiEntry[]): string[] | undefined {
  const entry = entries.find((item) => item.kind === 'summary')
  return entry?.kind === 'summary' ? entry.lines : undefined
}

const SAVED_KEY = 'DUMMY-KEY-SUMMARY'

function saveGeminiKey(home: string): void {
  const authPath = getAuthPath({ env: {}, homeDir: home })
  mkdirSync(dirname(authPath), { recursive: true })
  writeFileSync(
    authPath,
    JSON.stringify({ gemini: { type: 'api', provider: 'gemini', key: SAVED_KEY } }),
  )
}

function editConfig(root: string, change: (doc: ReturnType<typeof parseDocument>) => void): void {
  const path = join(root, 'agent-qa.config.yaml')
  const doc = parseDocument(readFileSync(path, 'utf8'))
  change(doc)
  writeFileSync(path, doc.toString())
}

function contents(root: string): Record<string, string> {
  const files: Record<string, string> = {}
  for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue
    const path = join(entry.parentPath, entry.name)
    files[path] = readFileSync(path, 'base64')
  }
  return files
}

function recordingAnalytics(): {
  sent: { name: string; properties: Record<string, unknown> }[]
  composeAnalytics: typeof composeAnalyticsHost
} {
  const sent: { name: string; properties: Record<string, unknown> }[] = []
  const composeAnalytics: typeof composeAnalyticsHost = async () =>
    composeAnalyticsHost({
      surface: 'cli',
      env: {},
      transportOverride: {
        capture: (payload) => {
          sent.push(payload.event as (typeof sent)[number])
        },
        flush: () => {},
        shutdown: () => {},
      },
      resolveIdentity: async () => ({ distinctId: 'u_init-rerun', runtimeContext: 'user' }),
    })
  return { sent, composeAnalytics }
}

describe('a re-run of init in an initialized project', () => {
  it('draws the intro, a done validate step and the outro, and exits 0', async () => {
    const project = await initializedProject('rerun-validates')

    const result = await rerun(project)

    expect(result.exit, result.stderr).toBe(0)
    const kinds = result.entries.map((entry) => entry.kind)
    expect(kinds[0]).toBe('intro')
    expect(kinds.at(-1)).toBe('outro')
    expect(result.entries).toContainEqual({
      kind: 'step',
      text: 'Validating the config and tests',
    })
    expect(result.entries).toContainEqual({
      kind: 'done',
      text: 'validate: the config and tests are valid',
    })
    const texts = result.entries.map((entry) => entry.text).join('\n')
    expect(texts).not.toMatch(OLD_STOP)
  })

  it('with --yes and nothing to repair changes no byte of the project', async () => {
    const project = await initializedProject('rerun-keeps-bytes')
    const before = contents(project.root)

    const result = await rerun(project, ['--yes'])

    expect(result.exit, result.stderr).toBe(0)
    expect(contents(project.root)).toEqual(before)
  })

  it('with --json prints one done document whose steps end in a done validate', async () => {
    const project = await initializedProject('rerun-json')

    const result = await rerun(project, ['--json'], { plain: true })

    expect(result.exit, result.stderr).toBe(0)
    const doc = JSON.parse(result.stdout) as InitDocument
    expect(doc).toMatchObject({ format: 1, outcome: 'done', exitCode: 0, files: [] })
    expect(doc.steps.at(-1)).toEqual({ name: 'validate', outcome: 'done' })
    expect(doc.steps.filter((step) => OLD_STOP.test(step.reason ?? ''))).toEqual([])
    expect(result.stderr).not.toMatch(OLD_STOP)
  })

  it('exits 3 with the validate step failed when the project does not validate', async () => {
    const project = await initializedProject('rerun-invalid')
    const run = fakeRunner(({ args }) =>
      args.includes('validate')
        ? { code: 1, signal: null, output: 'tests/broken.yaml\n  1:1  error  bad step\n' }
        : { code: 0, signal: null, output: '' },
    )

    const result = await rerun(project, ['--json'], { run, plain: true })

    expect(result.exit).toBe(3)
    const doc = JSON.parse(result.stdout) as InitDocument
    expect(doc).toMatchObject({ outcome: 'failed', exitCode: 3 })
    expect(doc.steps.at(-1)).toMatchObject({ name: 'validate', outcome: 'failed' })
  })

  it('reports one agent-qa.init.completed event with the rerun mode that reads unchanged', async () => {
    const project = await initializedProject('rerun-analytics')
    const { sent, composeAnalytics } = recordingAnalytics()

    const result = await rerun(project, ['--yes'], { hooks: { composeAnalytics } })

    expect(result.exit, result.stderr).toBe(0)
    const completed = sent.filter((event) => event.name === 'agent-qa.init.completed')
    expect(completed).toHaveLength(1)
    expect(completed[0]?.properties).toMatchObject({
      init_mode: 'rerun',
      outcome: 'unchanged',
      created_file_count: 0,
    })
    expect(typeof completed[0]?.properties.duration_ms).toBe('number')
  })

  it("reports the rerun mode with an updated outcome when a row restores init's block", async () => {
    const project = await initializedProject('rerun-analytics-updated')
    writeFileSync(join(project.root, '.gitignore'), 'dist/\n')
    const { sent, composeAnalytics } = recordingAnalytics()

    const result = await rerun(project, ['--yes'], { hooks: { composeAnalytics } })

    expect(result.exit, result.stderr).toBe(0)
    const completed = sent.filter((event) => event.name === 'agent-qa.init.completed')
    const modes = completed.map(({ properties }) =>
      [properties.init_mode, properties.outcome].map(String).join(' '),
    )
    expect(modes.join('|')).toBe('rerun updated')
  })
})

describe("a re-run reads the project's agent-setup manifest first", () => {
  it('records the agents the manifest names in its document', async () => {
    const project = await initializedProject('rerun-manifest-agents')
    writeAgentSetupManifest(project.root, {
      format: 1,
      version: VERSION,
      agents: ['claude-code'],
      files: [],
      entries: [],
    })

    const result = await rerun(project, ['--json'], { plain: true })

    expect(result.exit, result.stderr).toBe(0)
    expect((JSON.parse(result.stdout) as InitDocument).agents).toEqual(['claude-code'])
  })

  it('records no agents when the project has no manifest', async () => {
    const project = await initializedProject('rerun-no-manifest')

    const result = await rerun(project, ['--json'], { plain: true })

    expect(result.exit, result.stderr).toBe(0)
    expect((JSON.parse(result.stdout) as InitDocument).agents).toEqual([])
  })

  it('refuses a manifest that is not valid JSON with one line, exit 2, drawing and writing nothing', async () => {
    const project = await initializedProject('rerun-malformed-manifest')
    plantMalformedManifest(project.root)
    const before = contents(project.root)

    const result = await rerun(project)

    expect(result.exit).toBe(2)
    const lines = stripVTControlCharacters(result.stderr)
      .split('\n')
      .filter((line) => line !== '')
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatch(
      /^Refusing malformed \.agents\/agent-qa-skills\.json: it is not valid JSON/u,
    )
    expect(result.entries).toEqual([])
    expect(contents(project.root)).toEqual(before)
  })

  it('under --json reports the malformed manifest as a refused document with its line', async () => {
    const project = await initializedProject('rerun-malformed-manifest-json')
    plantMalformedManifest(project.root)

    const result = await rerun(project, ['--json'], { plain: true })

    expect(result.exit).toBe(2)
    const doc = JSON.parse(result.stdout) as InitDocument
    expect(doc).toMatchObject({ outcome: 'refused', exitCode: 2, files: [] })
    expect(doc.message).toMatch(
      /^Refusing malformed \.agents\/agent-qa-skills\.json: it is not valid JSON/u,
    )
    expect(doc.steps).toEqual([])
  })
})

describe("a re-run's summary of the project's agent-qa version", () => {
  it('draws a This project summary right after the intro that names the running version', async () => {
    const project = await initializedProject('rerun-summary-version')

    const result = await rerun(project)

    expect(result.exit, result.stderr).toBe(0)
    expect(result.entries[0]?.kind).toBe('intro')
    expect(result.entries[1]?.kind).toBe('summary')
    expect(result.entries[1]?.text).toBe('This project')
    const lines = summaryLines(result.entries) ?? []
    expect(lines[0]).toBe(`You're on agent-qa ${VERSION}.`)
    expect(lines.join('\n')).not.toMatch(/This agent-qa is/u)
  })

  it("names the project's installed agent-qa, then this one when they differ", async () => {
    const project = await initializedProject('rerun-summary-installed')
    writeInstalledPackage(project.root, 'agent-qa', '0.0.1', {
      packageJson: { bin: { 'agent-qa': 'cli.js' } },
      files: { 'cli.js': '' },
    })

    const result = await rerun(project)

    expect(result.exit, result.stderr).toBe(0)
    const lines = summaryLines(result.entries) ?? []
    expect(lines.slice(0, 2)).toEqual([
      "You're on agent-qa 0.0.1.",
      `This agent-qa is ${VERSION}.`,
    ])
  })

  it('in plain mode prints the title and each line indented on stderr, and only the document on stdout', async () => {
    const project = await initializedProject('rerun-summary-plain')

    const result = await rerun(project, ['--json'], { plain: true })

    expect(result.exit, result.stderr).toBe(0)
    expect(result.stderr).toContain(`This project\n  You're on agent-qa ${VERSION}.\n`)
    expect(JSON.parse(result.stdout)).toMatchObject({ format: 1, outcome: 'done' })
  })

  it('on the rail draws the summary as one step block', () => {
    const streams = clackStreams({ columns: 80 })
    const ui = createClackUi({
      input: streams.input,
      output: streams.output,
      palette: brandPalette({ background: 'dark', level: 0 }),
      columns: 80,
    })

    ui.summary('This project', ["You're on agent-qa 1.2.3.", 'This agent-qa is 1.2.4.'])

    expect(stripVTControlCharacters(streams.text())).toBe(
      "│\n◇  This project\n│  You're on agent-qa 1.2.3.\n│  This agent-qa is 1.2.4.\n",
    )
  })
})

describe("a re-run's summary of the model and the coding agents", () => {
  it('says the model is ready when its key is saved in the store', async () => {
    const project = await initializedProject('rerun-summary-model-ready')
    saveGeminiKey(project.home)

    const result = await rerun(project)

    expect(result.exit, result.stderr).toBe(0)
    const lines = summaryLines(result.entries) ?? []
    expect(lines.find((line) => line.startsWith('Model ')) ?? '').toBe('Model gemini is ready.')
  })

  it('says the model is pending, with the reason, when no key is saved', async () => {
    const project = await initializedProject('rerun-summary-model-pending')

    const result = await rerun(project)

    expect(result.exit, result.stderr).toBe(0)
    expect(summaryLines(result.entries)).toContain(
      "Model gemini is pending: add the key on the dashboard's model page.",
    )
  })

  it('says no model is set up when the config has no model entry', async () => {
    const project = await initializedProject('rerun-summary-no-model')
    editConfig(project.root, (doc) => {
      doc.deleteIn(['registry', 'llms'])
      doc.deleteIn(['use', 'llm'])
    })

    const result = await rerun(project)

    expect(result.exit, result.stderr).toBe(0)
    expect(summaryLines(result.entries)).toContain('No model is set up.')
  })

  it('leaves the model out when the config does not parse', async () => {
    const project = await initializedProject('rerun-summary-unparsed-config')
    writeFileSync(join(project.root, 'agent-qa.config.yaml'), 'registry: [unclosed\n')

    const result = await rerun(project)

    const lines = summaryLines(result.entries) ?? []
    expect(lines[0]).toBe(`You're on agent-qa ${VERSION}.`)
    expect(lines.filter((line) => /model/iu.test(line))).toEqual([])
  })

  it('names the coding agents the manifest sets up', async () => {
    const project = await initializedProject('rerun-summary-agents')
    writeAgentSetupManifest(project.root, {
      format: 1,
      version: VERSION,
      agents: ['claude-code', 'codex'],
      files: [],
      entries: [],
    })

    const result = await rerun(project)

    expect(result.exit, result.stderr).toBe(0)
    expect(summaryLines(result.entries)).toContain('Coding agents: Claude Code, Codex.')
  })

  it('says no coding agent is set up without a manifest', async () => {
    const project = await initializedProject('rerun-summary-no-agents')

    const result = await rerun(project)

    expect(result.exit, result.stderr).toBe(0)
    expect(summaryLines(result.entries)).toContain('No coding agent is set up.')
  })

  it("records the summary's model in the --json document and shows no saved key", async () => {
    const project = await initializedProject('rerun-summary-model-json')
    saveGeminiKey(project.home)

    const result = await rerun(project, ['--json'], { plain: true })

    expect(result.exit, result.stderr).toBe(0)
    expect(result.stderr).toContain('  Model gemini is ready.\n')
    const doc = JSON.parse(result.stdout) as InitDocument
    expect(`${doc.model?.name} ${doc.model?.provider} ${doc.model?.status}`).toBe(
      'gemini gemini ready',
    )
    expect(result.stdout).not.toContain(SAVED_KEY)
    expect(result.stderr).not.toContain(SAVED_KEY)
  })
})

const MENU = 'What should init set up here?'

function gitignorePath(root: string): string {
  return join(root, '.gitignore')
}

// A fresh init into a folder without a .gitignore writes init's block and nothing else.
function initBlock(root: string): string {
  return readFileSync(gitignorePath(root), 'utf8')
}

function menuOf(entries: readonly FakeInitUiEntry[]): Extract<
  FakeInitUiEntry,
  { kind: 'multiselect' }
> | undefined {
  const entry = entries.find((item) => item.kind === 'multiselect' && item.text === MENU)
  return entry?.kind === 'multiselect' ? entry : undefined
}

const asked = { hooks: { isTTY: true } }

describe("a re-run's setup menu and its gitignore row", () => {
  it('asks what init should set up here after the summary and the coding agents question, labelling the gitignore row by its state', async () => {
    const project = await initializedProject('rerun-menu-gitignore-missing')
    writeFileSync(gitignorePath(project.root), 'dist/\n')

    const result = await rerun(project, [], asked)

    expect(result.exit, result.stderr).toBe(0)
    const at = result.entries.findIndex((entry) => entry.kind === 'summary')
    expect(result.entries.slice(at + 1, at + 3).map((entry) => entry.text)).toEqual([
      'Which coding agents should agent-qa set up?',
      MENU,
    ])
    const menu = menuOf(result.entries)
    expect(menu?.labels.join('|') ?? 'no menu').toBe('agents-md  current|gitignore  block missing')
    expect(menu?.initialValues.join('|') ?? 'no menu').toBe('gitignore')
  })

  it("with --yes restores init's block and keeps every other byte of .gitignore", async () => {
    const project = await initializedProject('rerun-gitignore-restores')
    const block = initBlock(project.root)
    writeFileSync(gitignorePath(project.root), 'dist/\n# mine\ncoverage/\n')

    const result = await rerun(project, ['--yes', '--json'], { plain: true })

    expect(result.exit, result.stderr).toBe(0)
    expect(readFileSync(gitignorePath(project.root), 'utf8')).toBe(
      `dist/\n# mine\ncoverage/\n\n${block}`,
    )
    const doc = JSON.parse(result.stdout) as InitDocument
    expect(doc.steps).toEqual([
      { name: 'agents-md', outcome: 'skipped', reason: 'current' },
      { name: 'gitignore', outcome: 'done' },
      { name: 'validate', outcome: 'done' },
    ])
    expect(doc.files).toEqual([{ path: '.gitignore', outcome: 'updated', step: 'gitignore' }])
  })

  it("labels an edited block, pre-checks it, and running it puts agent-qa's block back", async () => {
    const project = await initializedProject('rerun-gitignore-edited')
    const block = initBlock(project.root)
    const edited = block.replace('node_modules/\n', '')
    writeFileSync(gitignorePath(project.root), `dist/\n${edited}coverage/\n`)

    const result = await rerun(project, [], asked)

    expect(result.exit, result.stderr).toBe(0)
    const menu = menuOf(result.entries)
    expect(menu?.labels.join('|') ?? 'no menu').toBe(
      'agents-md  current|gitignore  the block was edited',
    )
    expect(menu?.initialValues.join('|') ?? 'no menu').toBe('gitignore')
    expect(readFileSync(gitignorePath(project.root), 'utf8')).toBe(
      `dist/\n${block}coverage/\n`,
    )
  })

  it('leaves .gitignore as it was when the row is unchecked, and skips it as not selected', async () => {
    const project = await initializedProject('rerun-gitignore-unchecked')
    writeFileSync(gitignorePath(project.root), 'dist/\n')

    const result = await rerun(project, [], { ...asked, answers: { [MENU]: [] } })

    expect(result.exit, result.stderr).toBe(0)
    expect(readFileSync(gitignorePath(project.root), 'utf8')).toBe('dist/\n')
    expect(result.entries).toContainEqual({ kind: 'skipped', text: 'gitignore: not selected' })
  })
})

describe('a re-run with nothing to change, and its document', () => {
  it('says everything is current and shows the menu with nothing checked', async () => {
    const project = await initializedProject('rerun-all-current')

    const result = await rerun(project, [], asked)

    expect(result.exit, result.stderr).toBe(0)
    expect(summaryLines(result.entries)?.at(-1) ?? 'no summary').toBe('Everything is current.')
    const menu = menuOf(result.entries)
    expect(menu?.labels.join('|') ?? 'no menu').toBe('agents-md  current|gitignore  current')
    expect(menu?.initialValues.join('|') ?? 'no menu').toBe('')
  })

  it('with --yes exits 0, changes no byte and skips the gitignore row as current', async () => {
    const project = await initializedProject('rerun-all-current-yes')
    const before = contents(project.root)

    const result = await rerun(project, ['--yes', '--json'], { plain: true })

    expect(result.exit, result.stderr).toBe(0)
    expect(contents(project.root)).toEqual(before)
    const doc = JSON.parse(result.stdout) as InitDocument
    expect(doc.steps).toContainEqual({ name: 'gitignore', outcome: 'skipped', reason: 'current' })
  })

  it("--json reports each row's state, pre-check and selection beside the steps", async () => {
    const project = await initializedProject('rerun-json-setup')
    writeFileSync(gitignorePath(project.root), 'dist/\n')

    const result = await rerun(project, ['--json'], { plain: true })

    expect(result.exit, result.stderr).toBe(0)
    const doc = JSON.parse(result.stdout) as InitDocument
    expect(`${doc.outcome} ${doc.exitCode}`).toBe('done 0')
    expect(JSON.stringify(doc.setup ?? 'no setup')).toBe(
      JSON.stringify([
        {
          name: 'skills',
          state: 'no coding agent chosen',
          prechecked: false,
          selected: false,
          hidden: 'no coding agent chosen',
        },
        {
          name: 'mcp',
          state: 'no coding agent chosen',
          prechecked: false,
          selected: false,
          hidden: 'no coding agent chosen',
        },
        { name: 'agents-md', state: 'current', prechecked: false, selected: false },
        { name: 'gitignore', state: 'block missing', prechecked: true, selected: true },
      ]),
    )
    expect(doc.steps.map((step) => `${step.name} ${step.outcome}`)).toEqual([
      'agents-md skipped',
      'gitignore done',
      'validate done',
    ])
  })

  it("a fresh init's --json document has no setup key", async () => {
    const project = tempProject('fresh-json-no-setup')

    const result = await rerun(
      project,
      ['--yes', '--json', '--pm', 'none', '--no-browsers', '--agents', 'none', '--llm', 'gemini'],
      { plain: true },
    )

    expect(result.exit, result.stderr).toBe(0)
    expect(Object.hasOwn(JSON.parse(result.stdout) as object, 'setup')).toBe(false)
  })

  it.each([
    ['duplicated', (block: string) => `${block}${block}`],
    ['unbalanced', (block: string) => block.replace('# agent-qa init:end\n', '')],
  ])(
    'refuses a managed block that is %s with one line naming .gitignore, exit 2, leaving it as it was',
    async (_kind, malform) => {
      const project = await initializedProject('rerun-gitignore-malformed')
      const malformed = malform(initBlock(project.root))
      writeFileSync(gitignorePath(project.root), malformed)

      const result = await rerun(project, [], asked)

      expect(result.exit).toBe(2)
      const lines = stripVTControlCharacters(result.stderr)
        .split('\n')
        .filter((line) => line !== '')
      expect(lines.join('|')).toBe(
        'Refusing malformed .gitignore: expected at most one complete agent-qa init managed block',
      )
      expect(result.entries).toEqual([])
      expect(readFileSync(gitignorePath(project.root), 'utf8')).toBe(malformed)
    },
  )
})

const FRESH_SETUP_LINE =
  '--setup picks what a re-run of init sets up, and this folder is not set up yet. '
  + 'Run npx agent-qa init without --setup.'
const FORCE_SETUP_LINE =
  '--setup picks what a re-run of init sets up, and --force rebuilds everything. '
  + 'Use one of them.'
const SETUP_NAMES_HINT = 'Use skills, mcp, agents-md, gitignore, all or none.'

function refusalLines(stderr: string): string {
  return stripVTControlCharacters(stderr)
    .split('\n')
    .filter((line) => line !== '')
    .join('|')
}

describe("--setup answers the re-run's menu", () => {
  it('runs the named row whatever its pre-check, asks nothing and records it done', async () => {
    const project = await initializedProject('rerun-setup-named')

    const result = await rerun(project, ['--setup', 'gitignore'], asked)

    expect(result.exit, result.stderr).toBe(0)
    expect(menuOf(result.entries)?.text ?? 'no menu').toBe('no menu')
    expect(result.entries).toContainEqual({
      kind: 'done',
      text: "gitignore: init's block is current",
    })
  })

  it('with none runs no row, still prints the summary and validates, and changes no byte', async () => {
    const project = await initializedProject('rerun-setup-none')
    writeFileSync(gitignorePath(project.root), 'dist/\n')
    const before = contents(project.root)

    const result = await rerun(project, ['--setup', 'none'], asked)

    expect(result.exit, result.stderr).toBe(0)
    expect(menuOf(result.entries)?.text ?? 'no menu').toBe('no menu')
    expect(summaryLines(result.entries)?.length ?? 0).toBeGreaterThan(0)
    expect(result.entries).toContainEqual({ kind: 'skipped', text: 'gitignore: not selected' })
    expect(result.entries).toContainEqual({
      kind: 'done',
      text: 'validate: the config and tests are valid',
    })
    expect(contents(project.root)).toEqual(before)
  })

  it('with all runs every shown row without asking', async () => {
    const project = await initializedProject('rerun-setup-all')
    const block = initBlock(project.root)
    writeFileSync(gitignorePath(project.root), 'dist/\n')

    const result = await rerun(project, ['--setup', 'all', '--json'], { plain: true })

    expect(result.exit, result.stderr).toBe(0)
    expect(readFileSync(gitignorePath(project.root), 'utf8')).toBe(`dist/\n\n${block}`)
    const doc = JSON.parse(result.stdout) as InitDocument
    expect(doc.steps.map((step) => `${step.name} ${step.outcome}`)).toEqual([
      'agents-md done',
      'gitignore done',
      'validate done',
    ])
  })

  it('trims the spaces around a name', async () => {
    const project = await initializedProject('rerun-setup-trims')

    const result = await rerun(project, ['--setup', ' gitignore ', '--json'], { plain: true })

    expect(result.exit, result.stderr).toBe(0)
    const doc = JSON.parse(result.stdout) as InitDocument
    expect(doc.steps).toContainEqual({ name: 'gitignore', outcome: 'done' })
  })

  it.each([
    ['bogus', `Unknown setup row "bogus". ${SETUP_NAMES_HINT}`],
    ['all,gitignore', `--setup all cannot be combined with other rows. ${SETUP_NAMES_HINT}`],
    ['none,gitignore', `--setup none cannot be combined with other rows. ${SETUP_NAMES_HINT}`],
  ])('refuses --setup %s with one line, exit 2, drawing and writing nothing', async (value, line) => {
    const project = await initializedProject('rerun-setup-refused')
    writeFileSync(gitignorePath(project.root), 'dist/\n')
    const before = contents(project.root)

    const result = await rerun(project, ['--setup', value], asked)

    expect(result.exit).toBe(2)
    expect(refusalLines(result.stderr)).toBe(line)
    expect(result.entries).toEqual([])
    expect(contents(project.root)).toEqual(before)
  })
})

describe('a misplaced --setup', () => {
  it('on a folder with no config is refused with one line, exit 2, writing nothing', async () => {
    const project = tempProject('fresh-setup-refused')

    const result = await rerun(project, ['--setup', 'gitignore'], asked)

    expect(result.exit).toBe(2)
    expect(refusalLines(result.stderr)).toBe(FRESH_SETUP_LINE)
    expect(readdirSync(project.root)).toEqual(['.git'])
  })

  it('on a folder with no config under --json prints a refused document with that line', async () => {
    const project = tempProject('fresh-setup-refused-json')

    const result = await rerun(project, ['--setup', 'gitignore', '--json'], { plain: true })

    expect(result.exit).toBe(2)
    const doc = JSON.parse(result.stdout) as InitDocument
    expect(`${doc.outcome} ${doc.exitCode} ${doc.message ?? 'no message'}`).toBe(
      `refused 2 ${FRESH_SETUP_LINE}`,
    )
    expect(readdirSync(project.root)).toEqual(['.git'])
  })

  it('with --force is refused with one line, exit 2, before anything is written', async () => {
    const project = await initializedProject('rerun-setup-force')
    writeFileSync(gitignorePath(project.root), 'dist/\n')
    const before = contents(project.root)

    const result = await rerun(project, ['--setup', 'gitignore', '--force'], asked)

    expect(result.exit).toBe(2)
    expect(refusalLines(result.stderr)).toBe(FORCE_SETUP_LINE)
    expect(contents(project.root)).toEqual(before)
  })
})
