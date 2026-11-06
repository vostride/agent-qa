import { secretReferenceNames } from '@vostride/agent-qa-schema'

import { checkPluginConfig } from './options-check.js'
import {
  resolvePluginEntry,
  type PluginEntryInput,
  type ResolvedPluginEntry,
  type ResolvePluginEntryOptions,
} from './resolve-entries.js'

export interface PluginRemoteUse {
  remote: string
  place: 'web' | 'device'
}

export interface PluginRemoteRefusal {
  remote: string
  entry: string
  kind: 'version' | 'refused' | 'auth'
  message: string
  // Set when the refusal concerns only the remote's web tests or only its devices.
  place?: PluginRemoteUse['place']
}

export interface PluginRemoteRefusalsInput extends ResolvePluginEntryOptions {
  plugins: readonly PluginEntryInput[]
  remotes: readonly { name: string; plugin?: string; settings?: unknown }[]
  uses: readonly PluginRemoteUse[]
  // Absent, references are not checked against the secrets file.
  declaredSecrets?: { has(name: string): boolean }
}

const WEB_PROTOCOLS = ['playwright', 'cdp'] as const

function listed(items: readonly string[]): string {
  if (items.length <= 1) return items.join('')
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`
}

function referenceNames(value: unknown): string[] {
  if (typeof value === 'string') return secretReferenceNames(value)
  if (Array.isArray(value)) return value.flatMap(referenceNames)
  if (typeof value === 'object' && value !== null) {
    return Object.values(value).flatMap(referenceNames)
  }
  return []
}

function servesSentences(
  resolved: ResolvedPluginEntry,
  places: ReadonlySet<PluginRemoteUse['place']>,
): { place: PluginRemoteUse['place']; sentence: string }[] {
  const manifest = resolved.manifest
  if (manifest?.kind !== 'remote') return []
  const serves: readonly string[] = manifest.serves
  const sentences: { place: PluginRemoteUse['place']; sentence: string }[] = []
  const what = `plugin entry ${resolved.name} serves ${listed(serves)}`
  if (places.has('web') && !WEB_PROTOCOLS.some((protocol) => serves.includes(protocol))) {
    sentences.push({ place: 'web', sentence: `${what}, and a web test needs playwright or cdp.` })
  }
  if (places.has('device') && !serves.includes('appium')) {
    sentences.push({ place: 'device', sentence: `${what}, and a device needs appium.` })
  }
  return sentences
}

// What a run and validate can tell about a plugin remote without running its plugin.
export function pluginRemoteRefusals(input: PluginRemoteRefusalsInput): PluginRemoteRefusal[] {
  const options = {
    configDir: input.configDir,
    agentQaVersion: input.agentQaVersion,
    ...(input.protocols === undefined ? {} : { protocols: input.protocols }),
  }
  const places = new Map<string, Set<PluginRemoteUse['place']>>()
  for (const use of input.uses) {
    const seen = places.get(use.remote) ?? new Set()
    seen.add(use.place)
    places.set(use.remote, seen)
  }

  const resolvedEntries = new Map<string, ResolvedPluginEntry>()
  const refusals: PluginRemoteRefusal[] = []
  for (const [remoteName, used] of places) {
    const remote = input.remotes.find((candidate) => candidate.name === remoteName)
    if (remote?.plugin === undefined) continue
    const entry = input.plugins.find((candidate) => candidate.name === remote.plugin)
    if (entry === undefined) continue

    let resolved = resolvedEntries.get(entry.name)
    if (resolved === undefined) {
      resolved = resolvePluginEntry(entry, options)
      resolvedEntries.set(entry.name, resolved)
    }
    const refuse = (
      kind: PluginRemoteRefusal['kind'],
      sentence: string,
      place?: PluginRemoteUse['place'],
    ): void => {
      refusals.push({
        remote: remoteName,
        entry: entry.name,
        kind,
        message: `Remote ${remoteName} cannot start: ${sentence}`,
        ...(place === undefined ? {} : { place }),
      })
    }

    if (resolved.state !== 'ok') {
      const version =
        resolved.state === 'version_mismatch' || resolved.state === 'protocol_mismatch'
      refuse(version ? 'version' : 'refused', resolved.reason ?? '')
      continue
    }
    if (resolved.manifest?.kind !== 'remote') {
      refuse(
        'refused',
        `plugin entry ${entry.name} is a ${resolved.manifest?.kind ?? 'unknown'} plugin, and a `
          + 'remote needs a remote plugin.',
      )
      continue
    }

    for (const { place, sentence } of servesSentences(resolved, used)) {
      refuse('refused', sentence, place)
    }

    const issues = checkPluginConfig(resolved, {
      options: entry.options,
      remotes: [{ name: remoteName, settings: remote.settings }],
    })
    const ownPrefix = `Remote ${remoteName}: `
    for (const issue of issues) {
      const sentence = issue.message.startsWith(ownPrefix)
        ? issue.message.slice(ownPrefix.length)
        : issue.message
      refuse('refused', sentence)
    }

    if (input.declaredSecrets !== undefined) {
      const names = new Set([
        ...referenceNames(entry.options),
        ...referenceNames(remote.settings),
      ])
      for (const name of names) {
        if (input.declaredSecrets.has(name)) continue
        refuse(
          'auth',
          `plugin entry ${entry.name} uses secret ${name}, which workspace.secretsFile does `
            + 'not declare.',
        )
      }
    }
  }
  return refusals
}
