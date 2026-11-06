import { dirname, resolve as resolvePath } from 'node:path'
import type { ProviderDescriptor } from '@vostride/agent-qa-model'

import { pluginRemotesOfRawConfig } from './plugin-remotes.js'

export async function loadProviderPluginsForRawConfig(
  raw: unknown,
  configPath = 'agent-qa.config.yaml',
): Promise<void> {
  const entries = (raw as { plugins?: unknown } | null)?.plugins
  if (!Array.isArray(entries) || entries.length === 0) return

  const { loadProviderPlugins } = await import('@vostride/agent-qa-core')
  const { registerProvider } = await import('@vostride/agent-qa-model')
  const descriptors = await loadProviderPlugins(entries as Parameters<typeof loadProviderPlugins>[0], {
    baseDir: dirname(resolvePath(configPath)),
    remotes: pluginRemotesOfRawConfig(raw),
  })

  for (const descriptor of descriptors) {
    registerProvider(descriptor as unknown as ProviderDescriptor)
  }
}
