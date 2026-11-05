// A plugin package is code the run loads, so config.auth.set names only one package.

import { SUBSCRIPTION_AUTH_PACKAGE, utf8Decode, utf8Encode } from '@vostride/agent-qa-schema'
import type { ConfigChange } from '@vostride/agent-qa-schema'
import { describe, expect, it } from 'vitest'
import { isMap, isScalar, isSeq, parseDocument } from 'yaml'

import { setConfigAuth } from '../construct.js'
import type { ConstructConfigChangeDeps } from '../construct.js'
import type { ConfigPathFacts, ConfigStructuredValue } from '../ports.js'

const CONFIG_FILE = 'agent-qa.config.yaml'

const CONFIG = `workspace:
  hooksFile: hooks.yaml
registry:
  targets:
    shop:
      platform: web
      url: https://shop.example.com
`

const FIXED_PACKAGE_ONLY =
  'config.auth.set declares only @vostride/agent-qa-subscription-auth. Declare any other auth '
  + 'plugin by editing plugins in the config file.'

const SUBSCRIPTION_ENTRY = { name: 'subscription', package: SUBSCRIPTION_AUTH_PACKAGE }

function harness(config = CONFIG) {
  const inspected: string[][] = []
  const written: (readonly ConfigChange[])[] = []

  const deps: ConstructConfigChangeDeps = {
    configFiles: {
      read: () => Promise.resolve({
        configFile: CONFIG_FILE,
        hooksFile: 'hooks.yaml',
        files: [{ path: CONFIG_FILE, bytes: utf8Encode(config) }, { path: 'hooks.yaml' }],
      }),
      inspect: ({ bytes, paths }) => {
        inspected.push([...paths])
        const document = parseDocument(bytes === undefined ? '' : utf8Decode(bytes))
        return Promise.resolve(paths.map((path): ConfigPathFacts => {
          const node = document.getIn(path.split('.'), true)
          if (node === undefined || node === null) return { path, present: false }
          if (isSeq(node)) {
            return { path, present: true, kind: 'sequence', length: node.items.length }
          }
          if (isMap(node)) {
            return {
              path,
              present: true,
              kind: 'map',
              keys: node.items.map((item) =>
                String(isScalar(item.key) ? item.key.value : item.key)),
            }
          }
          return { path, present: true, kind: 'scalar' }
        }))
      },
      setField: ({ bytes, path, value }: {
        bytes?: Uint8Array
        path: string
        value: ConfigStructuredValue
      }) => {
        const document = parseDocument(bytes === undefined ? '' : utf8Decode(bytes))
        const previous = document.getIn(path.split('.')) as unknown
        document.setIn(path.split('.'), value)
        const mutated = utf8Encode(document.toString())
        return Promise.resolve(
          typeof previous === 'string'
            ? { bytes: mutated, previousValue: previous }
            : { bytes: mutated },
        )
      },
      mintHookId: () => {
        throw new Error('config.auth.set must not mint a hook id')
      },
    },
    configValidate: { validate: () => Promise.resolve({ ok: true as const }) },
    configWrite: {
      applyFields: ({ changes }) => {
        written.push(changes)
        return Promise.resolve({
          kind: 'applied' as const,
          file: CONFIG_FILE,
          revision: 'after',
          baseRevision: 'before',
        })
      },
      publishFiles: () => {
        throw new Error('config.auth.set writes fields, never whole files')
      },
    },
  }

  return { deps, inspected, written }
}

async function authSet(test: ReturnType<typeof harness>, pluginPackage: string) {
  return await setConfigAuth(
    { action: 'config.auth.set', target: 'shop', pluginPackage },
    test.deps,
  )
}

describe('config.auth.set and auth plugin packages', () => {
  it('declares the subscription-auth package past the package check', async () => {
    const test = harness()

    const answer = await authSet(test, SUBSCRIPTION_AUTH_PACKAGE)

    expect(SUBSCRIPTION_AUTH_PACKAGE).toBe('@vostride/agent-qa-subscription-auth')
    expect(answer).toMatchObject({
      outcome: 'applied',
      fields: ['plugins.0.name', 'plugins.0.package'],
    })
    expect(test.inspected).toHaveLength(1)
    expect(test.written).toEqual([[{ op: 'append', path: ['plugins'], value: SUBSCRIPTION_ENTRY }]])
  })

  it('appends the subscription entry after the entries already listed', async () => {
    const test = harness(
      `${CONFIG}plugins:\n  - name: acme\n    package: "@vostride/agent-qa-acme-auth"\n`,
    )

    const answer = await authSet(test, SUBSCRIPTION_AUTH_PACKAGE)

    expect(answer).toMatchObject({
      outcome: 'applied',
      fields: ['plugins.1.name', 'plugins.1.package'],
    })
    expect(test.written).toEqual([[{ op: 'append', path: ['plugins'], value: SUBSCRIPTION_ENTRY }]])
  })

  it('changes nothing when an entry already names the subscription-auth package', async () => {
    const test = harness(
      `${CONFIG}plugins:\n  - name: sign-in\n    package: "${SUBSCRIPTION_AUTH_PACKAGE}"\n`,
    )

    const answer = await authSet(test, SUBSCRIPTION_AUTH_PACKAGE)

    expect(answer).toEqual({ outcome: 'no-change', path: 'bind auth for target shop' })
    expect(test.written).toEqual([])
  })

  it('refuses when an entry named subscription names another plugin', async () => {
    for (const entry of ['package: "@vostride/agent-qa-acme-auth"', 'path: ./plugins/auth']) {
      const test = harness(`${CONFIG}plugins:\n  - name: subscription\n    ${entry}\n`)

      const answer = await authSet(test, SUBSCRIPTION_AUTH_PACKAGE)

      expect(answer).toEqual({
        outcome: 'refused',
        reason: 'unsupported-reference',
        detail:
          'an entry named subscription already names another plugin; rename it or edit plugins '
          + 'in the config file.',
      })
      expect(test.written).toEqual([])
    }
  })

  it('refuses any other package before the document is inspected, and writes nothing', async () => {
    const test = harness()

    const answer = await authSet(test, '@acme/other-auth')

    expect(answer).toEqual({
      outcome: 'refused',
      reason: 'unsupported-reference',
      detail: FIXED_PACKAGE_ONLY,
    })
    expect(test.inspected).toEqual([])
    expect(test.written).toEqual([])
  })

  it('refuses a package that only starts like the subscription-auth one', async () => {
    const test = harness()

    const answer = await authSet(test, `${SUBSCRIPTION_AUTH_PACKAGE}-extra`)

    expect(answer).toMatchObject({ outcome: 'refused', reason: 'unsupported-reference' })
    expect(test.written).toEqual([])
  })

  it('refuses a path through the reference check', async () => {
    const test = harness()

    const answer = await authSet(test, './local/plugin')

    expect(answer).toMatchObject({ outcome: 'refused', reason: 'refs-only' })
    if (answer.outcome !== 'refused') throw new Error('unreachable')
    expect(answer.detail).toContain('not shaped like a plugin-package')
    expect(test.inspected).toEqual([])
    expect(test.written).toEqual([])
  })
})
