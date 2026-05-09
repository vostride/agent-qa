import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { Command } from 'commander'
import pc from 'picocolors'

export interface BrowserInstallSelection {
  all?: boolean
  chromium?: boolean
  firefox?: boolean
  webkit?: boolean
  withDeps?: boolean
  force?: boolean
}

export interface BrowserInstallResult {
  ok: boolean
  status: number
  stage: 'resolve' | 'spawn' | 'installer'
  error?: unknown
}

export interface BrowserInstallDeps {
  resolveCli?: () => string
  spawn?: typeof spawnSync
}

function selectedBrowserCount(selection: BrowserInstallSelection): number {
  return [selection.chromium, selection.firefox, selection.webkit].filter(Boolean).length
}

function validateBrowserInstallSelection(selection: BrowserInstallSelection): string | null {
  if (!selection.all && selectedBrowserCount(selection) === 0) {
    return 'Select at least one browser flag: --all, --chromium, --firefox, or --webkit.'
  }

  if (selection.all && selectedBrowserCount(selection) > 0) {
    return 'Cannot combine --all with --chromium, --firefox, or --webkit.'
  }

  return null
}

export function buildBrowserInstallArgs(selection: BrowserInstallSelection): string[] {
  const args: string[] = []

  if (selection.withDeps) args.push('--with-deps')
  if (selection.force) args.push('--force')

  if (!selection.all) {
    if (selection.chromium) args.push('chromium')
    if (selection.firefox) args.push('firefox')
    if (selection.webkit) args.push('webkit')
  }

  return args
}

export function formatInstallBrowsersRetryCommand(selection: BrowserInstallSelection): string {
  const args = ['agent-qa', 'install-browsers']

  if (selection.all) {
    args.push('--all')
  } else {
    if (selection.chromium) args.push('--chromium')
    if (selection.firefox) args.push('--firefox')
    if (selection.webkit) args.push('--webkit')
  }

  if (selection.withDeps) args.push('--with-deps')
  if (selection.force) args.push('--force')

  return args.join(' ')
}

export function resolvePlaywrightCoreCli(): string {
  const require = createRequire(import.meta.url)
  const webEntry = require.resolve('@vostride/agent-qa-web')
  const webRequire = createRequire(webEntry)
  const packagePath = webRequire.resolve('playwright-core/package.json')

  return join(dirname(packagePath), 'cli.js')
}

function normalizeSpawnStatus(result: SpawnSyncReturns<Buffer>): number {
  if (typeof result.status === 'number') return result.status
  return 1
}

export function runBrowserInstall(
  selection: BrowserInstallSelection,
  deps: BrowserInstallDeps = {},
): BrowserInstallResult {
  let cliPath: string
  try {
    cliPath = (deps.resolveCli ?? resolvePlaywrightCoreCli)()
  } catch (error) {
    return { ok: false, status: 1, stage: 'resolve', error }
  }

  const spawn = deps.spawn ?? spawnSync
  const result = spawn(process.execPath, [cliPath, 'install', ...buildBrowserInstallArgs(selection)], {
    stdio: 'inherit',
  })

  if (result.error) {
    return { ok: false, status: normalizeSpawnStatus(result), stage: 'spawn', error: result.error }
  }

  const status = normalizeSpawnStatus(result)
  return { ok: status === 0, status, stage: 'installer' }
}

function printBrowserInstallFailure(selection: BrowserInstallSelection, result: BrowserInstallResult): void {
  if (result.stage === 'resolve') {
    console.error(pc.red('agent-qa could not find its bundled browser installer.'))
    console.error(pc.dim('Reinstall agent-qa dependencies, then retry:'))
  } else {
    console.error(pc.red('Browser installation failed.'))
    console.error(pc.dim('Retry:'))
  }

  console.error(`  ${pc.cyan(formatInstallBrowsersRetryCommand(selection))}`)
}

export function createInstallBrowsersCommand(deps: BrowserInstallDeps = {}): Command {
  const cmd = new Command('install-browsers')
    .description('Install browser support for agent-qa')
    .option('--all', 'install all Playwright-managed browsers for agent-qa')
    .option('--chromium', 'install Chromium browser support')
    .option('--firefox', 'install Firefox browser support')
    .option('--webkit', 'install WebKit browser support')
    .option('--with-deps', 'also install required system dependencies')
    .option('--force', 'force reinstall even if browser support already exists')
    .action((opts) => {
      const selection: BrowserInstallSelection = {
        all: !!opts.all,
        chromium: !!opts.chromium,
        firefox: !!opts.firefox,
        webkit: !!opts.webkit,
        withDeps: !!opts.withDeps,
        force: !!opts.force,
      }

      const validationError = validateBrowserInstallSelection(selection)
      if (validationError) {
        console.error(pc.red(`Error: ${validationError}`))
        console.error(cmd.helpInformation())
        process.exitCode = 1
        return
      }

      console.log(pc.blue('Installing agent-qa browser support...'))
      const result = runBrowserInstall(selection, deps)
      if (result.ok) {
        console.log(pc.green('✓ agent-qa browser support installed'))
        return
      }

      printBrowserInstallFailure(selection, result)
      process.exitCode = result.status || 1
    })

  return cmd
}
