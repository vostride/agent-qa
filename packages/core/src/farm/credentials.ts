import type { FarmProviderConfig } from './types.js'

const ENV_MAP: Record<string, { username: string; accessKey: string }> = {
  browserstack: {
    username: 'BROWSERSTACK_USERNAME',
    accessKey: 'BROWSERSTACK_ACCESS_KEY',
  },
}

const DISPLAY_NAMES: Record<string, string> = {
  browserstack: 'BrowserStack',
}

export function resolveFarmCredentials(
  provider: string,
  providerConfig?: FarmProviderConfig,
): { username: string; accessKey: string } {
  const envKeys = ENV_MAP[provider]
  if (!envKeys) {
    throw new Error(`Unknown farm provider: ${provider}`)
  }

  const envUsername = process.env[envKeys.username]
  const envAccessKey = process.env[envKeys.accessKey]

  if (envUsername && envAccessKey) {
    return { username: envUsername, accessKey: envAccessKey }
  }

  if (providerConfig?.username && providerConfig?.accessKey) {
    return { username: providerConfig.username, accessKey: providerConfig.accessKey }
  }

  const displayName = DISPLAY_NAMES[provider] ?? provider
  throw new Error(
    `${displayName} credentials not found. Set ${envKeys.username} and ${envKeys.accessKey} env vars, or add provider credentials to agent-qa.local.yaml.`,
  )
}
