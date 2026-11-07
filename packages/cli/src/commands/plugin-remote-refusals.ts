import {
  getAgentQaVersion,
  pluginRemoteRefusals,
  remoteDeviceRefusalKey,
} from '@vostride/agent-qa-core'
import type { AgentQaConfig, DevicePlace } from '@vostride/agent-qa-core'
import { isPluginRemote, RemoteRefusalError } from '@vostride/agent-qa-runner'
import type {
  RemoteBrowserConfig,
  RemotePluginBrowserConfig,
  RemoteRefusalMemory,
} from '@vostride/agent-qa-runner'

// No remote name or device key holds a space, so a device never reads this key.
function webOnlyRefusalKey(remote: string): string {
  return `${remote} web`
}

// What a web adapter reads the run's memory through, so it also meets refusals of web tests only.
export function webRefusalMemory(memory: RemoteRefusalMemory): RemoteRefusalMemory {
  return {
    refusalFor: (name) => memory.refusalFor(webOnlyRefusalKey(name)) ?? memory.refusalFor(name),
    remember: (name, error) => memory.remember(name, error),
  }
}

// Before any member starts, a plugin remote its plugin cannot serve is refused in the run's memory,
// so only that remote's members fail, each with its one sentence. A refusal of one place, web or
// device, is remembered where only that place looks.
export function rememberPluginRemoteRefusals(input: {
  readonly config: AgentQaConfig
  readonly configDir: string
  readonly configPath?: string
  readonly usedRemotes: Iterable<RemoteBrowserConfig | RemotePluginBrowserConfig>
  readonly usedDevices: Iterable<DevicePlace>
  readonly declaredSecrets: { has(name: string): boolean } | undefined
  readonly refusalMemory: RemoteRefusalMemory
}): void {
  const webRemotes = [...input.usedRemotes].flatMap((remote) =>
    isPluginRemote(remote) ? [remote.name] : [],
  )
  const devicesOn = new Map<string, Set<string>>()
  for (const place of input.usedDevices) {
    if (place.kind !== 'remote' || !isPluginRemote(place.remote)) continue
    const devices = devicesOn.get(place.remote.name) ?? new Set<string>()
    devices.add(place.device)
    devicesOn.set(place.remote.name, devices)
  }
  const uses = [
    ...webRemotes.map((remote) => ({ remote, place: 'web' as const })),
    ...[...devicesOn.keys()].map((remote) => ({ remote, place: 'device' as const })),
  ]
  if (uses.length === 0) return
  const refusals = pluginRemoteRefusals({
    configDir: input.configDir,
    ...(input.configPath === undefined ? {} : { configPath: input.configPath }),
    agentQaVersion: getAgentQaVersion(),
    plugins: input.config.plugins ?? [],
    remotes: input.config.registry?.remotes ?? [],
    uses,
    ...(input.declaredSecrets === undefined ? {} : { declaredSecrets: input.declaredSecrets }),
  })
  const memory = input.refusalMemory
  for (const { remote, kind, message, place } of refusals) {
    const refusal = new RemoteRefusalError(message, { remote, kind })
    if (place === 'web') {
      memory.remember(webOnlyRefusalKey(remote), refusal)
    } else if (place === 'device') {
      for (const device of devicesOn.get(remote) ?? []) {
        memory.remember(remoteDeviceRefusalKey({ name: remote }, device, kind), refusal)
      }
    } else {
      memory.remember(remote, refusal)
    }
  }
}
