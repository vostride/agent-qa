import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

// Every fixture entry throws on import, so a resolve that ran plugin code fails loudly.
export const THROWING_ENTRY = "throw new Error('plugin code ran')\n"

export interface FixtureRoot {
  root: string
  configDir: string
  remove(): void
}

export function createFixtureRoot(prefix: string): FixtureRoot {
  const root = mkdtempSync(join(tmpdir(), prefix))
  const configDir = join(root, 'project')
  mkdirSync(configDir, { recursive: true })
  return { root, configDir, remove: () => rmSync(root, { recursive: true, force: true }) }
}

export function remoteManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 'remote',
    runs: 'process',
    protocol: 1,
    entry: './dist/main.js',
    serves: ['playwright'],
    methods: [],
    options: './dist/options.schema.json',
    settings: './dist/settings.schema.json',
    ...overrides,
  }
}

export function inProcessManifest(
  kind: 'model-auth' | 'model-provider',
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return { kind, runs: 'in-process', entry: './dist/index.js', ...overrides }
}

export function writeFile(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}

export function writePluginPackage(
  dir: string,
  pkg: Record<string, unknown>,
  files: Record<string, string> = {},
): string {
  writeFile(join(dir, 'package.json'), JSON.stringify(pkg, null, 2))
  writeFile(join(dir, 'dist', 'main.js'), THROWING_ENTRY)
  writeFile(join(dir, 'dist', 'index.js'), THROWING_ENTRY)
  for (const [relativePath, text] of Object.entries(files)) writeFile(join(dir, relativePath), text)
  return dir
}

export function installPluginPackage(
  configDir: string,
  name: string,
  version: string,
  manifest: Record<string, unknown> | undefined,
  extra: Record<string, unknown> = {},
): string {
  const dir = join(configDir, 'node_modules', ...name.split('/'))
  const pkg = {
    name,
    version,
    ...(manifest === undefined ? {} : { 'agent-qa': { plugin: manifest } }),
    ...extra,
  }
  return writePluginPackage(dir, pkg)
}
