import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { Command } from 'commander'
import { vi, type MockInstance } from 'vitest'

import { runCli, type CliFailureDeps } from '../cli-error-handler.js'
import type { CodingAgent } from '../commands/agent-setup.js'
import type { ChromiumResolver } from '../commands/browser-resolver.js'
import type { DashboardPort } from '../commands/init-dashboard.js'
import { createInitCommand, type InitCommandHooks } from '../commands/init.js'
import type { LatestVersionAsk } from '../commands/latest-version-ask.js'
import { composeAnalyticsHost } from '../composition/analytics-host.js'
import { createPlainUi } from '../init-ui/plain-ui.js'
import { fakeInitUi, type FakeInitUiEntry } from './fake-init-ui.js'
import {
  fakeRunner,
  skillFolderFiles,
  tempProject,
  writeInstalledPackage,
  type FakeRunner,
} from './project-fixtures.js'

const NODE = '/fake/node'

export const foundChromium: ChromiumResolver = () => ({ found: true, path: '/fake/chromium' })
export const noChromium: ChromiumResolver = () => ({ found: false, reason: 'no file at /fake' })
export const noLatestVersion: LatestVersionAsk = async () => ({ source: 'none' })
// An interactive re-run whose model is pending starts the dashboard through the fake runner.
export const freeDashboardPort: DashboardPort = {
  probe: async () => 'free',
  findFree: async () => 49_731,
}

export interface InitializedProject {
  root: string
  home: string
}

export interface RerunResult {
  exit: number
  stdout: string
  stderr: string
  entries: FakeInitUiEntry[]
}

export interface RerunOptions {
  run?: FakeRunner
  // Draws through the plain renderer on stderr instead of recording entries.
  plain?: boolean
  // The fake UI's answers, by question; unanswered questions take their defaults.
  answers?: Record<string, unknown>
  hooks?: InitCommandHooks
}

const silentAnalytics: typeof composeAnalyticsHost = async () =>
  composeAnalyticsHost({
    surface: 'cli',
    env: {},
    transportOverride: { capture: () => {}, flush: () => {}, shutdown: () => {} },
    resolveIdentity: async () => ({ distinctId: 'u_init-rerun', runtimeContext: 'user' }),
  })

function capture(stream: NodeJS.WriteStream): { text(): string; release(): void } {
  const mocked = vi.isMockFunction(stream.write)
  if (!mocked) vi.spyOn(stream, 'write').mockImplementation(() => true)
  const spy = stream.write as unknown as MockInstance<(chunk: unknown) => boolean>
  const start = spy.mock.calls.length
  return {
    text: () =>
      spy.mock.calls
        .slice(start)
        .map((call) => String(call[0]))
        .join(''),
    release: () => {
      if (!mocked) spy.mockRestore()
    },
  }
}

async function runInit(
  project: InitializedProject,
  args: readonly string[],
  options: RerunOptions,
): Promise<RerunResult> {
  const ui = fakeInitUi(options.answers)
  const out = capture(process.stdout)
  const err = capture(process.stderr)
  const handler: string[] = []
  let exit = 0
  try {
    const program = new Command('agent-qa')
      .option('--config <path>', 'config file path', 'agent-qa.config.yaml')
      .addCommand(
        createInitCommand({
          cwd: project.root,
          isTTY: false,
          composeAnalytics: silentAnalytics,
          ui: options.plain === true ? createPlainUi() : ui,
          chromium: foundChromium,
          latestVersion: noLatestVersion,
          dashboardPort: freeDashboardPort,
          ...options.hooks,
          host: {
            homedir: project.home,
            env: {},
            run: options.run ?? fakeRunner(),
            argv: ['init', ...args],
            execPath: NODE,
            ...options.hooks?.host,
          },
        }),
      )
    const deps: CliFailureDeps = {
      print: (text) => handler.push(`${text}\n`),
      printFixed: (line) => handler.push(`${line}\n`),
      mask: (text) => text,
      setExitCode: () => {},
      flush: async () => {},
      exit: (code) => {
        exit = code
      },
      env: {},
    }
    await runCli(program, ['node', 'agent-qa', 'init', ...args], deps)
    return {
      exit,
      stdout: out.text(),
      stderr: err.text() + handler.join(''),
      entries: ui.entries,
    }
  } finally {
    out.release()
    err.release()
  }
}

// Each package the fresh init declared is in node_modules at its version. With no bin, none of them
// is a copy of agent-qa that runs a step, so the running agent-qa still runs every one.
export function installDeclaredPackages(root: string): void {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
    devDependencies?: Record<string, string>
  }
  for (const [name, version] of Object.entries(pkg.devDependencies ?? {})) {
    writeInstalledPackage(root, name, version)
  }
}

// A fresh init whose install went through.
export async function initializedProject(
  label: string,
  { platform = 'web', llm = 'gemini' }: { platform?: string; llm?: string } = {},
): Promise<InitializedProject> {
  const project = tempProject(label)
  const fresh = await runInit(
    project,
    [
      '--yes',
      '--pm',
      'none',
      '--no-browsers',
      '--agents',
      'none',
      '--llm',
      llm,
      '--platform',
      platform,
    ],
    {},
  )
  if (fresh.exit !== 0) {
    throw new Error(`the fresh init exited ${fresh.exit}:\n${fresh.stderr}`)
  }
  installDeclaredPackages(project.root)
  return project
}

// The installed agent-qa ships these skills, each with one SKILL.md.
export const INSTALLED_SKILLS = ['agent-qa-alpha', 'agent-qa-beta'] as const

export function installAgentQaFixture(root: string, version: string): void {
  const files: Record<string, string> = { 'dist/cli.js': '' }
  for (const skill of INSTALLED_SKILLS) Object.assign(files, skillFolderFiles(skill))
  writeInstalledPackage(root, 'agent-qa', version, {
    packageJson: { bin: { 'agent-qa': 'dist/cli.js' } },
    files,
  })
}

// A fresh init with one coding agent, its skills taken from an installed agent-qa fixture.
export async function initializedProjectWithAgent(
  label: string,
  agent: CodingAgent,
  version: string,
): Promise<InitializedProject> {
  const project = tempProject(label)
  installAgentQaFixture(project.root, version)
  const fresh = await runInit(
    project,
    ['--yes', '--pm', 'none', '--no-browsers', '--agents', agent, '--llm', 'gemini'],
    {},
  )
  if (fresh.exit !== 0) {
    throw new Error(`the fresh init exited ${fresh.exit}:\n${fresh.stderr}`)
  }
  return project
}

export function editSkillFile(project: InitializedProject, path: string): void {
  const file = join(project.root, path)
  writeFileSync(file, `${readFileSync(file, 'utf-8')}\nMy own note.\n`)
}

export async function rerun(
  project: InitializedProject,
  args: readonly string[] = [],
  options: RerunOptions = {},
): Promise<RerunResult> {
  return await runInit(project, args, options)
}
