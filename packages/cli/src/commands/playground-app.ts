import { createHash, randomUUID } from 'node:crypto'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { inflateRawSync } from 'node:zlib'

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

interface ZipEntry {
  name: string
  directory: boolean
  mode: number
  bytes: Uint8Array
}

const END_RECORD = Buffer.from([0x50, 0x4b, 0x05, 0x06])
const DIRECTORY_HEADER = 0x02014b50
const LOCAL_HEADER = 0x04034b50

// Only an archive whose sha256 matched the pin reaches this reader, so it handles what the
// pinned build uses and refuses the rest rather than half-reading it.
function zipEntries(archive: Uint8Array): ZipEntry[] {
  const zip = Buffer.from(archive.buffer, archive.byteOffset, archive.byteLength)
  const end = zip.lastIndexOf(END_RECORD)
  if (end === -1 || end + 22 > zip.byteLength) throw new Error('it has no end record')
  const count = zip.readUInt16LE(end + 10)
  let at = zip.readUInt32LE(end + 16)
  if (count === 0xffff || at === 0xffffffff) throw new Error('it is a zip64 archive')

  const entries: ZipEntry[] = []
  for (let index = 0; index < count; index += 1) {
    if (at + 46 > zip.byteLength || zip.readUInt32LE(at) !== DIRECTORY_HEADER) {
      throw new Error('its central directory is damaged')
    }
    const flags = zip.readUInt16LE(at + 8)
    const method = zip.readUInt16LE(at + 10)
    const compressedSize = zip.readUInt32LE(at + 20)
    const size = zip.readUInt32LE(at + 24)
    const nameLength = zip.readUInt16LE(at + 28)
    const extraLength = zip.readUInt16LE(at + 30)
    const commentLength = zip.readUInt16LE(at + 32)
    const mode = zip.readUInt32LE(at + 38) >>> 16
    const local = zip.readUInt32LE(at + 42)
    const name = zip.toString('utf8', at + 46, at + 46 + nameLength)
    if ((flags & 0x1) !== 0) throw new Error(`${name} is encrypted`)
    if (method !== 0 && method !== 8) throw new Error(`${name} is compressed with method ${method}`)
    if ((mode & 0o170000) === 0o120000) throw new Error(`${name} is a symbolic link`)
    if (local + 30 > zip.byteLength || zip.readUInt32LE(local) !== LOCAL_HEADER) {
      throw new Error(`${name} has no local header`)
    }
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28)
    if (start + compressedSize > zip.byteLength) {
      throw new Error(`${name} runs past the end of the archive`)
    }
    const raw = zip.subarray(start, start + compressedSize)
    const bytes = method === 0 ? raw : inflateRawSync(raw)
    if (bytes.byteLength !== size) {
      throw new Error(`${name} inflates to ${bytes.byteLength} bytes, not ${size}`)
    }
    entries.push({ name, directory: name.endsWith('/'), mode, bytes })
    at += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

interface AppFile {
  // Inside the app's folder.
  path: string
  bytes: Uint8Array
  mode: number
}

// Every entry is checked before the first file is written, so a refused archive writes nothing.
function appFiles(archive: Uint8Array, folder: string): AppFile[] {
  const files: AppFile[] = []
  for (const entry of zipEntries(archive)) {
    const path = resolve(dirname(folder), entry.name)
    const inside = path.startsWith(`${folder}${sep}`) || (entry.directory && path === folder)
    if (!inside) throw new Error(`${entry.name} is outside ${basename(folder)}`)
    if (entry.directory) continue
    files.push({ path: relative(folder, path), bytes: entry.bytes, mode: entry.mode & 0o777 })
  }
  if (files.length === 0) throw new Error('it holds no file')
  return files
}

export interface PlaygroundAppsInput {
  dir: string
  runtimes: readonly PlaygroundRuntime[]
  pin: PlaygroundAppPin
  fetch: PlaygroundAppFetch
  exists: (path: string) => boolean
  removeFolder: (path: string) => void
  moveFolder: (from: string, to: string) => void
  force: boolean
  signal: AbortSignal
  record: (result: InitFileResult) => void
}

export interface PlaygroundAppsResult {
  arrived: PlaygroundRuntime[]
  failures: { runtime: PlaygroundRuntime; reason: string }[]
}

const RUNTIME_NAMES: Record<PlaygroundRuntime, string> = { android: 'Android', ios: 'iOS' }

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function failureReason(pin: PlaygroundAppPin, runtime: PlaygroundRuntime, error: unknown): string {
  return (
    `The Playground app for ${RUNTIME_NAMES[runtime]} was not downloaded: ` +
    `${messageOf(error).replace(/\.$/u, '')}. ` +
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

// A name the .gitignore rule init writes for its temporaries covers.
function temporaryBeside(folder: string): string {
  return join(
    dirname(folder),
    `.${basename(folder)}.agent-qa-init-${process.pid}-${randomUUID()}.tmp`,
  )
}

function removeTemporary(input: PlaygroundAppsInput, folder: string): void {
  try {
    input.removeFolder(folder)
  } catch (error) {
    // A removal refused before the folder was made leaves nothing to report.
    if (!input.exists(folder)) return
    process.emitWarning(
      `agent-qa init could not remove its temporary folder ${folder} (${messageOf(error)}). ` +
        'Delete it.',
    )
  }
}

// The older build is moved aside whole, and moved back when the new one cannot take its place.
function replaceFolder(input: PlaygroundAppsInput, staging: string, folder: string): void {
  const retired = temporaryBeside(folder)
  input.moveFolder(folder, retired)
  try {
    input.moveFolder(staging, folder)
  } catch (error) {
    try {
      input.moveFolder(retired, folder)
    } catch (restoreError) {
      throw new Error(
        `${messageOf(error)}, and the build that was there is now ${retired} ` +
          `(${messageOf(restoreError)})`,
      )
    }
    throw error
  }
  removeTemporary(input, retired)
}

async function downloadIOS(input: PlaygroundAppsInput): Promise<void> {
  const folder = join(input.dir, PLAYGROUND_APP_PATHS.ios)
  const present = input.exists(folder)
  if (present && !input.force) {
    input.record({ path: folder, outcome: 'preserved' })
    return
  }
  const archive = await fetchPinned(input, 'ios')
  let files: AppFile[]
  try {
    files = appFiles(archive, folder)
  } catch (error) {
    throw new Error(`its archive cannot be used (${messageOf(error)})`)
  }
  // The build is unpacked beside its folder and moved in whole, so Playground.app is a complete
  // build or the one that was there, and never part of one.
  const staging = temporaryBeside(folder)
  try {
    for (const file of files) {
      writeScaffoldFileAtomic(
        {
          root: input.dir,
          path: join(staging, file.path),
          content: file.bytes,
          ...(file.mode === 0 ? {} : { mode: file.mode }),
        },
        {},
      )
    }
    // Only a forced download gets here with the folder present.
    if (present) replaceFolder(input, staging, folder)
    else input.moveFolder(staging, folder)
  } catch (error) {
    removeTemporary(input, staging)
    throw error
  }
  input.record({ path: folder, outcome: present ? 'updated' : 'created' })
}

const DOWNLOADS: Record<PlaygroundRuntime, (input: PlaygroundAppsInput) => Promise<void>> = {
  android: downloadAndroid,
  ios: downloadIOS,
}

export async function downloadPlaygroundApps(
  input: PlaygroundAppsInput,
): Promise<PlaygroundAppsResult> {
  const result: PlaygroundAppsResult = { arrived: [], failures: [] }
  for (const runtime of input.runtimes) {
    try {
      await DOWNLOADS[runtime](input)
      result.arrived.push(runtime)
    } catch (error) {
      // Offline, Node's fetch rejects with a TypeError, and init stops on a thrown TypeError.
      result.failures.push({ runtime, reason: failureReason(input.pin, runtime, error) })
    }
  }
  return result
}
