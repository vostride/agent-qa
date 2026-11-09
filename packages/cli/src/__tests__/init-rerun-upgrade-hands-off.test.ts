import { readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { parseDocument, type YAMLSeq } from 'yaml'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { InitDocument } from '../commands/init-document.js'
import { SETUP_MENU_QUESTION } from '../commands/init-rerun.js'
import type { LatestVersionAsk } from '../commands/latest-version-ask.js'
import type { RunResult } from '../commands/project-host.js'
import type { FakeInitUiEntry } from './fake-init-ui.js'
import {
  cleanupTempProjects,
  fakeRunner,
  tempProject,
  writeInstalledPackage,
  type FakeRunner,
  type RunnerCall,
} from './project-fixtures.js'
import {
  initializedProject,
  initializedProjectWithAgent,
  installAgentQaFixture,
  rerun,
  type InitializedProject,
} from './rerun-fixtures.js'

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

function answering(version: string): LatestVersionAsk {
  return async () => ({ source: 'registry', latestVersion: version })
}

function isProbe(args: readonly string[]): boolean {
  return args.length === 1 && args[0] === '--version'
}

function isChildInit(call: { command: string; args: readonly string[] }): boolean {
  return call.command === NODE && call.args[1] === 'init'
}

// The install writes the newly installed copies; the hand-off answers with the child's result.
function upgradeMachine(
  latest: string,
  { child = OK, others = [] }: { child?: RunResult; others?: readonly string[] } = {},
): FakeRunner {
  return fakeRunner(({ command, args, options }) => {
    if (isProbe(args)) return { code: 0, signal: null, output: '11.0.0\n' }
    if (isChildInit({ command, args })) return child
    if (command === NODE) return OK
    installAgentQaFixture(options.cwd, latest)
    for (const name of others) writeInstalledPackage(options.cwd, name, latest)
    return OK
  })
}

function commands(run: FakeRunner): RunnerCall[] {
  return run.calls.filter((call) => !isProbe(call.args))
}

function childOf(run: FakeRunner): RunnerCall | undefined {
  return run.calls.find(isChildInit)
}

function newBin(project: InitializedProject): string {
  return join(realpathSync(project.root), 'node_modules', 'agent-qa', 'dist', 'cli.js')
}

function menuOf(entries: readonly FakeInitUiEntry[]) {
  const entry = entries.find(
    (item) => item.kind === 'multiselect' && item.text === SETUP_MENU_QUESTION,
  )
  return entry?.kind === 'multiselect' ? entry : undefined
}

function addPlugin(root: string, name: string, pkg: string): void {
  const path = join(root, 'agent-qa.config.yaml')
  const doc = parseDocument(readFileSync(path, 'utf8'))
  const plugins = doc.get('plugins') as YAMLSeq | undefined
  if (plugins === undefined) doc.set('plugins', [{ name, package: pkg }])
  else plugins.add(doc.createNode({ name, package: pkg }))
  writeFileSync(path, doc.toString())
}

function writePackageJson(root: string, devDependencies: Record<string, string>): string {
  const text = `${JSON.stringify({ name: 'app', private: true, devDependencies }, null, 4)}\n`
  writeFileSync(join(root, 'package.json'), text)
  return text
}

function packageJsonText(root: string): string {
  return readFileSync(join(root, 'package.json'), 'utf8')
}

// A project on agent-qa with a subscription model, its plugin and a first-party plugins entry.
async function projectWithPlugins(label: string, jiraSpec: string): Promise<InitializedProject> {
  const project = await initializedProject(label, { llm: 'codex' })
  addPlugin(project.root, 'jira', JIRA)
  writePackageJson(project.root, {
    [JIRA]: jiraSpec,
    [SUBSCRIPTION]: PROJECT_VERSION,
    'agent-qa': PROJECT_VERSION,
  })
  return project
}

describe("the re-run's upgrade row moves the project to a newer agent-qa patch", () => {
  it('offers the newer patch as the first row, pre-checked and labelled with the versions', async () => {
    const project = await initializedProject('upgrade-row-patch')

    const result = await rerun(project, [], {
      hooks: { isTTY: true, latestVersion: answering('0.3.2') },
      answers: { [SETUP_MENU_QUESTION]: [] },
    })

    expect(result.exit, result.stderr).toBe(0)
    const menu = menuOf(result.entries)
    expect(menu?.labels[0]).toBe('upgrade    agent-qa 0.3.0 → 0.3.2')
    expect(menu?.initialValues).toContain('upgrade')
  })

  it('names the plugins the bump moves in its label', async () => {
    const project = await projectWithPlugins('upgrade-row-plugins', PROJECT_VERSION)

    const result = await rerun(project, [], {
      hooks: { isTTY: true, latestVersion: answering('0.3.2') },
      answers: { [SETUP_MENU_QUESTION]: [] },
    })

    expect(result.exit, result.stderr).toBe(0)
    expect(menuOf(result.entries)?.labels[0]).toBe(
      'upgrade    agent-qa and 2 plugins 0.3.0 → 0.3.2',
    )
  })

  it("bumps agent-qa and every first-party package to exactly the latest, keeping the file's formatting", async () => {
    const project = await projectWithPlugins('upgrade-bumps-every-package', PROJECT_VERSION)
    const run = upgradeMachine('0.3.2', { others: [SUBSCRIPTION, JIRA] })

    const result = await rerun(project, ['--yes'], {
      run,
      hooks: { latestVersion: answering('0.3.2') },
    })

    expect(result.exit, result.stderr).toBe(0)
    const expected = `${JSON.stringify(
      {
        name: 'app',
        private: true,
        devDependencies: { [JIRA]: '0.3.2', [SUBSCRIPTION]: '0.3.2', 'agent-qa': '0.3.2' },
      },
      null,
      4,
    )}\n`
    expect(packageJsonText(project.root)).toBe(expected)
  })

  it('keeps a non-registry spec and leaves that plugin out of the label', async () => {
    const project = await projectWithPlugins('upgrade-keeps-file-spec', 'file:../jira')
    const run = upgradeMachine('0.3.2', { others: [SUBSCRIPTION, JIRA] })

    const asked = await rerun(project, [], {
      hooks: { isTTY: true, latestVersion: answering('0.3.2') },
      answers: { [SETUP_MENU_QUESTION]: [] },
    })
    const result = await rerun(project, ['--yes'], {
      run,
      hooks: { latestVersion: answering('0.3.2') },
    })

    expect(menuOf(asked.entries)?.labels[0]).toBe(
      'upgrade    agent-qa and the plugin 0.3.0 → 0.3.2',
    )
    expect(result.exit, result.stderr).toBe(0)
    expect(JSON.parse(packageJsonText(project.root)).devDependencies).toEqual({
      [JIRA]: 'file:../jira',
      [SUBSCRIPTION]: '0.3.2',
      'agent-qa': '0.3.2',
    })
  })

  it('installs once with the plain install, then hands the run to the new copy with constructed arguments', async () => {
    const project = await initializedProject('upgrade-hands-off')
    const run = upgradeMachine('0.3.2')

    const result = await rerun(project, ['--yes'], {
      run,
      hooks: { latestVersion: answering('0.3.2') },
    })

    expect(result.exit, result.stderr).toBe(0)
    const [install, child, ...rest] = commands(run)
    expect(rest).toEqual([])
    expect(install).toMatchObject({
      command: 'npm',
      args: ['install'],
      cwd: realpathSync(project.root),
      stdio: 'capture',
    })
    expect(child).toMatchObject({
      command: NODE,
      args: [newBin(project), 'init', '--setup', 'none', '--agents', 'none', '--yes'],
      cwd: project.root,
      stdio: 'inherit',
    })
    expect(child?.env.AGENT_QA_HANDED_OFF).toBe('1')
    expect(child?.env.AGENT_QA_UPGRADED_FROM).toBe(PROJECT_VERSION)
  })

  it('refreshes the skills, the MCP entries and the AGENTS.md block when a coding agent is chosen', async () => {
    const project = await initializedProjectWithAgent(
      'upgrade-refreshes-agents',
      'claude-code',
      PROJECT_VERSION,
    )
    const run = upgradeMachine('0.3.2')

    const result = await rerun(project, ['--yes'], {
      run,
      hooks: { latestVersion: answering('0.3.2') },
    })

    expect(result.exit, result.stderr).toBe(0)
    expect(childOf(run)?.args.slice(1)).toEqual([
      'init',
      '--setup',
      'skills,mcp,agents-md',
      '--agents',
      'claude-code',
      '--yes',
    ])
  })

  it("passes on the run's own --json, --pm, --no-dashboard and --no-browsers and writes no document itself", async () => {
    const project = await initializedProject('upgrade-passes-flags')
    const run = upgradeMachine('0.3.2')

    const result = await rerun(
      project,
      ['--yes', '--json', '--pm', 'npm', '--no-dashboard', '--no-browsers'],
      { run, hooks: { latestVersion: answering('0.3.2') } },
    )

    expect(result.exit, result.stderr).toBe(0)
    expect(childOf(run)?.args.slice(1)).toEqual([
      'init',
      '--setup',
      'none',
      '--agents',
      'none',
      '--json',
      '--yes',
      '--pm',
      'npm',
      '--no-dashboard',
      '--no-browsers',
    ])
    expect(result.stdout).toBe('')
  })

  it("exits with the new copy's exit code", async () => {
    const project = await initializedProject('upgrade-child-exit')
    const run = upgradeMachine('0.3.2', { child: { code: 3, signal: null, output: '' } })

    const result = await rerun(project, ['--yes', '--json'], {
      run,
      hooks: { latestVersion: answering('0.3.2') },
    })

    expect(result.exit).toBe(3)
    expect(result.stdout).toBe('')
  })

  it.each([
    ['nothing newer is published', { source: 'registry', latestVersion: PROJECT_VERSION }],
    ['the version check did not answer', { source: 'none' }],
  ] as const)('hides the row with "%s"', async (reason, answer) => {
    const project = await initializedProject('upgrade-row-hidden')
    const run = upgradeMachine('0.3.2')

    const result = await rerun(project, ['--yes', '--json'], {
      run,
      hooks: { latestVersion: async () => answer },
    })

    expect(result.exit, result.stderr).toBe(0)
    const doc = JSON.parse(result.stdout) as InitDocument
    expect(doc.setup?.[0]).toEqual({
      name: 'upgrade',
      state: reason,
      prechecked: false,
      selected: false,
      hidden: reason,
    })
    expect(commands(run).filter((call) => call.command !== NODE)).toEqual([])
  })
})

function summaryLines(entries: readonly FakeInitUiEntry[]): string[] {
  const entry = entries.find((item) => item.kind === 'summary')
  return entry?.kind === 'summary' ? entry.lines : []
}

describe('an upgrade that can break the config is taken only when named', () => {
  it('starts unchecked, keeps the versions in its label and puts the migration guide in the summary', async () => {
    const project = await initializedProject('upgrade-breaking-unchecked')

    const result = await rerun(project, [], {
      hooks: { isTTY: true, latestVersion: answering('0.4.0') },
      answers: { [SETUP_MENU_QUESTION]: [] },
    })

    expect(result.exit, result.stderr).toBe(0)
    const menu = menuOf(result.entries)
    expect(menu?.labels[0]).toBe('upgrade    agent-qa 0.3.0 → 0.4.0')
    expect(menu?.initialValues).not.toContain('upgrade')
    expect(summaryLines(result.entries)).toEqual(
      expect.arrayContaining([
        'agent-qa 0.4.0 can change your config. To upgrade, point your coding agent at',
        'https://vostride.com/docs/agent-qa/migrate/v0-3-to-v0-4',
      ]),
    )
  })

  it('--yes leaves package.json as it was and records the upgrade not selected', async () => {
    const project = await initializedProject('upgrade-breaking-yes')
    const before = packageJsonText(project.root)
    const run = upgradeMachine('0.4.0')

    const result = await rerun(project, ['--yes', '--json'], {
      run,
      hooks: { latestVersion: answering('0.4.0') },
    })

    expect(result.exit, result.stderr).toBe(0)
    expect(packageJsonText(project.root)).toBe(before)
    const doc = JSON.parse(result.stdout) as InitDocument
    expect(doc.steps).toContainEqual({
      name: 'upgrade',
      outcome: 'skipped',
      reason: 'not selected',
      command: 'npx agent-qa init --setup upgrade',
    })
    expect(childOf(run)).toBeUndefined()
  })

  it('--setup all runs the other shown rows and leaves a breaking upgrade out with its reason', async () => {
    const project = await initializedProject('upgrade-breaking-setup-all')
    writeFileSync(join(project.root, '.gitignore'), 'dist/\n')
    const before = packageJsonText(project.root)
    const run = upgradeMachine('0.4.0')

    const result = await rerun(project, ['--setup', 'all', '--json'], {
      run,
      hooks: { latestVersion: answering('0.4.0') },
    })

    expect(result.exit, result.stderr).toBe(0)
    expect(childOf(run)).toBeUndefined()
    expect(commands(run).filter((call) => call.command !== NODE)).toEqual([])
    expect(packageJsonText(project.root)).toBe(before)
    const doc = JSON.parse(result.stdout) as InitDocument
    expect(doc.steps).toContainEqual({
      name: 'upgrade',
      outcome: 'skipped',
      reason: 'breaking: name it in --setup',
      command: 'npx agent-qa init --setup upgrade',
    })
    expect(doc.steps).toContainEqual({ name: 'gitignore', outcome: 'done' })
  })

  it('--setup all takes an upgrade that crosses no breaking step', async () => {
    const project = await initializedProject('upgrade-patch-setup-all')
    const run = upgradeMachine('0.3.2')

    const result = await rerun(project, ['--setup', 'all'], {
      run,
      hooks: { latestVersion: answering('0.3.2') },
    })

    expect(result.exit, result.stderr).toBe(0)
    expect(childOf(run)?.env.AGENT_QA_UPGRADED_FROM).toBe(PROJECT_VERSION)
  })

  it('--setup upgrade takes a breaking upgrade and hands off to the new copy', async () => {
    const project = await initializedProject('upgrade-breaking-named')
    const run = upgradeMachine('0.4.0')

    const result = await rerun(project, ['--setup', 'upgrade'], {
      run,
      hooks: { latestVersion: answering('0.4.0') },
    })

    expect(result.exit, result.stderr).toBe(0)
    expect(JSON.parse(packageJsonText(project.root)).devDependencies['agent-qa']).toBe('0.4.0')
    expect(childOf(run)?.args.slice(1)).toEqual(['init', '--setup', 'none', '--agents', 'none'])
    expect(childOf(run)?.env.AGENT_QA_UPGRADED_FROM).toBe(PROJECT_VERSION)
  })
})

const GUIDE_0_3_TO_0_4 = 'https://vostride.com/docs/agent-qa/migrate/v0-3-to-v0-4'

describe("the re-run's document reports the version move the upgrade row offers", () => {
  it('names a breaking move with its migration guide when the row is not run', async () => {
    const project = await initializedProject('upgrade-document-breaking')

    const result = await rerun(project, ['--yes', '--json'], {
      run: upgradeMachine('0.4.0'),
      hooks: { latestVersion: answering('0.4.0') },
    })

    expect(result.exit, result.stderr).toBe(0)
    const doc = JSON.parse(result.stdout) as InitDocument
    expect(doc.upgrade).toEqual({
      from: PROJECT_VERSION,
      to: '0.4.0',
      breaking: true,
      links: [GUIDE_0_3_TO_0_4],
      row: 'upgrade',
    })
  })

  it('names a patch move with its release notes', async () => {
    const project = await initializedProject('upgrade-document-patch')

    const result = await rerun(project, ['--setup', 'none', '--json'], {
      run: upgradeMachine('0.3.2'),
      hooks: { latestVersion: answering('0.3.2') },
    })

    expect(result.exit, result.stderr).toBe(0)
    const doc = JSON.parse(result.stdout) as InitDocument
    expect(doc.upgrade).toEqual({
      from: PROJECT_VERSION,
      to: '0.3.2',
      breaking: false,
      links: ['https://github.com/vostride/agent-qa/releases/tag/v0.3.2'],
      row: 'upgrade',
    })
  })

  it('has no upgrade when nothing newer is published', async () => {
    const project = await initializedProject('upgrade-document-current')

    const result = await rerun(project, ['--yes', '--json'], {
      hooks: { latestVersion: answering(PROJECT_VERSION) },
    })

    expect(result.exit, result.stderr).toBe(0)
    expect(JSON.parse(result.stdout)).not.toHaveProperty('upgrade')
  })

  it('has no upgrade on a fresh init', async () => {
    const project = tempProject('upgrade-document-fresh')

    const result = await rerun(
      project,
      ['--yes', '--json', '--pm', 'none', '--no-browsers', '--agents', 'none', '--llm', 'gemini'],
      { hooks: { latestVersion: answering('0.4.0') } },
    )

    expect(result.exit, result.stderr).toBe(0)
    expect(JSON.parse(result.stdout)).not.toHaveProperty('upgrade')
  })
})

// A project the upgrade moved to 0.4.0, re-run by the newly installed copy.
async function upgradedProject(label: string): Promise<InitializedProject> {
  const project = await initializedProject(label)
  installAgentQaFixture(project.root, '0.4.0')
  const pkg = JSON.parse(packageJsonText(project.root)) as {
    devDependencies: Record<string, string>
  }
  pkg.devDependencies['agent-qa'] = '0.4.0'
  writeFileSync(join(project.root, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`)
  running.version = '0.4.0'
  return project
}

const HANDED_ARGS = ['--setup', 'none', '--agents', 'none', '--yes']

function stepTexts(entries: readonly FakeInitUiEntry[], kind: 'done' | 'skipped'): string[] {
  return entries.flatMap((entry) => (entry.kind === kind ? [entry.text] : []))
}

describe('the newly installed copy reports the upgrade it was handed', () => {
  it('records the upgrade done in its step line, summary and document', async () => {
    const project = await upgradedProject('upgrade-child-reports')
    const env = { AGENT_QA_HANDED_OFF: '1', AGENT_QA_UPGRADED_FROM: PROJECT_VERSION }
    const run = upgradeMachine('0.4.0')
    const hooks = { latestVersion: answering('0.4.0'), host: { env } }

    const drawn = await rerun(project, HANDED_ARGS, { run, hooks })
    const result = await rerun(project, [...HANDED_ARGS, '--json'], { run, hooks })

    expect(drawn.exit, drawn.stderr).toBe(0)
    expect(stepTexts(drawn.entries, 'done')).toContain(
      `upgrade: agent-qa ${PROJECT_VERSION} → 0.4.0`,
    )
    expect(summaryLines(drawn.entries)).toContain(`Upgraded agent-qa ${PROJECT_VERSION} → 0.4.0.`)
    expect(result.exit, result.stderr).toBe(0)
    const doc = JSON.parse(result.stdout) as InitDocument
    expect(doc.steps).toContainEqual({ name: 'upgrade', outcome: 'done' })
    expect(doc.upgrade).toEqual({
      from: PROJECT_VERSION,
      to: '0.4.0',
      breaking: true,
      links: [GUIDE_0_3_TO_0_4],
      row: 'upgrade',
    })
    expect(childOf(run)).toBeUndefined()
  })

  it.each([
    [
      'a value that is not a version',
      { AGENT_QA_HANDED_OFF: '1', AGENT_QA_UPGRADED_FROM: 'latest' },
    ],
    ['the running version', { AGENT_QA_HANDED_OFF: '1', AGENT_QA_UPGRADED_FROM: '0.4.0' }],
    ['a newer version', { AGENT_QA_HANDED_OFF: '1', AGENT_QA_UPGRADED_FROM: '0.5.0' }],
    ['an older version without the hand-off', { AGENT_QA_UPGRADED_FROM: PROJECT_VERSION }],
  ] as const)('ignores %s', async (_label, env) => {
    const project = await upgradedProject('upgrade-child-ignores')

    const result = await rerun(project, [...HANDED_ARGS, '--json'], {
      run: upgradeMachine('0.4.0'),
      hooks: { latestVersion: answering('0.4.0'), host: { env } },
    })

    expect(result.exit, result.stderr).toBe(0)
    const doc = JSON.parse(result.stdout) as InitDocument
    expect(doc).not.toHaveProperty('upgrade')
    expect(doc.steps.map((step) => step.name)).not.toContain('upgrade')
  })
})

describe('an upgrade that is not installed keeps the other rows running', () => {
  it('--pm none declares the latest versions, hands nothing off and leaves validate for after the install', async () => {
    const project = await initializedProject('upgrade-pm-none')
    writeFileSync(join(project.root, '.gitignore'), 'dist/\n')
    const run = upgradeMachine('0.3.2')

    const result = await rerun(project, ['--yes', '--json', '--pm', 'none'], {
      run,
      hooks: { latestVersion: answering('0.3.2') },
    })

    expect(result.exit, result.stderr).toBe(0)
    expect(JSON.parse(packageJsonText(project.root)).devDependencies['agent-qa']).toBe('0.3.2')
    expect(childOf(run)).toBeUndefined()
    expect(commands(run)).toEqual([])
    const doc = JSON.parse(result.stdout) as InitDocument
    expect(doc.steps).toContainEqual({
      name: 'upgrade',
      outcome: 'skipped',
      reason: '--pm none',
      command: 'npm install',
    })
    expect(doc.steps).toContainEqual({ name: 'gitignore', outcome: 'done' })
    expect(doc.steps).toContainEqual({
      name: 'validate',
      outcome: 'skipped',
      reason: 'install first (--pm none)',
      command: 'npx agent-qa validate',
    })
    expect(doc.upgrade).toMatchObject({ from: PROJECT_VERSION, to: '0.3.2', row: 'upgrade' })
  })

  it('a failed install fails the upgrade with the install command, runs the other rows here and exits 3', async () => {
    const project = await initializedProject('upgrade-install-fails')
    writeFileSync(join(project.root, '.gitignore'), 'dist/\n')
    const run = fakeRunner(({ command, args }) => {
      if (isProbe(args)) return { code: 0, signal: null, output: '11.0.0\n' }
      if (command === NODE) return OK
      return { code: 1, signal: null, output: 'npm error network\n' }
    })

    const result = await rerun(project, ['--yes', '--json'], {
      run,
      hooks: { latestVersion: answering('0.3.2') },
    })

    expect(result.exit, result.stderr).toBe(3)
    expect(childOf(run)).toBeUndefined()
    const doc = JSON.parse(result.stdout) as InitDocument
    expect(doc.outcome).toBe('failed')
    expect(doc.exitCode).toBe(3)
    expect(doc.steps).toContainEqual({
      name: 'upgrade',
      outcome: 'failed',
      reason: expect.stringContaining('npm exited 1'),
      command: 'npm install',
    })
    expect(doc.steps).toContainEqual({ name: 'gitignore', outcome: 'done' })
    expect(doc.steps).toContainEqual({ name: 'validate', outcome: 'done' })
  })
})
