import { randomUUID } from 'node:crypto'
import {
  readFile,
  writeFile,
  mkdir,
  unlink,
  rename,
  rm,
  lstat,
  realpath,
  readlink,
} from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import type { AuthCredential, AuthStore } from './types.js'

export function getAuthPath(options?: { env?: NodeJS.ProcessEnv; homeDir?: string }): string {
  const xdg = (options?.env ?? process.env).XDG_DATA_HOME
  if (xdg) return join(xdg, 'agent-qa', 'auth.json')
  return join(options?.homeDir ?? homedir(), '.agent-qa', 'auth.json')
}

function isMissingFile(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'
}

async function isSymlink(authPath: string): Promise<boolean> {
  return lstat(authPath).then(
    stats => stats.isSymbolicLink(),
    (error: unknown) => {
      if (isMissingFile(error)) return false
      throw error
    },
  )
}

// A symlinked auth.json keeps its link: the file it points at is the one replaced, the same rule
// ConfigManager.writeTarget applies to the config file.
async function authWriteTarget(authPath: string): Promise<string> {
  if (!(await isSymlink(authPath))) return authPath
  try {
    return await realpath(authPath)
  } catch (error) {
    if (!isMissingFile(error)) throw error
    return resolve(dirname(authPath), await readlink(authPath))
  }
}

async function writeStoreAtomic(authPath: string, store: AuthStore): Promise<void> {
  const target = await authWriteTarget(authPath)
  const directory = dirname(target)
  const tempPath = join(directory, `.${basename(target)}.${process.pid}.${randomUUID()}.tmp`)
  await mkdir(directory, { recursive: true })
  try {
    await writeFile(tempPath, JSON.stringify(store, null, 2), { mode: 0o600 })
    await rename(tempPath, target)
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined)
    throw error
  }
}

export async function readAuth(path?: string): Promise<AuthStore> {
  const authPath = path ?? getAuthPath()
  try {
    const data = await readFile(authPath, 'utf-8')
    return JSON.parse(data) as AuthStore
  } catch {
    return {}
  }
}

export interface SavedCredential {
  name: string
  type: AuthCredential['type']
  provider: string
}

const SAVED_CREDENTIAL_TYPES: ReadonlySet<string> = new Set(['oauth', 'api', 'bearer'])

// Only the name, kind and provider leave this module; a key or token never does.
export async function listSavedCredentials(path?: string): Promise<SavedCredential[]> {
  const store: unknown = await readAuth(path)
  if (typeof store !== 'object' || store === null || Array.isArray(store)) return []
  const saved: SavedCredential[] = []
  for (const [name, entry] of Object.entries(store)) {
    if (typeof entry !== 'object' || entry === null) continue
    const { type, provider } = entry as { type?: unknown; provider?: unknown }
    if (typeof type !== 'string' || !SAVED_CREDENTIAL_TYPES.has(type)) continue
    if (typeof provider !== 'string') continue
    saved.push({ name, type: type as SavedCredential['type'], provider })
  }
  return saved
}

export async function writeAuth(
  provider: string,
  credential: AuthCredential,
  path?: string,
): Promise<void> {
  const authPath = path ?? getAuthPath()
  const store = await readAuth(authPath)
  store[provider] = credential
  await writeStoreAtomic(authPath, store)
}

export async function removeAuth(provider: string, path?: string): Promise<void> {
  const authPath = path ?? getAuthPath()
  const store = await readAuth(authPath)
  delete store[provider]
  if (Object.keys(store).length === 0 && !(await isSymlink(authPath))) {
    try {
      await unlink(authPath)
    } catch {
      // file already gone
    }
    return
  }
  await writeStoreAtomic(authPath, store)
}

export async function getCredential(
  provider: string,
  path?: string,
): Promise<AuthCredential | null> {
  const store = await readAuth(path)
  return store[provider] ?? null
}
