import { execFileSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { Command } from 'commander'
import pc from 'picocolors'
import {
  formatAppiumInstallGuidance,
  resolveAppiumExecutable,
  type ResolvedAppiumExecutable,
} from '@vostride/agent-qa-core'

export type MobileDriverName = 'uiautomator2' | 'xcuitest'
export type MobileDriverTarget = 'android' | 'ios'

export interface MobileDriverInstallSelection {
  all?: boolean
  android?: boolean
  ios?: boolean
  update?: boolean
  unsafe?: boolean
  cwd?: string
}

export interface MobileDriverInstallEvent {
  driver: MobileDriverName
  label: string
  action: 'install' | 'reuse' | 'update'
  ok: boolean
  error?: unknown
}

export interface MobileDriverInstallResult {
  ok: boolean
  status: number
  stage: 'resolve' | 'check' | 'list' | 'driver'
  appium?: ResolvedAppiumExecutable
  events: MobileDriverInstallEvent[]
  error?: unknown
}

export interface MobileDriverInstallDeps {
  resolveAppium?: typeof resolveAppiumExecutable
  execFile?: AppiumExecFile
}

export type AppiumExecFile = (
  file: string,
  args: string[],
  options?: Record<string, unknown>,
) => Buffer | string

interface MobileDriverDefinition {
  target: MobileDriverTarget
  driver: MobileDriverName
  label: string
}

const MOBILE_DRIVERS: MobileDriverDefinition[] = [
  { target: 'android', driver: 'uiautomator2', label: 'UiAutomator2' },
  { target: 'ios', driver: 'xcuitest', label: 'XCUITest' },
]

function selectedTargetCount(selection: MobileDriverInstallSelection): number {
  return [selection.android, selection.ios].filter(Boolean).length
}

function selectedDrivers(selection: MobileDriverInstallSelection): MobileDriverDefinition[] {
  if (selection.all) return MOBILE_DRIVERS
  return MOBILE_DRIVERS.filter((driver) => selection[driver.target])
}

export function validateMobileDriverInstallSelection(selection: MobileDriverInstallSelection): string | null {
  if (!selection.all && selectedTargetCount(selection) === 0) {
    return 'Select at least one mobile platform flag: --all, --android, or --ios.'
  }

  if (selection.all && selectedTargetCount(selection) > 0) {
    return 'Cannot combine --all with --android or --ios.'
  }

  if (selection.unsafe && !selection.update) {
    return 'Cannot use --unsafe without --update.'
  }

  return null
}

export function formatInstallMobileDriversRetryCommand(selection: MobileDriverInstallSelection): string {
  const args = ['agent-qa', 'install-mobile-drivers']

  if (selection.all) {
    args.push('--all')
  } else {
    if (selection.android) args.push('--android')
    if (selection.ios) args.push('--ios')
  }

  if (selection.update) args.push('--update')
  if (selection.unsafe) args.push('--unsafe')

  return args.join(' ')
}

function collectDriverNames(value: unknown, names: Set<string>): void {
  if (!value) return
  if (typeof value === 'string') {
    names.add(value)
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) collectDriverNames(item, names)
    return
  }
  if (typeof value !== 'object') return

  const record = value as Record<string, unknown>
  if (typeof record.name === 'string') names.add(record.name)
  if (typeof record.driverName === 'string') names.add(record.driverName)
  if (typeof record.automationName === 'string') names.add(record.automationName)

  for (const [key, child] of Object.entries(record)) {
    if (key !== 'drivers' && key !== 'installed' && key !== 'name' && key !== 'driverName' && typeof child === 'object' && child !== null) {
      names.add(key)
    }
    collectDriverNames(child, names)
  }
}

