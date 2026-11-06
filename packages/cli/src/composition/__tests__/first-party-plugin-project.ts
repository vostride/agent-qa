// A project gets a first-party plugin the way an install gives it one: the built plugin folder at
// node_modules/@vostride/agent-qa-plugin-<id>. agent-qa's packages never depend on a plugin, so
// the folder is linked by path, and the vendor fakes are loaded from the plugin's own tests.

import { existsSync, mkdirSync, symlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export type FirstPartyPluginId = 'kernel' | 'browserstack' | 'steel' | 'hyperbrowser'

const PLUGINS_DIR = fileURLToPath(new URL('../../../../../plugins/', import.meta.url))

export interface LinkedPlugin {
  readonly packageName: string
  // The entry file as agent-qa spawns it, through the project's node_modules.
  readonly entryFile: string
}

export function pluginPackageName(id: FirstPartyPluginId): string {
  return `@vostride/agent-qa-plugin-${id}`
}

export function linkBuiltPlugin(projectDir: string, id: FirstPartyPluginId): LinkedPlugin {
  const pluginDir = join(PLUGINS_DIR, id)
  const packageName = pluginPackageName(id)
  if (!existsSync(join(pluginDir, 'dist', 'main.js'))) {
    throw new Error(
      `The ${id} plugin is not built (no ${join(pluginDir, 'dist', 'main.js')}); run ` +
        `pnpm --filter ${packageName} build, or pnpm build. Never skip.`,
    )
  }
  const linkDir = join(projectDir, 'node_modules', ...packageName.split('/'))
  mkdirSync(dirname(linkDir), { recursive: true })
  symlinkSync(pluginDir, linkDir, 'dir')
  return { packageName, entryFile: join(linkDir, 'dist', 'main.js') }
}

export function pluginTestModule(id: FirstPartyPluginId, file: string): string {
  return pathToFileURL(join(PLUGINS_DIR, id, 'src', '__tests__', file)).href
}
