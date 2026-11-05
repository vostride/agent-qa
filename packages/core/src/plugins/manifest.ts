import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

import {
  PLUGIN_MANIFEST_FIELD,
  PluginManifestSchema,
  type PluginManifest,
} from '@vostride/agent-qa-plugin-kit/protocol'

import { exportTargetFromPackageJson } from '../plugin-loader-util.js'
import { isPathInsideDir } from '../utils/path-validation.js'

export const SUBSCRIPTION_AUTH_PACKAGE = '@vostride/agent-qa-subscription-auth'

export type PluginManifestRead =
  | { ok: true; manifest: PluginManifest; name: string; version: string; packageDir: string }
  | { ok: false; issue: string; name?: string; version?: string; packageDir: string }

const MANIFEST_POSITION = `${PLUGIN_MANIFEST_FIELD}.plugin`
const MANIFEST_PATH_FIELDS = ['entry', 'options', 'settings', 'skill'] as const

// A file that does not exist yet still resolves through its nearest existing folder.
function realpathOfNearest(target: string): string {
  let current = target
  const rest: string[] = []
  while (!existsSync(current)) {
    const parent = dirname(current)
    if (parent === current) return target
    rest.unshift(basename(current))
    current = parent
  }
  return join(realpathSync(current), ...rest)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function issuePosition(issue: { path: PropertyKey[]; code: string; keys?: string[] }): string {
  const path = issue.path.map(String)
  if (issue.code === 'unrecognized_keys' && issue.keys?.[0]) path.push(issue.keys[0])
  return [MANIFEST_POSITION, ...path].join('.')
}

function declaredManifest(pkg: Record<string, unknown>, name: string): unknown {
  const field = pkg[PLUGIN_MANIFEST_FIELD]
  if (field === undefined && name === SUBSCRIPTION_AUTH_PACKAGE) {
    const entry = exportTargetFromPackageJson(pkg)
    return entry ? { kind: 'model-auth', runs: 'in-process', entry } : undefined
  }
  return isRecord(field) ? field.plugin : undefined
}

export function readPluginManifest(packageJsonPath: string): PluginManifestRead {
  const packageDir = dirname(packageJsonPath)
  let pkg: unknown
  try {
    pkg = JSON.parse(readFileSync(packageJsonPath, 'utf-8'))
  } catch {
    return { ok: false, issue: 'package.json is not readable JSON', packageDir }
  }
  if (!isRecord(pkg)) return { ok: false, issue: 'package.json is not an object', packageDir }

  const name = typeof pkg.name === 'string' ? pkg.name : ''
  const version = typeof pkg.version === 'string' ? pkg.version : ''
  const declared = declaredManifest(pkg, name)
  if (declared === undefined) {
    return { ok: false, issue: `${MANIFEST_POSITION} is missing`, name, version, packageDir }
  }

  const parsed = PluginManifestSchema.safeParse(declared)
  if (!parsed.success) {
    const first = parsed.error.issues[0]
    const issue = first ? issuePosition(first) : MANIFEST_POSITION
    return { ok: false, issue, name, version, packageDir }
  }

  const realPackageDir = realpathSync(packageDir)
  const manifest = parsed.data
  const fields: Record<string, unknown> = manifest
  for (const field of MANIFEST_PATH_FIELDS) {
    const value = fields[field]
    if (typeof value !== 'string') continue
    const real = realpathOfNearest(resolve(realPackageDir, value))
    if (!isPathInsideDir(real, realPackageDir)) {
      const issue = `${field} resolves outside the package`
      return { ok: false, issue, name, version, packageDir }
    }
  }

  return { ok: true, manifest, name, version, packageDir }
}