export function parseInstalledAppiumDrivers(output: string): Set<string> {
  const names = new Set<string>()
  const trimmed = output.trim()
  if (!trimmed) return names

  try {
    collectDriverNames(JSON.parse(trimmed), names)
    const normalizedNames = new Set<string>()
    for (const name of names) {
      const normalized = name.toLowerCase()
      normalizedNames.add(normalized)
      if (normalized.includes('uiautomator2')) normalizedNames.add('uiautomator2')
      if (normalized.includes('xcuitest')) normalizedNames.add('xcuitest')
    }
    return normalizedNames
  } catch {
    for (const line of trimmed.split('\n')) {
      const normalized = line.toLowerCase()
      if (normalized.includes('uiautomator2')) names.add('uiautomator2')
      if (normalized.includes('xcuitest')) names.add('xcuitest')
    }
    return names
  }
}

function errorStatus(error: unknown): number {
  const status = (error as { status?: unknown } | undefined)?.status
  return typeof status === 'number' ? status : 1
}

function isMissingExecutableError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT'
}

function isAlreadyInstalledDriverError(error: unknown, driver: MobileDriverName): boolean {
  const details = [
    error instanceof Error ? error.message : String(error),
    (error as { stdout?: unknown } | undefined)?.stdout,
    (error as { stderr?: unknown } | undefined)?.stderr,
  ].map(String).join('\n').toLowerCase()

  return details.includes(`driver named "${driver}" is already installed`)
    || details.includes(`${driver}" is already installed`)
    || details.includes(`${driver} is already installed`)
}

function getInstalledAppiumDrivers(appiumCommand: string, execFile: AppiumExecFile): { ok: true; drivers: Set<string> } | { ok: false; error: unknown; status: number } {
  try {
    const output = execFile(appiumCommand, ['driver', 'list', '--installed', '--json'], { stdio: 'pipe', encoding: 'utf-8' })
    return { ok: true, drivers: parseInstalledAppiumDrivers(String(output)) }
  } catch {
    try {
      const output = execFile(appiumCommand, ['driver', 'list', '--installed'], { stdio: 'pipe', encoding: 'utf-8' })
      return { ok: true, drivers: parseInstalledAppiumDrivers(String(output)) }
    } catch (error) {
      return { ok: false, error, status: errorStatus(error) }
    }
  }
}

function driverOperationArgs(driver: MobileDriverName, selection: MobileDriverInstallSelection, installed: boolean): { action: 'install' | 'reuse' | 'update'; args: string[] | null } {
  if (installed && !selection.update) {
    return { action: 'reuse', args: null }
  }

  if (installed && selection.update) {
    const args = ['driver', 'update', driver]
    if (selection.unsafe) args.push('--unsafe')
    return { action: 'update', args }
  }

  return { action: 'install', args: ['driver', 'install', driver] }
}

export function runMobileDriverInstall(
  selection: MobileDriverInstallSelection,
  deps: MobileDriverInstallDeps = {},
): MobileDriverInstallResult {
  const resolveAppium = deps.resolveAppium ?? resolveAppiumExecutable
  const execFile = deps.execFile ?? execFileSync
  const events: MobileDriverInstallEvent[] = []

  let appium: ResolvedAppiumExecutable
  try {
    appium = resolveAppium({ cwd: selection.cwd ?? process.cwd() })
  } catch (error) {
    return { ok: false, status: 1, stage: 'resolve', events, error }
  }

  try {
    execFile(appium.command, ['--version'], { stdio: 'pipe' })
  } catch (error) {
    return { ok: false, status: errorStatus(error), stage: 'check', appium, events, error }
  }

  const installedResult = getInstalledAppiumDrivers(appium.command, execFile)
  if (!installedResult.ok) {
    return { ok: false, status: installedResult.status, stage: 'list', appium, events, error: installedResult.error }
  }

  let status = 0
  for (const definition of selectedDrivers(selection)) {
    const installed = installedResult.drivers.has(definition.driver)
    const operation = driverOperationArgs(definition.driver, selection, installed)
    if (!operation.args) {
      events.push({ driver: definition.driver, label: definition.label, action: operation.action, ok: true })
      continue
    }

    try {
      execFile(appium.command, operation.args, { stdio: 'inherit' })
      events.push({ driver: definition.driver, label: definition.label, action: operation.action, ok: true })
    } catch (error) {
      if (operation.action === 'install' && isAlreadyInstalledDriverError(error, definition.driver)) {
        events.push({ driver: definition.driver, label: definition.label, action: 'reuse', ok: true })
        continue
      }

      status = status || errorStatus(error)
      events.push({ driver: definition.driver, label: definition.label, action: operation.action, ok: false, error })
    }
  }

  return { ok: status === 0, status, stage: 'driver', appium, events }
}

