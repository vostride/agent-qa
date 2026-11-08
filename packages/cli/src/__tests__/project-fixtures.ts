import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import type { CommandRunner, RunOptions, RunResult } from '../commands/project-host.js'

const roots: string[] = []

function tracked(prefix: string): string {
  const folder = mkdtempSync(join(tmpdir(), prefix))
  roots.push(folder)
  return folder
}

export function tempProject(label: string): { root: string; home: string } {
  const root = tracked(`agent-qa-${label}-`)
  mkdirSync(join(root, '.git'))
  return { root, home: tracked(`agent-qa-${label}-home-`) }
}

export function cleanupTempProjects(): void {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
}

export interface RunnerCall {
  command: string
  args: string[]
  cwd: string
  env: NodeJS.ProcessEnv
  stdio: string
}

export type FakeRunner = CommandRunner & { calls: RunnerCall[] }

export function fakeRunner(
  script: (call: {
    command: string
    args: readonly string[]
    options: RunOptions
  }) => RunResult | Promise<RunResult> = () => ({ code: 0, signal: null, output: '' }),
): FakeRunner {
  const calls: RunnerCall[] = []
  const run: CommandRunner = async (command, args, options) => {
    calls.push({
      command,
      args: [...args],
      cwd: options.cwd,
      env: options.env,
      stdio: options.stdio,
    })
    return await script({ command, args, options })
  }
  return Object.assign(run, { calls })
}

export function skillFolderFiles(
  name: string,
  extra: Record<string, string> = {},
): Record<string, string> {
  const files: Record<string, string> = {
    [`skills/${name}/SKILL.md`]: [
      '---',
      `name: ${name}`,
      `description: Use when a test needs ${name}, with a description long enough that a YAML writer would fold it at eighty columns if it were allowed to.`,
      'metadata:',
      `  short-description: ${name} in short`,
      '---',
      '',
      `# ${name}`,
      '',
      'The body stays as it is.',
      '',
    ].join('\n'),
  }
  for (const [path, content] of Object.entries(extra)) files[`skills/${name}/${path}`] = content
  return files
}

export function writeInstalledPackage(
  dir: string,
  name: string,
  version: string,
  extra: { packageJson?: Record<string, unknown>; files?: Record<string, string> } = {},
): string {
  const packageDir = join(dir, 'node_modules', ...name.split('/'))
  mkdirSync(packageDir, { recursive: true })
  const manifest = join(packageDir, 'package.json')
  writeFileSync(manifest, `${JSON.stringify({ name, version, ...extra.packageJson }, null, 2)}\n`)
  for (const [path, content] of Object.entries(extra.files ?? {})) {
    const file = join(packageDir, path)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, content)
  }
  return manifest
}
