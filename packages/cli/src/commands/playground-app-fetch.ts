import { fetchReleaseAsset, type PlaygroundAppFetch } from './playground-app.js'

// 55 MB over a slow line takes minutes, and nothing asks for the app again after a failure.
export const PLAYGROUND_APP_DEADLINE_MS = 600_000

export const fetchPlaygroundAppByDefault: PlaygroundAppFetch = (request) =>
  fetchReleaseAsset({
    ...request,
    fetchImpl: globalThis.fetch,
    timeoutMs: PLAYGROUND_APP_DEADLINE_MS,
  })
