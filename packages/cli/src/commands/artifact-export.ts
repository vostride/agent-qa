// Publishes with link(2), which fails rather than replaces when a competitor published first.

import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  readSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs'
import type { Stats } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

import type { RunsArtifactResult } from '@vostride/agent-qa-schema'

export class ArtifactExportError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ArtifactExportError'
  }
}

export interface ArtifactExportRequest {
  readonly destination: string
  readonly bytes: Uint8Array
  /** The sha256 the bytes must hash to; checked before anything is written. */
  readonly sha256: string
}

export interface ArtifactExportHooks {
  /** Runs after the temporary holds every byte and before publication. */
  beforePublish?: (temporary: string) => void
}

export interface ArtifactExport {
  readonly path: string
  readonly byteLength: number
  readonly sha256: string
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function lstatIfPresent(path: string): Stats | undefined {
  try {
    return lstatSync(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

function statIfPresent(path: string): Stats | undefined {
  try {
    return statSync(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

function existingKind(stat: Stats): string {
  if (stat.isSymbolicLink()) return 'symbolic link'
  if (stat.isDirectory()) return 'directory'
  if (stat.isFile()) return stat.nlink > 1 ? 'hard-linked file' : 'regular file'
  return 'special file'
}

/**
 * Resolve `--out` and refuse it unless it names a new file inside an existing directory. The user
 * names the destination, so a directory reached through a symbolic link (`/tmp` on macOS) is fine.
 */
export function preflightExportDestination(destination: string): string {
  const path = resolve(destination)
  const parent = dirname(path)
  const parentStat = statIfPresent(parent)
  if (parentStat === undefined) {
    throw new ArtifactExportError(
      `Refusing export destination ${path}: its directory ${parent} does not exist (no directory is created)`)
  }
  if (!parentStat.isDirectory()) {
    throw new ArtifactExportError(
      `Refusing export destination ${path}: its parent ${parent} is a ${existingKind(parentStat)}, not a directory`)
  }
  const existing = lstatIfPresent(path)
  if (existing !== undefined) {
    throw new ArtifactExportError(
      `Refusing export destination ${path}: a ${existingKind(existing)} is already there and is not overwritten; `
      + 'choose a new file name')
  }
  return path
}

const CANONICAL_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/

/**
 * The validated bytes of one `runs.artifact` answer. A whole read must hash to the sha it was
 * addressed by; a range read must be exactly the inclusive span it reports.
 */
export function artifactBytes(result: RunsArtifactResult, requestedSha: string): { bytes: Uint8Array; sha256: string } {
  if (result.sha !== requestedSha || !CANONICAL_BASE64.test(result.bytesBase64)) {
    throw new ArtifactExportError(`The artifact answer for ${requestedSha} is not a canonical encoding of it`)
  }
  const bytes = new Uint8Array(Buffer.from(result.bytesBase64, 'base64'))
  if (bytes.length !== result.byteLength) {
    throw new ArtifactExportError(
      `The artifact answer declares ${String(result.byteLength)} bytes but carries ${String(bytes.length)}`)
  }
  const digest = sha256Hex(bytes)
  if (result.range === undefined) {
    if (digest !== requestedSha || (result.totalLength !== undefined && result.totalLength !== bytes.length)) {
      throw new ArtifactExportError(`The artifact bytes do not hash to sha256 ${requestedSha}`)
    }
  } else if (result.range.end - result.range.start + 1 !== bytes.length) {
    throw new ArtifactExportError(
      `The artifact range ${String(result.range.start)}-${String(result.range.end)} does not match its ${String(bytes.length)} bytes`)
  }
  return { bytes, sha256: digest }
}

function unlinkOwned(path: string): void {
  try {
    unlinkSync(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

function writeAll(fd: number, bytes: Uint8Array): void {
  let offset = 0
  while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset)
}

function readAll(fd: number, length: number): Uint8Array {
  const bytes = new Uint8Array(length)
  let offset = 0
  while (offset < length) {
    const count = readSync(fd, bytes, offset, length - offset, offset)
    if (count === 0) break
    offset += count
  }
  return offset === length ? bytes : bytes.subarray(0, offset)
}

function confirmPublished(path: string, identity: { dev: number; ino: number }, request: ArtifactExportRequest): void {
  const { O_RDONLY, O_NOFOLLOW = 0 } = fsConstants
  const fd = openSync(path, O_RDONLY | O_NOFOLLOW)
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.dev !== identity.dev || stat.ino !== identity.ino) {
      throw new ArtifactExportError(`Refusing export destination ${path}: it changed during publication`)
    }
    if (stat.size !== request.bytes.length || sha256Hex(readAll(fd, request.bytes.length)) !== request.sha256) {
      unlinkOwned(path)
      throw new ArtifactExportError(`The exported file ${path} did not read back as sha256 ${request.sha256}; it was removed`)
    }
  } finally {
    closeSync(fd)
  }
}

function syncDirectory(path: string): void {
  let fd: number | undefined
  try {
    fd = openSync(path, 'r')
    fsyncSync(fd)
  } catch {
    // Directory fsync is unsupported on some platforms; the file itself is already synced.
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

export function exportArtifactBytes(request: ArtifactExportRequest, hooks: ArtifactExportHooks = {}): ArtifactExport {
  if (sha256Hex(request.bytes) !== request.sha256) {
    throw new ArtifactExportError(`Refusing to export bytes that do not hash to sha256 ${request.sha256}`)
  }
  const path = preflightExportDestination(request.destination)
  const parent = dirname(path)
  const temporary = join(parent, `.${basename(path)}.agent-qa-export-${String(process.pid)}-${randomUUID()}.tmp`)
  let fd: number | undefined
  let owned = false
  try {
    fd = openSync(temporary, 'wx', 0o666)
    owned = true
    writeAll(fd, request.bytes)
    fsyncSync(fd)
    const { dev, ino } = fstatSync(fd)
    closeSync(fd)
    fd = undefined
    hooks.beforePublish?.(temporary)
    try {
      linkSync(temporary, path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new ArtifactExportError(
          `Refusing export destination ${path}: a file appeared during export and was not overwritten`)
      }
      throw error
    }
    confirmPublished(path, { dev, ino }, request)
    syncDirectory(parent)
    return { path, byteLength: request.bytes.length, sha256: request.sha256 }
  } finally {
    if (fd !== undefined) closeSync(fd)
    if (owned) unlinkOwned(temporary)
  }
}
