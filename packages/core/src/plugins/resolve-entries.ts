import { existsSync, realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'

import {
  PLUGIN_PROTOCOL_VERSION,
  type PluginManifest,
} from '@vostride/agent-qa-plugin-kit/protocol'

import {
  declarationLabel,
  findPackageJson,
  isNpmPackageName,
  packageDeclarationValue,
  pathDeclarationValue,
} from '../plugin-loader-util.js'
import { isPathInsideDir } from '../utils/path-validation.js'
import { SUBSCRIPTION_AUTH_PACKAGE, readPluginManifest } from './manifest.js'

export type PluginOrigin = 'first-party' | 'third-party' | 'path'

export type PluginEntryState =
  | 'ok'
  | 'not_installed'
  | 'version_mismatch'
  | 'protocol_mismatch'
  | 'bad_manifest'
  | 'unused'

export interface PluginEntryInput {
  name: string
  package?: string
  path?: string
  options?: unknown
}

export interface PluginRemoteInput {
  name: string
  plugin?: string
}

export interface ResolvePluginEntryOptions {
  configDir: string
  agentQaVersion: string
  protocols?: { current: number }
}

export interface ResolvedPluginEntry {
  name: string
  label: string
  origin: PluginOrigin
  state: PluginEntryState
  reason?: string
  install?: string
  packageDir?: string
  packageJsonPath?: string
  version?: string
  manifest?: PluginManifest
  inProcess: boolean
}

export type InProcessPluginKind = 'model-auth' | 'model-provider'

export interface InProcessRefusal {
  entry: string
  state: 'not_installed' | 'bad_manifest'
  reason: string
}

export interface InProcessSelection {
  load: ResolvedPluginEntry[]
  refusals: InProcessRefusal[]
}

const FIRST_PARTY_PREFIX = '@vostride/agent-qa-'
const FIRST_PARTY_PLUGIN_PREFIX = '@vostride/agent-qa-plugin-'

export function supportedPluginProtocols(current: number = PLUGIN_PROTOCOL_VERSION): number[] {
  return [current, current - 1].filter((protocol) => protocol >= 1)
}

export function pluginInstallLine(
  entry: PluginEntryInput,
  agentQaVersion: string,
): string | undefined {
  const packageName = packageDeclarationValue(entry)
  if (!packageName) return undefined
  if (packageName.startsWith(FIRST_PARTY_PLUGIN_PREFIX)) {
    return `npm install --save-dev --save-exact ${packageName}@${agentQaVersion}`
  }
  return `npm install --save-dev ${packageName}`
}

function pluginOrigin(entry: PluginEntryInput): PluginOrigin {
  const packageName = packageDeclarationValue(entry)
  if (!packageName) return 'path'
  return packageName.startsWith(FIRST_PARTY_PREFIX) && isNpmPackageName(packageName)
    ? 'first-party'
    : 'third-party'
}

function packageJsonInsideProject(declaredPath: string, configDir: string): string | undefined {
  const target = resolve(configDir, declaredPath)
  const packageJsonPath = join(target, 'package.json')
  if (!existsSync(packageJsonPath)) return undefined
  const realTarget = realpathSync(target)
  if (!isPathInsideDir(realTarget, realpathSync(configDir))) return undefined
  return join(realTarget, 'package.json')
}

export function resolvePluginEntry(
  entry: PluginEntryInput,
  options: ResolvePluginEntryOptions,
): ResolvedPluginEntry {
  const { configDir, agentQaVersion } = options
  const origin = pluginOrigin(entry)
  const label = declarationLabel(entry, configDir)
  const install = pluginInstallLine(entry, agentQaVersion)
  const base = { name: entry.name, label, origin, inProcess: false }

  let packageJsonPath: string | undefined
  if (origin === 'path') {
    packageJsonPath = packageJsonInsideProject(pathDeclarationValue(entry), configDir)
    if (!packageJsonPath) {
      return {
        ...base,
        state: 'not_installed',
        reason:
          `Plugin entry ${entry.name} names the path ${label}, which has no package.json inside `
          + 'this project. Fix the path in plugins, or make the plugin a workspace package and '
          + 'name it with package.',
      }
    }
  } else {
    packageJsonPath = findPackageJson(packageDeclarationValue(entry), configDir) ?? undefined
    if (!packageJsonPath) {
      return {
        ...base,
        state: 'not_installed',
        reason:
          `Plugin entry ${entry.name} names ${label}, which is not installed. Run ${install}.`,
        install,
      }
    }
  }

  const read = readPluginManifest(packageJsonPath)
  const found = {
    ...base,
    packageDir: read.packageDir,
    packageJsonPath,
    ...(read.version === undefined ? {} : { version: read.version }),
  }

  // An npm alias installs another package under the declared name; its origin is not the name's.
  if (origin !== 'path' && read.name !== undefined && read.name !== label) {
    return {
      ...found,
      state: 'bad_manifest',
      reason:
        `Plugin entry ${entry.name} names ${label}, but the package installed under that name is `
        + `${read.name === '' ? 'unnamed' : read.name}. Install ${label} itself, not an alias.`,
    }
  }

  if (
    label.startsWith(FIRST_PARTY_PLUGIN_PREFIX)
    && read.version !== undefined
    && read.version !== agentQaVersion
  ) {
    return {
      ...found,
      state: 'version_mismatch',
      reason:
        `Plugin entry ${entry.name} names ${label} at ${read.version}, and agent-qa is at `
        + `${agentQaVersion}. Run ${install}.`,
      install,
    }
  }

  if (!read.ok) {
    return {
      ...found,
      state: 'bad_manifest',
      reason:
        `Plugin entry ${entry.name} names ${label}, whose package.json has no valid agent-qa `
        + `plugin manifest (${read.issue}). Fix the plugin's manifest.`,
    }
  }

  const manifest = read.manifest
  const resolved = { ...found, manifest, inProcess: manifest.runs === 'in-process' }

  if (manifest.runs === 'in-process' && origin !== 'first-party') {
    return {
      ...resolved,
      state: 'bad_manifest',
      reason:
        `Plugin entry ${entry.name} names ${label}, which declares a ${manifest.kind} plugin; `
        + `only ${FIRST_PARTY_PREFIX}* packages load inside agent-qa. Remove the entry.`,
    }
  }

  if (manifest.kind === 'remote' && origin !== 'first-party') {
    const current = options.protocols?.current ?? PLUGIN_PROTOCOL_VERSION
    const window = supportedPluginProtocols(current)
    const speaks =
      `Plugin entry ${entry.name} names ${label}, which speaks plugin protocol ${manifest.protocol}`
    if (manifest.protocol > current) {
      return {
        ...resolved,
        state: 'protocol_mismatch',
        reason: `${speaks}, newer than this agent-qa's ${current}. Update agent-qa.`,
      }
    }
    if (!window.includes(manifest.protocol)) {
      return {
        ...resolved,
        state: 'protocol_mismatch',
        reason:
          `${speaks}; this agent-qa speaks ${window.join(' and ')}. Rebuild the plugin with `
          + `@vostride/agent-qa-plugin-kit@${agentQaVersion}.`,
      }
    }
  }

  return { ...resolved, state: 'ok' }
}

export function resolvePluginEntries(
  config: { plugins: readonly PluginEntryInput[]; remotes?: readonly PluginRemoteInput[] },
  options: ResolvePluginEntryOptions,
): ResolvedPluginEntry[] {
  const named = new Set((config.remotes ?? []).map((remote) => remote.plugin))
  return config.plugins.map((entry) => {
    const resolved = resolvePluginEntry(entry, options)
    if (resolved.state !== 'ok' || resolved.manifest?.kind !== 'remote') return resolved
    if (named.has(entry.name)) return resolved
    return {
      ...resolved,
      state: 'unused',
      reason:
        `Plugin entry ${entry.name} is used by no remote. Name it from a remote in `
        + 'registry.remotes, or remove it.',
    }
  })
}

export function selectInProcessPluginEntries(
  entries: readonly PluginEntryInput[],
  kind: InProcessPluginKind,
  options: ResolvePluginEntryOptions,
): InProcessSelection {
  const selection: InProcessSelection = { load: [], refusals: [] }
  for (const entry of entries) {
    const resolved = resolvePluginEntry(entry, options)
    const ofKind = resolved.manifest?.kind === kind
    if (resolved.state === 'ok' && ofKind) {
      selection.load.push(resolved)
    } else if (resolved.state === 'bad_manifest' && ofKind) {
      selection.refusals.push(refusal(resolved, 'bad_manifest'))
    } else if (
      kind === 'model-auth'
      && resolved.state === 'not_installed'
      && packageDeclarationValue(entry) === SUBSCRIPTION_AUTH_PACKAGE
    ) {
      selection.refusals.push(refusal(resolved, 'not_installed'))
    }
  }
  return selection
}

function refusal(
  resolved: ResolvedPluginEntry,
  state: InProcessRefusal['state'],
): InProcessRefusal {
  return { entry: resolved.name, state, reason: resolved.reason ?? '' }
}
