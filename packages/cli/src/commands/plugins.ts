// list and describe read manifests and shipped schemas only; nothing here imports a plugin.

import { dirname, resolve } from 'node:path'

import {
  describePlugin,
  getAgentQaVersion,
  isPluginRemoteEntry,
  resolvePluginEntries,
  resolvePluginEntry,
  validatePluginPackage,
  type AgentQaConfig,
  type PluginDescription,
  type PluginEntryState,
  type PluginField,
  type PluginOrigin,
  type PluginPackageCheck,
  type PluginRemoteInput,
  type ResolvedPluginEntry,
} from '@vostride/agent-qa-core'
import {
  guardJsonText,
  printRunText,
  reserveStdoutForData,
} from '@vostride/agent-qa-core/run-text-output'
import type { PluginManifest } from '@vostride/agent-qa-plugin-kit/protocol'
import { runConformance } from '@vostride/agent-qa-plugin-kit/testing'
import { Command } from 'commander'
import pc from 'picocolors'

import { resolveConfig } from '../config.js'
import { createPluginsAddCommand, type PluginsAddDeps } from './plugins-add.js'

interface JsonOption {
  json?: boolean
}

interface PluginProject {
  config: AgentQaConfig
  configDir: string
  configPath: string
}

interface PluginListRow {
  name: string
  package?: string
  path?: string
  origin: PluginOrigin
  version?: string
  protocol?: number
  remotes: string[]
  state: PluginEntryState
  reason?: string
  install?: string
}

function configPathOf(command: Command): string {
  return resolve(command.optsWithGlobals<{ config?: string }>().config ?? 'agent-qa.config.yaml')
}

async function loadProject(command: Command): Promise<PluginProject> {
  const configPath = configPathOf(command)
  const config = await resolveConfig({ configPath, loadAuthPlugins: false })
  return { config, configDir: dirname(configPath), configPath }
}

function protocolOf(manifest: PluginManifest | undefined): number | undefined {
  return manifest?.kind === 'remote' ? manifest.protocol : undefined
}

function pluginRemotes(config: AgentQaConfig): PluginRemoteInput[] {
  return (config.registry?.remotes ?? [])
    .filter(isPluginRemoteEntry)
    .map((remote) => ({ name: remote.name, plugin: remote.plugin }))
}

function pluginListRows(project: PluginProject): PluginListRow[] {
  const plugins = project.config.plugins ?? []
  const remotes = pluginRemotes(project.config)
  const resolved = resolvePluginEntries(
    { plugins, remotes },
    {
      configDir: project.configDir,
      configPath: project.configPath,
      agentQaVersion: getAgentQaVersion(),
    },
  )
  return resolved.map((entry, index) =>
    listRow(
      entry,
      plugins[index],
      remotes.filter((remote) => remote.plugin === entry.name).map((remote) => remote.name),
    ),
  )
}

function listRow(
  resolved: ResolvedPluginEntry,
  declared: { package?: string; path?: string } | undefined,
  remotes: string[],
): PluginListRow {
  const protocol = protocolOf(resolved.manifest)
  return {
    name: resolved.name,
    ...(declared?.package === undefined ? {} : { package: declared.package }),
    ...(declared?.path === undefined ? {} : { path: declared.path }),
    origin: resolved.origin,
    ...(resolved.version ? { version: resolved.version } : {}),
    ...(protocol === undefined ? {} : { protocol }),
    remotes,
    state: resolved.state,
    ...(resolved.reason === undefined ? {} : { reason: resolved.reason }),
    ...(resolved.install === undefined ? {} : { install: resolved.install }),
  }
}

function listLines(rows: readonly PluginListRow[]): string[] {
  if (rows.length === 0) return ['plugins lists no entries.']
  return rows.flatMap((row) => {
    const line = [
      row.name,
      row.package ?? row.path ?? '-',
      row.origin,
      row.version ?? '-',
      `protocol ${row.protocol ?? '-'}`,
      `remotes: ${row.remotes.length === 0 ? 'none' : row.remotes.join(', ')}`,
      row.state === 'ok' ? pc.green(row.state) : pc.yellow(row.state),
    ].join('  ')
    return row.state === 'ok' || row.reason === undefined ? [line] : [line, `  ${row.reason}`]
  })
}

function fieldTable(title: string, fields: readonly PluginField[]): string[] {
  if (fields.length === 0) return [title, '  none']
  const rows = [
    ['field', 'type', 'required', 'default', 'credential', 'description'],
    ...fields.map((field) => [
      field.path,
      field.type,
      field.required ? 'required' : 'optional',
      'default' in field ? JSON.stringify(field.default) : '-',
      field.credential ? 'credential' : '-',
      field.description ?? '',
    ]),
  ]
  const widths = rows[0]!.map((_, column) => Math.max(...rows.map((row) => row[column]!.length)))
  return [
    title,
    ...rows.map((row) =>
      `  ${row.map((cell, column) => cell.padEnd(widths[column]!)).join('  ')}`.trimEnd(),
    ),
  ]
}

