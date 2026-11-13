import type { InitFileResult } from './init-filesystem.js'
import type { PlaygroundAppPin } from './playground-app-pin.js'

export type PlaygroundRuntime = 'android'

export interface PlaygroundAppRequest {
  url: string
  maxBytes: number
  signal: AbortSignal
}

export type PlaygroundAppFetch = (request: PlaygroundAppRequest) => Promise<Uint8Array>

export interface PlaygroundAppSource {
  fetch: PlaygroundAppFetch
  pin?: PlaygroundAppPin
}

export async function fetchReleaseAsset(
  _options: PlaygroundAppRequest & { fetchImpl: typeof fetch; timeoutMs: number },
): Promise<Uint8Array> {
  return new Uint8Array()
}

export interface PlaygroundAppsInput {
  dir: string
  runtimes: readonly PlaygroundRuntime[]
  pin: PlaygroundAppPin
  fetch: PlaygroundAppFetch
  exists: (path: string) => boolean
  force: boolean
  signal: AbortSignal
  record: (result: InitFileResult) => void
}

export interface PlaygroundAppsResult {
  arrived: PlaygroundRuntime[]
  failures: { runtime: PlaygroundRuntime; reason: string }[]
}

export async function downloadPlaygroundApps(
  _input: PlaygroundAppsInput,
): Promise<PlaygroundAppsResult> {
  return { arrived: [], failures: [] }
}
