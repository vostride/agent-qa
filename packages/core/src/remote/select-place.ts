import {
  DEFAULT_REMOTE_CONNECT_TIMEOUT_MS,
  type RemoteBrowserConfig,
} from '@vostride/agent-qa-runner'
import type { RunAttributeRunner } from '../run-attributes.js'
import type { RemoteEntry } from '../schema/remote-schema.js'

export type WebPlace = { kind: 'local' } | { kind: 'remote'; remote: RemoteBrowserConfig }

export type BrowserEngine = 'chromium' | 'firefox' | 'webkit'

export interface SelectWebPlaceInput {
  remotes: readonly RemoteEntry[]
  suite?: string
  test?: string
  config?: string
  // The file the pick came from, named in the refusal.
  file?: string
  // The engine the test runs in, after `--browser`.
  engine?: BrowserEngine
}

export interface SuiteMemberPick {
  // The member file, relative to the config directory with forward slashes.
  file: string
  pick?: string
}

export interface SelectSuitePlaceInput {
  remotes: readonly RemoteEntry[]
  suiteName: string
  suiteFile: string
  suite?: string
  config?: string
  members: readonly SuiteMemberPick[]
  engine?: BrowserEngine
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
  if (!entry) {
    const from = input.file ?? pickedBy(input)
    const listed =
      input.remotes.length === 0
        ? 'registry.remotes lists no remotes.'
        : `registry.remotes lists: ${input.remotes.map((remote) => remote.name).join(', ')}.`
    return { refusal: `Unknown remote "${pick}" in ${from}. ${listed}` }
  }
  if (entry.protocol === 'cdp' && input.engine !== undefined && input.engine !== 'chromium') {
    return {
      refusal: `Remote ${entry.name} serves Chromium only; this test asks for ${input.engine}.`,
    }
  }
  return { place: { kind: 'remote', remote: toRemoteBrowserConfig(entry) } }
}

// A suite shares one browser, so all its members run in one place.
export function selectSuitePlace(input: SelectSuitePlaceInput): SelectWebPlaceResult {
  const { remotes, config, engine } = input
  if (input.suite !== undefined) {
    return selectWebPlace({ remotes, suite: input.suite, file: input.suiteFile, engine })
  }
  for (const member of input.members) {
    const selected = selectWebPlace({
      remotes,
      test: member.pick,
      config,
      ...(member.pick === undefined ? {} : { file: member.file }),
    })
    if ('refusal' in selected) return selected
  }
  const picks = input.members.map((member) => ({
    file: member.file,
    pick: member.pick ?? config ?? LOCAL_PICK,
  }))
  const agreed = picks[0]?.pick ?? config
  if (picks.some(({ pick }) => pick !== agreed)) {
    const named = picks.map(({ file, pick }) => `${file} picks ${pick}`)
    const listed = `${named.slice(0, -1).join(', ')} and ${named[named.length - 1]}`
    return {
      refusal:
        `Suite ${input.suiteName} runs its tests in one place, but ${listed}. ` +
        'Set use.browser.remote in the suite or make the tests agree.',
    }
  }
  return selectWebPlace({ remotes, test: agreed, engine })
}

// A run is remote when any of its tests runs on a remote.
export function runnerForPlaces(places: readonly WebPlace[]): RunAttributeRunner {
  return places.some((place) => place.kind === 'remote') ? 'remote' : 'local'
}

function pickedBy(input: SelectWebPlaceInput): string {
  if (input.suite !== undefined) return 'the suite'
  if (input.test !== undefined) return 'the test'
  return 'the config'
}
