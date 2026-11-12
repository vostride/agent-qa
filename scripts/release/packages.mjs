import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const publicPackageNames = [
  '@vostride/agent-qa-ids',
  '@vostride/agent-qa-schema',
  '@vostride/agent-qa-plugin-kit',
  '@vostride/agent-qa-plugin-kernel',
  '@vostride/agent-qa-plugin-browserstack',
  '@vostride/agent-qa-plugin-steel',
  '@vostride/agent-qa-plugin-hyperbrowser',
  '@vostride/agent-qa-safety',
  '@vostride/agent-qa-runner',
  '@vostride/agent-qa-runner-local',
  '@vostride/agent-qa-eval',
  '@vostride/agent-qa-agent',
  '@vostride/agent-qa-model',
  '@vostride/agent-qa-knowledge-local',
  '@vostride/agent-qa-safety-local',
  '@vostride/agent-qa-eval-local',
  '@vostride/agent-qa-core',
  '@vostride/agent-qa-web',
  '@vostride/agent-qa-agent-local',
  '@vostride/agent-qa-appium-runtime',
  '@vostride/agent-qa-android',
  '@vostride/agent-qa-ios',
  '@vostride/agent-qa-mcp',
  // After `mcp`, which it depends on; each package follows every internal dependency it declares.
  '@vostride/agent-qa-analytics',
  '@vostride/agent-qa-dashboard-ui',
  '@vostride/agent-qa-dashboard',
  'agent-qa',
]

export const defaultRootDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

export function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

const workspaceRoots = ['packages', 'plugins']

// Every workspace member with a package.json, as root-relative paths such as `plugins/kernel`.
export function workspacePackageDirs(rootDir = defaultRootDir) {
  return workspaceRoots
    .flatMap(root => {
      const rootPath = join(rootDir, root)
      if (!existsSync(rootPath)) return []
      return readdirSync(rootPath)
        .filter(name => {
          const dir = join(rootPath, name)
          return statSync(dir).isDirectory() && existsSync(join(dir, 'package.json'))
        })
        .map(name => `${root}/${name}`)
    })
    .sort()
}

// A plugin stages as `plugins-<folder>`, apart from any `packages/<folder>` of the same name.
export function stagedDirName(packageDir) {
  const [root, name] = packageDir.split('/')
  return root === 'plugins' ? `plugins-${name}` : name
}

function refuseStagedDirCollisions(records) {
  const claimed = new Map()
  for (const record of records) {
    const other = claimed.get(record.packageDirName)
    if (other !== undefined) {
      throw new Error(
        `staged folder ${record.packageDirName} is claimed by both ${other} and ${record.name}; rename one of their folders`,
      )
    }
    claimed.set(record.packageDirName, record.name)
  }
}

export function getPublicPackages(options = {}) {
  const rootDir = options.rootDir ?? defaultRootDir
  const packagesRoot = join(rootDir, 'packages')
  if (!existsSync(packagesRoot)) {
    throw new Error(`public packages root is missing: ${packagesRoot}`)
  }

  const records = workspacePackageDirs(rootDir)
    .map(packageDir => {
      const dir = join(rootDir, packageDir)
      const manifestPath = join(dir, 'package.json')
      const pkg = readJson(manifestPath)
      return { name: pkg.name, dir, manifestPath, packageDirName: stagedDirName(packageDir), pkg }
    })
    .filter(record => record.pkg.private !== true)

  refuseStagedDirCollisions(records)
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
    if (record.pkg?.private === true) {
      throw new Error(`private public package: ${name}`)
    }
    if (record.pkg?.private !== false) {
      throw new Error(`public package must declare "private": false: ${name}`)
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
