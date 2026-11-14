import { readFile } from 'node:fs/promises'
import type { BrowserContext, Page, Route } from 'playwright-core'

type PlaywrightCapture = Awaited<ReturnType<BrowserContext['storageState']>>
type PlaywrightLoad = Exclude<Parameters<BrowserContext['setStorageState']>[0], string>
type CapturedOrigin = PlaywrightCapture['origins'][number] & { sessionStorage?: StorageItem[] }

interface StorageItem {
  name: string
  value: string
}

export type CapturedAuthState = Omit<PlaywrightCapture, 'origins'> & { origins: CapturedOrigin[] }

export type AuthStateContext = Pick<BrowserContext, 'storageState' | 'pages'>

export type SessionStorageByOrigin = Map<string, StorageItem[]>

interface LoadedAuthState {
  playwright: PlaywrightLoad
  sessionStorage: SessionStorageByOrigin
}

interface PageRead {
  origin: unknown
  items: unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isWebOrigin(origin: unknown): origin is string {
  if (typeof origin !== 'string') return false
  try {
    const url = new URL(origin)
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.origin === origin
  } catch {
    return false
  }
}

function storageItems(value: unknown): StorageItem[] {
  if (!Array.isArray(value)) return []
  const items = new Map<string, string>()
  for (const item of value) {
    if (isRecord(item) && typeof item.name === 'string' && typeof item.value === 'string') {
      items.set(item.name, item.value)
    }
  }
  return [...items].map(([name, value]) => ({ name, value }))
}

async function readTopDocument(page: Page): Promise<PageRead | undefined> {
  try {
    return await page.evaluate(() => {
      const items: unknown[] = []
      for (let index = 0; index < sessionStorage.length; index++) {
        const name = sessionStorage.key(index)
        if (name !== null) items.push({ name, value: sessionStorage.getItem(name) })
      }
      const { location } = globalThis as unknown as { location: { origin: string } }
      return { origin: location.origin, items }
    })
  } catch {
    return undefined
  }
}

export async function captureAuthState(context: AuthStateContext): Promise<CapturedAuthState> {
  const state = await context.storageState({ indexedDB: true })
  const byOrigin = new Map<string, Map<string, string>>()
  for (const page of context.pages()) {
    const read = await readTopDocument(page)
    if (read === undefined || !isWebOrigin(read.origin)) continue
    const items = storageItems(read.items)
    if (items.length === 0) continue
    const merged = byOrigin.get(read.origin) ?? new Map<string, string>()
    for (const { name, value } of items) merged.set(name, value)
    byOrigin.set(read.origin, merged)
  }
  if (byOrigin.size === 0) return state

  const listed = (origin: string): StorageItem[] =>
    [...(byOrigin.get(origin) ?? [])].map(([name, value]) => ({ name, value }))
  const origins: CapturedOrigin[] = state.origins.map((entry) =>
    byOrigin.has(entry.origin) ? { ...entry, sessionStorage: listed(entry.origin) } : entry,
  )
  const known = new Set(state.origins.map((entry) => entry.origin))
  for (const origin of byOrigin.keys()) {
    if (!known.has(origin))
      origins.push({ origin, localStorage: [], sessionStorage: listed(origin) })
  }
  return { ...state, origins }
}

function isEmptyList(value: unknown): boolean {
  return !Array.isArray(value) || value.length === 0
}

export async function readAuthStateFile(path: string): Promise<LoadedAuthState> {
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(path, 'utf8'))
  } catch {
    throw new Error('Auth state could not be read.')
  }
  const sessionStorage: SessionStorageByOrigin = new Map()
  if (!isRecord(parsed) || !Array.isArray(parsed.origins)) {
    return { playwright: parsed as PlaywrightLoad, sessionStorage }
  }

  const origins: unknown[] = []
  for (const entry of parsed.origins) {
    if (!isRecord(entry) || !('sessionStorage' in entry)) {
      origins.push(entry)
      continue
    }
    const { sessionStorage: saved, ...rest } = entry
    if (isWebOrigin(entry.origin)) {
      const items = storageItems(saved)
      if (items.length > 0) {
        const merged = new Map(
          (sessionStorage.get(entry.origin) ?? []).map((item) => [item.name, item.value]),
        )
        for (const { name, value } of items) merged.set(name, value)
        sessionStorage.set(
          entry.origin,
          [...merged].map(([name, value]) => ({ name, value })),
        )
      }
    }
    if (!isEmptyList(rest.localStorage) || !isEmptyList(rest.indexedDB)) origins.push(rest)
  }
  return { playwright: { ...parsed, origins } as PlaywrightLoad, sessionStorage }
}

const RESTORE_ROUTE = '**/*'

export async function restoreSessionStorage(
  page: Page,
  entries: SessionStorageByOrigin,
): Promise<void> {
  if (entries.size === 0) return
  const blank = (route: Route) => route.fulfill({ status: 200, contentType: 'text/html', body: '' })
  let origin = [...entries.keys()][0]
  try {
    await page.route(RESTORE_ROUTE, blank)
    let visited = 0
    for (const [next, items] of entries) {
      origin = next
      await page.goto(next)
      visited += 1
      await page.evaluate((pairs) => {
        for (const { name, value } of pairs) sessionStorage.setItem(name, value)
      }, items)
    }
    for (let step = 0; step < visited; step++) await page.goBack()
  } catch {
    throw new Error(`Could not restore sessionStorage for ${origin}.`)
  } finally {
    await page.unroute(RESTORE_ROUTE, blank).catch(() => undefined)
  }
}