function describeLines(described: PluginDescription): string[] {
  const list = (values: readonly string[]) => (values.length === 0 ? 'none' : values.join(', '))
  return [
    [
      described.entry,
      described.package ?? described.path ?? '-',
      described.origin,
      described.version ?? '-',
      `protocol ${described.protocol ?? '-'}`,
    ].join('  '),
    `serves: ${list(described.serves)}`,
    `methods: ${list(described.methods)}`,
    `receives: ${
      described.runFacts.length === 0 ? 'session facts only' : described.runFacts.join(', ')
    }`,
    ...(described.skill === undefined ? [] : [`skill: ${described.skill}`]),
    '',
    ...fieldTable('Options', described.options),
    ...fieldTable('Settings', described.settings),
  ]
}

function describeEntry(project: PluginProject, name: string): PluginDescription {
  const plugins = project.config.plugins ?? []
  const entry = plugins.find((plugin) => plugin.name === name)
  if (entry === undefined) {
    const names = plugins.map((plugin) => plugin.name).join(', ')
    throw new Error(`No plugins entry named ${name}. plugins lists: ${names || 'no entries'}.`)
  }
  return describePlugin(
    resolvePluginEntry(entry, {
      configDir: project.configDir,
      configPath: project.configPath,
      agentQaVersion: getAgentQaVersion(),
    }),
  )
}

// `--json` keeps stdout for the document; every failure goes to stderr with exit 1.
async function printResult<T>(
  options: JsonOption,
  produce: () => Promise<T>,
  lines: (value: T) => string[],
  failed: (value: T) => boolean = () => false,
): Promise<void> {
  const releaseStdout = options.json === true ? reserveStdoutForData() : undefined
  try {
    const value = await produce()
    if (failed(value)) process.exitCode = 1
    if (options.json === true) {
      console.log(guardJsonText(JSON.stringify(value, null, 2)))
      return
    }
    printRunText(lines(value).join('\n'))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    printRunText(pc.red(message), (line) => console.error(line))
    process.exitCode = 1
  } finally {
    releaseStdout?.()
  }
}

function createListCommand(): Command {
  return new Command('list')
    .description("List the plugins entries with each one's state, read from manifests only")
    .option('--json', 'emit the entries as JSON')
    .action(async (options: JsonOption, command: Command) => {
      await printResult(
        options,
        async () => ({ plugins: pluginListRows(await loadProject(command)) }),
        ({ plugins }) => listLines(plugins),
      )
    })
}

function createDescribeCommand(): Command {
  return new Command('describe')
    .description("Show a plugin's options and settings from its shipped schemas")
    .argument('<name>', 'the plugins entry to describe')
    .option('--json', 'emit the description as JSON')
    .action(async (name: string, options: JsonOption, command: Command) => {
      await printResult(
        options,
        async () => describeEntry(await loadProject(command), name),
        describeLines,
      )
    })
}

export function createPluginsCommand(deps: PluginsAddDeps = {}): Command {
  return new Command('plugins')
    .description('Add, list and describe the plugins entries')
    .addCommand(createPluginsAddCommand(deps))
    .addCommand(createListCommand())
    .addCommand(createDescribeCommand())
}

interface PluginValidation {
  ok: boolean
  checks: PluginPackageCheck[]
}

// The static checks read files only; the quick conformance pass is the one step that runs the
// plugin, and it sends no vendor options and never acquires.
async function validatePlugin(command: Command, target: string): Promise<PluginValidation> {
  const configPath = configPathOf(command)
  const report = validatePluginPackage(target, {
    configDir: dirname(configPath),
    configPath,
    agentQaVersion: getAgentQaVersion(),
  })
  const checks = [...report.checks]
  const passed = (name: string) => checks.some((check) => check.name === name && check.ok)
  if (report.packageDir !== undefined && report.remote && passed('manifest') && passed('schemas')) {
    const conformance = await runConformance({
      packageDir: report.packageDir,
      options: {},
      quick: true,
    })
    checks.push(...conformance.checks.filter((check) => check.name !== 'manifest' || !check.ok))
  }
  return { ok: checks.every((check) => check.ok), checks }
}

function checkLines(validation: PluginValidation): string[] {
  return validation.checks.map((check) => {
    const status = !check.ok ? pc.red('fail') : check.warning === true ? pc.yellow('warn') : 'ok  '
    return `${status}  ${check.name}${check.detail === undefined ? '' : `  ${check.detail}`}`
  })
}

function createValidatePluginCommand(): Command {
  return new Command('validate')
    .description('Check a plugin package, its skill and a quick conformance pass')
    .argument('<target>', 'a plugin folder (./path) or an installed package name')
    .option('--json', 'emit the checks as JSON')
    .action(async (target: string, options: JsonOption, command: Command) => {
      await printResult(
        options,
        () => validatePlugin(command, target),
        checkLines,
        (validation) => !validation.ok,
      )
    })
}

export function createPluginCommand(): Command {
  return new Command('plugin')
    .description('Check a plugin package as its author')
    .addCommand(createValidatePluginCommand())
}
