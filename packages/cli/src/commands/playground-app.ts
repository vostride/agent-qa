import { createHash } from 'node:crypto'
import { join } from 'node:path'

import { writeScaffoldFileAtomic, type InitFileResult } from './init-filesystem.js'
import {
  PLAYGROUND_APP_PATHS,
  playgroundAppUrl,
  type PlaygroundAppPin,
} from './playground-app-pin.js'

export type PlaygroundRuntime = 'android' | 'ios'

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

function tooLarge(maxBytes: number): Error {
  return new Error(`the file is larger than its pinned ${maxBytes} bytes`)
}

export async function fetchReleaseAsset(
  options: PlaygroundAppRequest & { fetchImpl: typeof fetch; timeoutMs: number },
): Promise<Uint8Array> {
  const { url, maxBytes, signal, fetchImpl, timeoutMs } = options
  const response = await fetchImpl(url, {
    redirect: 'follow',
    signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
  })
  if (response.status !== 200) {
    await response.body?.cancel().catch(() => undefined)
    throw new Error(`GitHub answered ${response.status}`)
  }
  const length = response.headers.get('content-length')
  if (length !== null && Number(length) > maxBytes) {
    await response.body?.cancel().catch(() => undefined)
    throw tooLarge(maxBytes)
  }
  if (response.body === null) return new Uint8Array()

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let received = 0
  for (;;) {
    const read = await reader.read()
    if (read.done) break
    received += read.value.byteLength
    if (received > maxBytes) {
      await reader.cancel().catch(() => undefined)
      throw tooLarge(maxBytes)
    }
    chunks.push(read.value)
  }
  const bytes = new Uint8Array(received)
  let at = 0
  for (const chunk of chunks) {
    bytes.set(chunk, at)
    at += chunk.byteLength
  }
  return bytes
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

const RUNTIME_NAMES: Record<PlaygroundRuntime, string> = { android: 'Android', ios: 'iOS' }

function failureReason(pin: PlaygroundAppPin, runtime: PlaygroundRuntime, error: unknown): string {
  const message = (error instanceof Error ? error.message : String(error)).replace(/\.$/u, '')
  return (
    `The Playground app for ${RUNTIME_NAMES[runtime]} was not downloaded: ${message}. ` +
    `It is ${pin[runtime].file} in release ${pin.tag} of github.com/${pin.repository}.`
  )
}

// Nothing reads or writes the bytes before their sha256 matched the pin.
async function fetchPinned(
  input: PlaygroundAppsInput,
  runtime: PlaygroundRuntime,
): Promise<Uint8Array> {
  const pinned = input.pin[runtime]
  const bytes = await input.fetch({
    url: playgroundAppUrl(input.pin, runtime),
    maxBytes: pinned.bytes,
    signal: input.signal,
  })
  if (createHash('sha256').update(bytes).digest('hex') !== pinned.sha256) {
    throw new Error('its sha256 is not the pinned one')
  }
  return bytes
}

async function downloadAndroid(input: PlaygroundAppsInput): Promise<void> {
  const destination = join(input.dir, PLAYGROUND_APP_PATHS.android)
  if (input.exists(destination) && !input.force) {
    input.record({ path: destination, outcome: 'preserved' })
    return
  }
  const bytes = await fetchPinned(input, 'android')
  input.record(
    writeScaffoldFileAtomic(
      { root: input.dir, path: destination, content: bytes, force: input.force },
      {},
    ),
  )
}

export async function downloadPlaygroundApps(
  input: PlaygroundAppsInput,
): Promise<PlaygroundAppsResult> {
  const result: PlaygroundAppsResult = { arrived: [], failures: [] }
  for (const runtime of input.runtimes) {
    try {
      await downloadAndroid(input)
      result.arrived.push(runtime)
    } catch (error) {
      // Offline, Node's fetch rejects with a TypeError, and init stops on a thrown TypeError.
      result.failures.push({ runtime, reason: failureReason(input.pin, runtime, error) })
    }
  }
  return result
}
