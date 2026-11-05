import { isLoopbackHost } from '@vostride/agent-qa-schema'

export type AppiumEndpointChoice =
  | { kind: 'remote' }
  | { kind: 'given'; url: string }
  | { kind: 'host-or-start' }
  | { refusal: string }

export interface ChooseAppiumEndpointInput {
  device: { name: string; remote?: unknown }
  // The value of AGENT_QA_APPIUM_URL.
  envUrl?: string
}

const DEFAULT_PORTS: Record<string, string> = { 'http:': '80', 'https:': '443' }

// A device with a remote uses it; a device here uses AGENT_QA_APPIUM_URL, else the host's Appium,
// else the one agent-qa starts.
export function chooseAppiumEndpoint(input: ChooseAppiumEndpointInput): AppiumEndpointChoice {
  if (input.device.remote !== undefined) return { kind: 'remote' }
  const raw = input.envUrl?.trim()
  if (raw === undefined || raw === '') return { kind: 'host-or-start' }
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return {
      refusal:
        'AGENT_QA_APPIUM_URL is not a URL; set it to your Appium on this machine, ' +
        'for example http://127.0.0.1:4723.',
    }
  }
  const defaultPort = DEFAULT_PORTS[url.protocol]
  if (defaultPort === undefined) {
    return { refusal: 'AGENT_QA_APPIUM_URL must start with http:// or https://.' }
  }
  if (url.username !== '' || url.password !== '' || url.search !== '' || raw.includes('?')) {
    return {
      refusal:
        'AGENT_QA_APPIUM_URL must not carry a user, password or query; ' +
        'it names your own Appium on this machine.',
    }
  }
  if (!isLoopbackHost(url.hostname)) {
    return {
      refusal:
        `AGENT_QA_APPIUM_URL names ${url.hostname}, which is not this machine. ` +
        "List that server under registry.remotes with protocol: appium and set the device's remote to its name.",
    }
  }
  const port = url.port === '' ? defaultPort : url.port
  return { kind: 'given', url: `${url.protocol}//${url.hostname}:${port}${url.pathname}` }
}
