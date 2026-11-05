// Reads plugins from their manifests and shipped schemas; nothing here imports a plugin.

import { dirname, resolve } from 'node:path'

import {
  getAgentQaVersion,
  isPluginRemoteEntry,
  resolvePluginEntries,
  type AgentQaConfig,
  type PluginEntryState,
  type PluginOrigin,
  type PluginRemoteInput,
  type ResolvedPluginEntry,
} from '@vostride/agent-qa-core'
import {
  guardJsonText,
  printRunText,
  reserveStdoutForData,
} from '@vostride/agent-qa-core/run-text-output'
import type { PluginManifest } from '@vostride/agent-qa-plugin-kit/protocol'
import { Command } from 'commander'
import pc from 'picocolors'

import { resolveConfig } from '../config.js'

interface JsonOption {
  json?: boolean
}

interface PluginProject {
  config: AgentQaConfig
  configDir: string
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
  return { config, configDir: dirname(configPath) }
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
    { configDir: project.configDir, agentQaVersion: getAgentQaVersion() },
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

function printError(label: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error)
  printRunText(pc.red(`${label}: ${message}`), (line) => console.error(line))
  process.exitCode = 1
}

function printJson(value: unknown): void {
  console.log(guardJsonText(JSON.stringify(value, null, 2)))
}

function createListCommand(): Command {
  return new Command('list')
    .description("List the plugins entries with each one's state, read from manifests only")
    .option('--json', 'emit the entries as JSON')
    .action(async (options: JsonOption, command: Command) => {
      const releaseStdout = options.json === true ? reserveStdoutForData() : undefined
      try {
        const rows = pluginListRows(await loadProject(command))
        if (options.json === true) {
          printJson({ plugins: rows })
          return
        }
        printRunText(listLines(rows).join('\n'))
      } catch (error) {
        printError('Plugins error', error)
      } finally {
        releaseStdout?.()
      }
    })
}

export function createPluginsCommand(): Command {
  return new Command('plugins')
    .description('Read the plugins entries without running plugin code')
    .addCommand(createListCommand())
}
