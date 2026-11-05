import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

export interface PluginHostVersions {
  playwright: string
  webdriverio: string
}

function resolvedFrom(specifier: string, fromUrl: string): string | undefined {
  try {
    return createRequire(fromUrl).resolve(specifier)
  } catch {
    return undefined
  }
}

// The package may not export its package.json, so the folder holding it is found from its entry.
function versionAbove(name: string, entry: string): string | undefined {
  for (let dir = dirname(entry); ; dir = dirname(dir)) {
    const manifest = join(dir, 'package.json')
    if (existsSync(manifest)) {
      try {
        const parsed = JSON.parse(readFileSync(manifest, 'utf8')) as {
          name?: unknown
          version?: unknown
        }
        if (parsed.name === name && typeof parsed.version === 'string') return parsed.version
      } catch {
        return undefined
      }
    }
    if (dirname(dir) === dir) return undefined
  }
}

export function installedPackageVersion(specifier: string, fromUrl: string): string {
  const entry = resolvedFrom(specifier, fromUrl)
  return (entry === undefined ? undefined : versionAbove(specifier, entry)) ?? 'unknown'
}

// Read where the adapter loads it, so a plugin is told the version its session is driven with.
function adapterLibraryVersion(name: string, adapterPackage: string, fromUrl: string): string {
  const adapter = resolvedFrom(adapterPackage, fromUrl)
  const viaAdapter =
    adapter === undefined ? 'unknown' : installedPackageVersion(name, pathToFileURL(adapter).href)
  return viaAdapter === 'unknown' ? installedPackageVersion(name, fromUrl) : viaAdapter
}

export function pluginHostVersions(fromUrl: string): PluginHostVersions {
  return {
    playwright: adapterLibraryVersion('playwright-core', '@vostride/agent-qa-web', fromUrl),
    webdriverio: adapterLibraryVersion('webdriverio', '@vostride/agent-qa-android', fromUrl),
  }
}
