import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { parseDocument, type YAMLSeq } from 'yaml'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { InitDocument } from '../commands/init-document.js'
import { SETUP_MENU_QUESTION } from '../commands/init-rerun.js'
import type { RunResult } from '../commands/project-host.js'
import type { FakeInitUiEntry } from './fake-init-ui.js'
import {
  cleanupTempProjects,
  fakeRunner,
  writeInstalledPackage,
  type FakeRunner,
  type RunnerCall,
} from './project-fixtures.js'
import { initializedProject, rerun, type InitializedProject } from './rerun-fixtures.js'

const { PROJECT_VERSION, running } = vi.hoisted(() => ({
  PROJECT_VERSION: '0.3.0',
  running: { version: '0.3.0' },
}))

vi.mock('@vostride/agent-qa-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@vostride/agent-qa-core')>()),
  getAgentQaVersion: () => running.version,
}))

const NODE = '/fake/node'
const SUBSCRIPTION = '@vostride/agent-qa-subscription-auth'
const JIRA = '@vostride/agent-qa-plugin-jira'
const OK: RunResult = { code: 0, signal: null, output: '' }

afterEach(() => {
  running.version = PROJECT_VERSION
  cleanupTempProjects()
})

function isProbe(args: readonly string[]): boolean {
  return args.length === 1 && args[0] === '--version'
}

// The install puts each named package in node_modules at the version package.json declares.
function installing(...names: string[]): FakeRunner {
  return fakeRunner(({ command, args, options }) => {
    if (isProbe(args)) return { code: 0, signal: null, output: '11.0.0\n' }
    if (command === NODE) return OK
    const declared = JSON.parse(readFileSync(join(options.cwd, 'package.json'), 'utf8')) as {
      devDependencies: Record<string, string>
    }
    for (const name of names) {
      writeInstalledPackage(options.cwd, name, declared.devDependencies[name] ?? '0.0.0')
    }
    return OK
  })
}

function installs(run: FakeRunner): RunnerCall[] {
  return run.calls.filter((call) => !isProbe(call.args) && call.command !== NODE)
}

function menuOf(entries: readonly FakeInitUiEntry[]) {
  const entry = entries.find(
    (item) => item.kind === 'multiselect' && item.text === SETUP_MENU_QUESTION,
  )
  return entry?.kind === 'multiselect' ? entry : undefined
}

function depsLabel(entries: readonly FakeInitUiEntry[]): string | undefined {
  return menuOf(entries)?.labels.find((label) => label.startsWith('deps '))
}

function packageJson(root: string): { devDependencies: Record<string, string> } {
  return JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
}

function writeDevDependencies(root: string, devDependencies: Record<string, string>): void {
  const text = `${JSON.stringify({ name: 'app', private: true, devDependencies }, null, 2)}\n`
  writeFileSync(join(root, 'package.json'), text)
}

