import {
  DEFAULT_REMOTE_CONNECT_TIMEOUT_MS,
  type RemoteBrowserConfig,
} from '@vostride/agent-qa-runner'
import type { RemoteEntry } from '../schema/remote-schema.js'

export type WebPlace = { kind: 'local' } | { kind: 'remote'; remote: RemoteBrowserConfig }

export interface SelectWebPlaceInput {
  remotes: readonly RemoteEntry[]
  suite?: string
  test?: string
  config?: string
  // The file the pick came from, named in the refusal.
  file?: string
}

export type SelectWebPlaceResult = { place: WebPlace } | { refusal: string }

const LOCAL_PICK = 'local'

export function toRemoteBrowserConfig(entry: RemoteEntry): RemoteBrowserConfig {
  return {
    name: entry.name,
    protocol: entry.protocol,
    url: entry.url,
    ...(entry.query ? { query: entry.query } : {}),
    ...(entry.headers ? { headers: entry.headers } : {}),
    ...(entry.basicAuth ? { basicAuth: entry.basicAuth } : {}),
    connectTimeoutMs: entry.connectTimeout ?? DEFAULT_REMOTE_CONNECT_TIMEOUT_MS,
    ...(entry.context ? { context: entry.context } : {}),
  }
}

// The suite's pick wins, then the test's, then the config's; no pick runs here.
export function selectWebPlace(input: SelectWebPlaceInput): SelectWebPlaceResult {
  const pick = input.suite ?? input.test ?? input.config
  if (pick === undefined || pick === LOCAL_PICK) return { place: { kind: 'local' } }
  const entry = input.remotes.find((remote) => remote.name === pick)
  if (entry) return { place: { kind: 'remote', remote: toRemoteBrowserConfig(entry) } }
  const from = input.file ?? pickedBy(input)
  const listed =
    input.remotes.length === 0
      ? 'registry.remotes lists no remotes.'
      : `registry.remotes lists: ${input.remotes.map((remote) => remote.name).join(', ')}.`
  return { refusal: `Unknown remote "${pick}" in ${from}. ${listed}` }
}

function pickedBy(input: SelectWebPlaceInput): string {
  if (input.suite !== undefined) return 'the suite'
  if (input.test !== undefined) return 'the test'
  return 'the config'
}