function resolveCommandCwd(command: Command): string {
  const configPath = command.parent?.opts<{ config?: string }>().config ?? 'agent-qa.config.yaml'
  return dirname(resolve(configPath))
}

function printMobileDriverInstallResult(selection: MobileDriverInstallSelection, result: MobileDriverInstallResult): void {
  if (result.stage === 'check' && isMissingExecutableError(result.error)) {
    console.error(pc.red('Appium not found.'))
    console.error(pc.dim(formatAppiumInstallGuidance()))
    return
  }

  if (result.stage === 'resolve') {
    console.error(pc.red('agent-qa could not resolve an Appium executable.'))
    console.error(pc.dim(formatAppiumInstallGuidance()))
    return
  }

  if (result.stage === 'check') {
    console.error(pc.red('Could not run Appium.'))
    console.error(pc.dim(formatAppiumInstallGuidance()))
    return
  }

  if (result.stage === 'list') {
    console.error(pc.red('Could not inspect installed Appium drivers.'))
    console.error(pc.dim('Retry:'))
    console.error(`  ${pc.cyan(formatInstallMobileDriversRetryCommand(selection))}`)
    return
  }

  for (const event of result.events) {
    if (event.ok && event.action === 'reuse') {
      console.log(pc.green(`✓ ${event.label} driver already installed`))
    } else if (event.ok && event.action === 'install') {
      console.log(pc.green(`✓ ${event.label} driver installed`))
    } else if (event.ok && event.action === 'update') {
      console.log(pc.green(`✓ ${event.label} driver updated`))
    } else {
      const action = event.action === 'update' ? 'update' : 'installation'
      console.error(pc.red(`✗ ${event.label} driver ${action} failed`))
    }
  }

  if (!result.ok) {
    console.error(pc.dim('Retry:'))
    console.error(`  ${pc.cyan(formatInstallMobileDriversRetryCommand(selection))}`)
    return
  }

  console.log(pc.green('✓ agent-qa mobile driver support ready'))
}

export function createInstallMobileDriversCommand(deps: MobileDriverInstallDeps = {}): Command {
  const cmd = new Command('install-mobile-drivers')
    .description('Install Appium mobile drivers for agent-qa')
    .option('--all', 'install Android and iOS Appium drivers')
    .option('--android', 'install the UiAutomator2 Appium driver')
    .option('--ios', 'install the XCUITest Appium driver')
    .option('--update', 'update selected drivers when they are already installed')
    .option('--unsafe', 'allow Appium driver updates across major versions; requires --update')
    .action((opts) => {
      const selection: MobileDriverInstallSelection = {
        all: !!opts.all,
        android: !!opts.android,
        ios: !!opts.ios,
        update: !!opts.update,
        unsafe: !!opts.unsafe,
        cwd: resolveCommandCwd(cmd),
      }

      const validationError = validateMobileDriverInstallSelection(selection)
      if (validationError) {
        console.error(pc.red(`Error: ${validationError}`))
        console.error(cmd.helpInformation())
        process.exitCode = 1
        return
      }

      console.log(pc.blue('Installing agent-qa mobile driver support...'))
      const result = runMobileDriverInstall(selection, deps)
      printMobileDriverInstallResult(selection, result)
      if (!result.ok) {
        process.exitCode = result.status || 1
      }
    })

  return cmd
}