function undeclare(root: string, name: string): void {
  const pkg = packageJson(root)
  delete pkg.devDependencies[name]
  writeFileSync(join(root, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`)
}

function uninstall(root: string, name: string): void {
  rmSync(join(root, 'node_modules', ...name.split('/')), { recursive: true, force: true })
}

function addPlugin(root: string, name: string, pkg: string): void {
  const path = join(root, 'agent-qa.config.yaml')
  const doc = parseDocument(readFileSync(path, 'utf8'))
  const plugins = doc.get('plugins') as YAMLSeq | undefined
  if (plugins === undefined) doc.set('plugins', [{ name, package: pkg }])
  else plugins.add(doc.createNode({ name, package: pkg }))
  writeFileSync(path, doc.toString())
}

const asked = { hooks: { isTTY: true }, answers: { [SETUP_MENU_QUESTION]: [] } }

async function subscriptionProjectWithoutPlugin(label: string): Promise<InitializedProject> {
  const project = await initializedProject(label, { llm: 'codex' })
  undeclare(project.root, SUBSCRIPTION)
  return project
}

describe("the re-run's deps row adds a missing agent-qa package and installs it", () => {
  it('labels a subscription plugin the package.json lacks as missing and pre-checks the row', async () => {
    const project = await subscriptionProjectWithoutPlugin('deps-plugin-missing-menu')

    const result = await rerun(project, [], asked)

    expect(result.exit, result.stderr).toBe(0)
    expect(depsLabel(result.entries)).toBe('deps       subscription plugin missing')
    expect(menuOf(result.entries)?.initialValues).toContain('deps')
  })

  it("--yes declares the plugin at agent-qa's exact version and runs the plain install once", async () => {
    const project = await subscriptionProjectWithoutPlugin('deps-plugin-missing-yes')
    const run = installing(SUBSCRIPTION)

    const result = await rerun(project, ['--yes', '--json'], { run })

    expect(result.exit, result.stderr).toBe(0)
    expect(packageJson(project.root).devDependencies[SUBSCRIPTION]).toBe(PROJECT_VERSION)
    expect(installs(run).map((call) => [call.command, ...call.args].join(' '))).toEqual([
      'npm install',
    ])
    const doc = JSON.parse(result.stdout) as InitDocument
    expect(doc.steps).toContainEqual({ name: 'deps', outcome: 'done' })
  })

  it('labels a declared agent-qa that is not installed and running the row installs it', async () => {
    const project = await initializedProject('deps-agent-qa-not-installed')
    uninstall(project.root, 'agent-qa')
    const before = readFileSync(join(project.root, 'package.json'), 'utf8')
    const run = installing('agent-qa')

    const asking = await rerun(project, [], asked)
    const result = await rerun(project, ['--yes'], { run })

    expect(depsLabel(asking.entries)).toBe('deps       agent-qa not installed')
    expect(menuOf(asking.entries)?.initialValues).toContain('deps')
    expect(result.exit, result.stderr).toBe(0)
    expect(installs(run)).toHaveLength(1)
    expect(readFileSync(join(project.root, 'package.json'), 'utf8')).toBe(before)
  })

  it('adds a first-party plugins entry at the same exact version and leaves a third-party plugin as declared', async () => {
    const project = await initializedProject('deps-first-party-plugin')
    addPlugin(project.root, 'jira', JIRA)
    addPlugin(project.root, 'acme', 'acme-agent-qa-plugin')
    writeDevDependencies(project.root, {
      'acme-agent-qa-plugin': '^1.0.0',
      'agent-qa': PROJECT_VERSION,
    })
    const run = installing(JIRA)

    const asking = await rerun(project, [], asked)
    const result = await rerun(project, ['--yes'], { run })

    expect(depsLabel(asking.entries)).toBe('deps       jira plugin missing')
    expect(result.exit, result.stderr).toBe(0)
    expect(packageJson(project.root).devDependencies).toEqual({
      'acme-agent-qa-plugin': '^1.0.0',
      [JIRA]: PROJECT_VERSION,
      'agent-qa': PROJECT_VERSION,
    })
  })

  it('never compares or rewrites agent-qa declared as a file: spec', async () => {
    const project = await initializedProject('deps-file-spec')
    writeDevDependencies(project.root, { 'agent-qa': 'file:../agent-qa' })
    uninstall(project.root, 'agent-qa')
    const before = readFileSync(join(project.root, 'package.json'), 'utf8')
    const run = installing('agent-qa')

    const asking = await rerun(project, [], asked)
    const result = await rerun(project, ['--setup', 'deps', '--json'], { run })

    expect(depsLabel(asking.entries)).toBe('deps       nothing missing')
    expect(menuOf(asking.entries)?.initialValues).not.toContain('deps')
    expect(result.exit, result.stderr).toBe(0)
    expect(readFileSync(join(project.root, 'package.json'), 'utf8')).toBe(before)
    expect(installs(run)).toEqual([])
  })

  it('says nothing is missing and leaves the row unchecked when everything is declared and installed', async () => {
    const project = await initializedProject('deps-nothing-missing')
    const run = installing('agent-qa')

    const result = await rerun(project, ['--yes', '--json'], { run })

    expect(result.exit, result.stderr).toBe(0)
    const doc = JSON.parse(result.stdout) as InitDocument
    expect(doc.setup?.find((row) => row.name === 'deps')).toEqual({
      name: 'deps',
      state: 'nothing missing',
      prechecked: false,
      selected: false,
    })
    expect(doc.steps).toContainEqual({ name: 'deps', outcome: 'skipped', reason: 'current' })
    expect(installs(run)).toEqual([])
  })
})

describe('the deps row under --pm none and after a failed install', () => {
  it('--pm none writes package.json, skips the row with the install command and validate with install first', async () => {
    const project = await subscriptionProjectWithoutPlugin('deps-pm-none-declares')
    const run = installing(SUBSCRIPTION)

    const result = await rerun(project, ['--yes', '--json', '--pm', 'none'], { run })

    expect(result.exit, result.stderr).toBe(0)
    expect(packageJson(project.root).devDependencies[SUBSCRIPTION]).toBe(PROJECT_VERSION)
    expect(installs(run)).toEqual([])
    const doc = JSON.parse(result.stdout) as InitDocument
    expect(doc.steps).toContainEqual({
      name: 'deps',
      outcome: 'skipped',
      reason: '--pm none',
      command: 'npm install',
    })
    expect(doc.steps).toContainEqual({
      name: 'validate',
      outcome: 'skipped',
      reason: 'install first (--pm none)',
      command: 'npx agent-qa validate',
    })
  })

  it('--pm none with nothing to declare still validates', async () => {
    const project = await initializedProject('deps-pm-none-nothing-declared')
    uninstall(project.root, 'agent-qa')
    const run = installing('agent-qa')

    const result = await rerun(project, ['--yes', '--json', '--pm', 'none'], { run })

    expect(result.exit, result.stderr).toBe(0)
    const doc = JSON.parse(result.stdout) as InitDocument
    expect(doc.steps).toContainEqual({
      name: 'deps',
      outcome: 'skipped',
      reason: '--pm none',
      command: 'npm install',
    })
    expect(doc.steps).toContainEqual({ name: 'validate', outcome: 'done' })
  })

  it('a failed install fails the row with the install command, runs the other rows and exits 3', async () => {
    const project = await initializedProject('deps-install-fails')
    uninstall(project.root, 'agent-qa')
    writeFileSync(join(project.root, '.gitignore'), 'dist/\n')
    const run = fakeRunner(({ command, args }) => {
      if (isProbe(args)) return { code: 0, signal: null, output: '11.0.0\n' }
      if (command === NODE) return OK
      return { code: 1, signal: null, output: 'npm error network\n' }
    })

    const result = await rerun(project, ['--yes', '--json'], { run })

    expect(result.exit, result.stderr).toBe(3)
    const doc = JSON.parse(result.stdout) as InitDocument
    expect(doc.steps).toContainEqual({
      name: 'deps',
      outcome: 'failed',
      reason: expect.stringContaining('npm exited 1'),
      command: 'npm install',
    })
    expect(doc.steps).toContainEqual({ name: 'gitignore', outcome: 'done' })
    expect(doc.steps).toContainEqual({ name: 'validate', outcome: 'done' })
  })
})
