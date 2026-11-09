import { readFileSync } from 'node:fs'
import { parse as parseYaml } from 'yaml'
import { discoverWorkspaceFiles, type ResolvedWorkspacePaths } from '@vostride/agent-qa-core'
import { isLoopbackHost } from '@vostride/agent-qa-schema'

export interface WebPlacement {
  everyWebTestRemote: boolean
  loopbackTargetsByRemote: ReadonlyMap<string, readonly string[]>
}

const LOCAL_PICK = 'local'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function getTargets(
  config: Record<string, unknown> | null,
): Record<string, Record<string, unknown>> {
  const registry = config?.registry as
    { targets?: Record<string, Record<string, unknown>> } | undefined
  return (
    registry?.targets ??
    (config?.targets as Record<string, Record<string, unknown>> | undefined) ??
    {}
  )
}

export function getTargetPlatforms(config: Record<string, unknown> | null): string[] {
  return Object.values(getTargets(config)).map((t) => (t.platform as string) ?? 'web')
}

// A config with no targets counts as web, the default platform.
export function hasWebTarget(config: Record<string, unknown> | null): boolean {
  const platforms = getTargetPlatforms(config)
  if (platforms.length === 0) return true
  return platforms.some((p) => p === 'web')
}

function rawRemotePick(value: unknown): string | undefined {
  const use = isRecord(value) ? value.use : undefined
  const browser = isRecord(use) ? use.browser : undefined
  const remote = isRecord(browser) ? browser.remote : undefined
  return typeof remote === 'string' ? remote : undefined
}

// The host is read by pattern so a url with a templated port still counts.
const URL_HOST = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/?#]*@)?(\[[^\]]*\]|[^:/?#]+)/i

function loopbackWebTargets(config: Record<string, unknown> | null): Set<string> {
  const names = new Set<string>()
  for (const [name, target] of Object.entries(getTargets(config))) {
    if (((target.platform as string | undefined) ?? 'web') !== 'web') continue
    const host = typeof target.url === 'string' ? URL_HOST.exec(target.url)?.[1] : undefined
    if (host !== undefined && isLoopbackHost(host)) names.add(name)
  }
  return names
}

async function readPlacedFiles(
  workspace: ResolvedWorkspacePaths | undefined,
): Promise<{ pick?: string; target?: string }[]> {
  if (!workspace) return []
  try {
    const records = (
      await Promise.all([
        discoverWorkspaceFiles({ workspace, kind: 'test' }),
        discoverWorkspaceFiles({ workspace, kind: 'suite' }),
      ])
    ).flat()
    return records.flatMap((record) => {
      try {
        const parsed: unknown = parseYaml(readFileSync(record.absolutePath, 'utf-8'))
        const target =
          isRecord(parsed) && typeof parsed.target === 'string' ? parsed.target : undefined
        return [{ pick: rawRemotePick(parsed), target }]
      } catch {
        return []
      }
    })
  } catch {
    return []
  }
}

export async function resolveWebPlacement(
  config: Record<string, unknown> | null,
  workspace: ResolvedWorkspacePaths | undefined,
): Promise<WebPlacement> {
  if (!config) return { everyWebTestRemote: false, loopbackTargetsByRemote: new Map() }
  const configPick = rawRemotePick(config)
  const files = await readPlacedFiles(workspace)
  const loopbackTargets = loopbackWebTargets(config)
  const loopbackTargetsByRemote = new Map<string, string[]>()
  for (const file of files) {
    if (file.target === undefined || !loopbackTargets.has(file.target)) continue
    const remote = file.pick ?? configPick
    if (remote === undefined || remote === LOCAL_PICK) continue
    const targets = loopbackTargetsByRemote.get(remote) ?? []
    if (!targets.includes(file.target)) targets.push(file.target)
    loopbackTargetsByRemote.set(remote, targets)
  }
  return {
    everyWebTestRemote:
      configPick !== undefined &&
      configPick !== LOCAL_PICK &&
      !files.some((file) => file.pick === LOCAL_PICK),
    loopbackTargetsByRemote,
  }
}
