import type { OwnershipContract, PackageClass } from '../contract-types.js'

const PLUGIN_KIT_PACKAGE_NAME = '@vostride/agent-qa-plugin-kit'
const PLUGINS_ROOT = 'plugins/'

export function findPluginDirectionOffenders(contracts: readonly OwnershipContract[]): string[] {
  const classesByName = new Map<string, readonly PackageClass[]>()
  for (const contract of contracts) {
    classesByName.set(contract.packageName, contract.packageClasses)
  }

  const offenders: string[] = []
  for (const contract of contracts) {
    const name = contract.packageName
    const isPlugin = contract.packageClasses.includes('plugin')
    const isKit = contract.packageClasses.includes('pluginKit')
    const livesInPlugins = contract.packageDir.startsWith(PLUGINS_ROOT)

    if (isPlugin && !livesInPlugins) {
      offenders.push(`plugin direction: ${name} (plugin) lives outside plugins/`)
    }
    if (!isPlugin && livesInPlugins) {
      offenders.push(`plugin direction: ${name} lives in plugins/ without the plugin class`)
    }

    for (const dependency of contract.internalDependencies) {
      if (isPlugin) {
        if (dependency !== PLUGIN_KIT_PACKAGE_NAME) {
          offenders.push(`plugin direction: ${name} (plugin) ⇏ ${dependency}`)
        }
      } else if (isKit) {
        offenders.push(`plugin direction: ${name} (pluginKit) ⇏ ${dependency}`)
      } else if (classesByName.get(dependency)?.includes('plugin')) {
        offenders.push(`plugin direction: ${name} ⇏ ${dependency} (plugin)`)
      }
    }
  }

  return offenders
}
