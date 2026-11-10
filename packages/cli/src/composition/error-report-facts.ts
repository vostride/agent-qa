// Where and how agent-qa is running, for every report: names and closed values only, never a
// flag's value, a positional argument, a path or a package name outside the first-party plugins.

import { resolveRunExecutionContext } from '@vostride/agent-qa-agent-local'
import { analyticsRemotePluginId } from '@vostride/agent-qa-analytics'
import type { Command } from 'commander'

import { userAgentManagerName } from '../commands/package-manager.js'
import type { ReportFacts } from './error-reporting.js'

export type { ReportFacts }

const PLATFORMS: ReadonlySet<unknown> = new Set(['web', 'android', 'ios'])

export interface ReportFactsInput {
  readonly action: Command
  // The raw config document the decision read, of any shape, or undefined when there was none.
  readonly document: unknown
  readonly env: NodeJS.ProcessEnv
}

export function collectReportFacts(input: ReportFactsInput): ReportFacts {
  const registry = recordOf(recordOf(input.document)?.registry)
  return {
    command: commandPath(input.action),
    flags: typedFlags(input.action),
    packageManager: userAgentManagerName(input.env) ?? 'unknown',
    ci: resolveRunExecutionContext() === 'ci',
    platforms: platformsOf(registry),
    models: modelsOf(registry),
    plugins: pluginsOf(input.document),
  }
}

// From the top-level command down to the action; the program's own name is left out.
export function commandPath(action: Command): string {
  const names: string[] = []
  let command = action
  while (command.parent !== null) {
    names.unshift(command.name())
    command = command.parent
  }
  return names.join(' ')
}

function typedFlags(action: Command): string[] {
  const flags = new Set<string>()
  let command: Command | null = action
  while (command !== null) {
    for (const flag of flagsTypedOn(command)) flags.add(flag)
    command = command.parent
  }
  return [...flags].sort()
}

function flagsTypedOn(command: Command): string[] {
  return command.options.flatMap((option) => {
    const key = option.attributeName()
    if (command.getOptionValueSource(key) !== 'cli') return []
    // --headless and --no-headless share one value, and the value says which one was typed.
    const paired = command.options.some(
      (other) => other !== option && other.attributeName() === key,
    )
    if (paired && option.negate !== (command.getOptionValue(key) === false)) return []
    const name = option.long ?? option.short
    return name === undefined ? [] : [name]
  })
}

function platformsOf(registry: Record<string, unknown> | undefined): string[] {
  const targets = Object.values(recordOf(registry?.targets) ?? {})
  return distinctSorted(
    targets.flatMap((target) => {
      const platform = recordOf(target)?.platform
      return typeof platform === 'string' && PLATFORMS.has(platform) ? [platform] : []
    }),
  )
}

function modelsOf(registry: Record<string, unknown> | undefined): string[] {
  return distinctSorted(
    listOf(registry?.llms).flatMap((entry) => {
      const llm = recordOf(entry)
      return typeof llm?.provider === 'string' && typeof llm.model === 'string'
        ? [`${llm.provider}/${llm.model}`]
        : []
    }),
  )
}

function pluginsOf(document: unknown): string[] {
  return distinctSorted(
    listOf(recordOf(document)?.plugins).flatMap((entry) => {
      const plugin = recordOf(entry)
      if (typeof plugin?.package === 'string') {
        return [analyticsRemotePluginId({ package: plugin.package })]
      }
      return typeof plugin?.path === 'string'
        ? [analyticsRemotePluginId({ path: plugin.path })]
        : []
    }),
  )
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function listOf(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : []
}

function distinctSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort()
}
