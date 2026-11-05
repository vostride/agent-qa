import { describe, expect, it } from 'vitest'
import { ARCH_MANIFEST } from '../../manifest.js'
import type { OwnershipContract, PackageClass } from '../../contract-types.js'
import { findPluginDirectionOffenders } from '../plugin-direction.js'

const KIT = '@vostride/agent-qa-plugin-kit'
const CORE = '@vostride/agent-qa-core'

function contract(
  packageName: string,
  packageDir: string,
  packageClasses: readonly PackageClass[],
  internalDependencies: readonly string[] = [],
): OwnershipContract {
  return {
    packageName,
    packageDir,
    packageClasses,
    allowedResponsibilities: [],
    forbiddenResponsibilities: [],
    externalDependencies: [],
    internalDependencies,
  }
}

const kit = contract(KIT, 'packages/plugin-kit', ['pluginKit'])
const acme = contract('@acme/agent-qa-plugin-acme', 'plugins/acme', ['plugin'], [KIT])

describe('findPluginDirectionOffenders', () => {
  it('finds no plugin direction offender in the live architecture manifest', () => {
    expect(findPluginDirectionOffenders(ARCH_MANIFEST.packages)).toEqual([])
  })

  it('accepts a plugin in plugins/ that depends only on the kit', () => {
    expect(findPluginDirectionOffenders([kit, acme])).toEqual([])
  })

  it('reports a plugin depending on an agent-qa package other than the kit', () => {
    expect(
      findPluginDirectionOffenders([
        kit,
        contract(CORE, 'packages/core', ['transitional']),
        contract('@acme/agent-qa-plugin-acme', 'plugins/acme', ['plugin'], [KIT, CORE]),
      ]),
    ).toEqual(['plugin direction: @acme/agent-qa-plugin-acme (plugin) ⇏ @vostride/agent-qa-core'])
  })

  it('reports a non-plugin package depending on a plugin', () => {
    expect(
      findPluginDirectionOffenders([
        kit,
        acme,
        contract('agent-qa', 'packages/cli', ['surface'], ['@acme/agent-qa-plugin-acme']),
      ]),
    ).toEqual(['plugin direction: agent-qa ⇏ @acme/agent-qa-plugin-acme (plugin)'])
  })

  it('reports a kit with any internal dependency', () => {
    expect(
      findPluginDirectionOffenders([
        contract(KIT, 'packages/plugin-kit', ['pluginKit'], ['@vostride/agent-qa-schema']),
        contract('@vostride/agent-qa-schema', 'packages/schema', ['browserSafe']),
      ]),
    ).toEqual([
      'plugin direction: @vostride/agent-qa-plugin-kit (pluginKit) ⇏ @vostride/agent-qa-schema',
    ])
  })

  it('reports a plugin contract that lives outside plugins/', () => {
    expect(
      findPluginDirectionOffenders([
        kit,
        contract('@acme/agent-qa-plugin-acme', 'packages/acme', ['plugin'], [KIT]),
      ]),
    ).toEqual(['plugin direction: @acme/agent-qa-plugin-acme (plugin) lives outside plugins/'])
  })

  it('reports a package in plugins/ without the plugin class', () => {
    expect(
      findPluginDirectionOffenders([
        kit,
        contract('@acme/agent-qa-plugin-acme', 'plugins/acme', ['adapter'], [KIT]),
      ]),
    ).toEqual([
      'plugin direction: @acme/agent-qa-plugin-acme lives in plugins/ without the plugin class',
    ])
  })
})
