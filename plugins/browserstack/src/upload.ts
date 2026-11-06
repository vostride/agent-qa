import { createHash } from 'node:crypto'
import { openAsBlob } from 'node:fs'
import { basename } from 'node:path'
import { PluginError, type PluginProgress } from '@vostride/agent-qa-plugin-kit'
import { browserStackApiFor } from './browserstack-api.js'
import type { BrowserStackOptions } from './options.js'

const MEGABYTE = 1024 * 1024

export function customIdFor(sha256: string): string {
  if (!/^[0-9a-f]{64}$/i.test(sha256)) {
    throw new PluginError("sha256 must be the 64 hex digits of the app's SHA-256.", {
      kind: 'refused',
      path: 'sha256',
    })
  }
  return `agent-qa-${sha256.slice(0, 32).toLowerCase()}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function appUrlOf(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined
  const appUrl = value.app_url
  return typeof appUrl === 'string' && appUrl !== '' ? appUrl : undefined
}

function uploadedAt(value: Record<string, unknown>): number {
  const at = typeof value.uploaded_at === 'string' ? Date.parse(value.uploaded_at) : Number.NaN
  return Number.isNaN(at) ? Number.NEGATIVE_INFINITY : at
}

// Anything but a non-empty list means nothing was uploaded under the custom id yet.
export function newestAppUrl(recent: unknown): string | undefined {
  if (!Array.isArray(recent)) return undefined
  const apps = recent.filter(isRecord).filter((app) => appUrlOf(app) !== undefined)
  const newest = [...apps].sort((a, b) => uploadedAt(b) - uploadedAt(a))[0]
  return appUrlOf(newest)
}

function megabytes(size: number): string {
  const amount = size / MEGABYTE
  return amount >= 0.1 ? amount.toFixed(1) : '<0.1'
}

async function readApp(path: string): Promise<Blob> {
  try {
    return await openAsBlob(path)
  } catch (error) {
    const code =
      error instanceof Error && 'code' in error && typeof error.code === 'string'
        ? error.code
        : 'unreadable'
    throw new PluginError(`The app at ${path} cannot be read (${code}).`, {
      kind: 'refused',
      path: 'path',
    })
  }
}

// The upload is keyed by the host's hash, so the bytes sent must be the bytes it hashed. A blob
// from openAsBlob refuses to read once its file changes, so the checked blob is what is sent.
async function checkContent(app: Blob, request: UploadAppRequest): Promise<void> {
  const changed = () =>
    new PluginError(
      `The app at ${request.path} no longer matches the SHA-256 agent-qa computed; run again.`,
      { kind: 'refused', path: 'path' },
    )
  if (app.size !== request.size) throw changed()
  const hash = createHash('sha256')
  try {
    for await (const chunk of app.stream()) {
      request.signal.throwIfAborted()
      hash.update(chunk)
    }
  } catch (error) {
    if (request.signal.aborted) throw error
    throw changed()
  }
  if (hash.digest('hex') !== request.sha256.toLowerCase()) throw changed()
}

export interface UploadAppRequest {
  options: BrowserStackOptions
  path: string
  sha256: string
  size: number
  signal: AbortSignal
  progress(update: PluginProgress): void
}

export async function uploadApp(request: UploadAppRequest): Promise<{ ref: string }> {
  const customId = customIdFor(request.sha256)
  const api = browserStackApiFor(request.options)
  const reused = newestAppUrl(await api.recentApps(customId, request.signal))
  if (reused !== undefined) return { ref: reused }

  const app = await readApp(request.path)
  await checkContent(app, request)
  const form = new FormData()
  form.append('custom_id', customId)
  form.append('file', app, basename(request.path))
  request.progress({ message: `uploading app (${megabytes(request.size)} MB)` })
  const ref = appUrlOf(await api.uploadApp(form, request.signal))
  if (ref === undefined) {
    throw new PluginError('BrowserStack answered the app upload without an app_url.', {
      kind: 'refused',
    })
  }
  request.progress({ message: 'app uploaded' })
  return { ref }
}
