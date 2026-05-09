import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const publicPackageNames = [
  '@vostride/agent-qa-ids',
  '@vostride/agent-qa-core',
  '@vostride/agent-qa-web',
  '@vostride/agent-qa-android',
  '@vostride/agent-qa-ios',
  '@vostride/agent-qa-mcp',
  '@vostride/agent-qa-dashboard-ui',
  '@vostride/agent-qa-dashboard',
  'agent-qa',
]

export const defaultRootDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

export function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

export function getPublicPackages(options = {}) {
  const rootDir = options.rootDir ?? defaultRootDir
  const packagesRoot = join(rootDir, 'packages')
  if (!existsSync(packagesRoot)) {
    throw new Error(`public packages root is missing: ${packagesRoot}`)
  }

  const records = readdirSync(packagesRoot)
    .map(name => join(packagesRoot, name))
    .filter(dir => statSync(dir).isDirectory() && existsSync(join(dir, 'package.json')))
    .map(dir => {
      const manifestPath = join(dir, 'package.json')
      const pkg = readJson(manifestPath)
      return { name: pkg.name, dir, manifestPath, packageDirName: basename(dir), pkg }
    })
    .filter(record => record.pkg.private === false)

  return derivePublishOrder(records)
}

export function derivePublishOrder(records = getPublicPackages()) {
  const byName = new Map()
  const extras = []

  for (const record of records) {
    const name = record.pkg?.name ?? record.name
    if (!name) throw new Error('public package record missing name')
    if (!publicPackageNames.includes(name)) {
      extras.push(name)
      continue
    }
    if (record.pkg?.private !== false) {
      throw new Error(`private public package: ${name}`)
    }
    if (byName.has(name)) {
      throw new Error(`duplicate public package: ${name}`)
    }
    byName.set(name, { ...record, name, pkg: { ...record.pkg, name } })
  }

  if (extras.length > 0) {
    throw new Error(`extra public package: ${extras.join(', ')}`)
  }

  const missing = publicPackageNames.filter(name => !byName.has(name))
  if (missing.length > 0) {
    throw new Error(`missing public package: ${missing.join(', ')}`)
  }

  return publicPackageNames.map(name => byName.get(name))
}
