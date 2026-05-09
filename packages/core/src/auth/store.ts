import { readFile, writeFile, mkdir, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import type { AuthCredential, AuthStore } from './types.js'

export function getAuthPath(): string {
  const xdg = process.env.XDG_DATA_HOME
  if (xdg) return join(xdg, 'agent-qa', 'auth.json')
  return join(homedir(), '.agent-qa', 'auth.json')
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

export async function writeAuth(
  provider: string,
  credential: AuthCredential,
  path?: string,
): Promise<void> {
  const authPath = path ?? getAuthPath()
  const store = await readAuth(authPath)
  store[provider] = credential
  await mkdir(dirname(authPath), { recursive: true })
  await writeFile(authPath, JSON.stringify(store, null, 2), { mode: 0o600 })
}

export async function removeAuth(provider: string, path?: string): Promise<void> {
  const authPath = path ?? getAuthPath()
  const store = await readAuth(authPath)
  delete store[provider]
  if (Object.keys(store).length === 0) {
    try {
      await unlink(authPath)
    } catch {
      // file already gone
    }
    return
  }
  await writeFile(authPath, JSON.stringify(store, null, 2), { mode: 0o600 })
}

export async function getCredential(
  provider: string,
  path?: string,
): Promise<AuthCredential | null> {
  const store = await readAuth(path)
  return store[provider] ?? null
}
