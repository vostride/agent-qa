import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { stripVTControlCharacters } from 'node:util'

import { getAgentQaVersion } from '@vostride/agent-qa-core'

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
import { cleanupTempProjects, fakeRunner, writeInstalledPackage } from './project-fixtures.js'
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

function contents(root: string): Record<string, string> {
  const files: Record<string, string> = {}
  for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue
    const path = join(entry.parentPath, entry.name)
    files[path] = readFileSync(path, 'base64')
  }
  return files
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

  it('reports one agent-qa.init.completed event that reads unchanged', async () => {
    const project = await initializedProject('rerun-analytics')
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

    const result = await rerun(project, ['--yes'], { hooks: { composeAnalytics } })

    expect(result.exit, result.stderr).toBe(0)
    const completed = sent.filter((event) => event.name === 'agent-qa.init.completed')
    expect(completed).toHaveLength(1)
    expect(completed[0]?.properties).toMatchObject({
      outcome: 'unchanged',
      created_file_count: 0,
    })
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
