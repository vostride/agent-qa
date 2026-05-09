import assert from 'node:assert/strict'
import test from 'node:test'
import { derivePublishOrder, publicPackageNames } from '../release/packages.mjs'

test('derives dependency-first individual package publish order', () => {
  const shuffled = [...publicPackageNames].reverse().map(name => ({ name, pkg: { name, private: false } }))
  const ordered = derivePublishOrder(shuffled).map(record => record.pkg.name)

  assert.deepEqual(ordered, [
    '@vostride/agent-qa-ids',
    '@vostride/agent-qa-core',
    '@vostride/agent-qa-web',
    '@vostride/agent-qa-android',
    '@vostride/agent-qa-ios',
    '@vostride/agent-qa-mcp',
    '@vostride/agent-qa-dashboard-ui',
    '@vostride/agent-qa-dashboard',
    'agent-qa',
  ])
})

test('rejects missing, duplicate, private, or extra public package records', () => {
  assert.throws(() => derivePublishOrder([]), /missing public package/)
  assert.throws(
    () => derivePublishOrder([
      ...publicPackageNames.map(name => ({ pkg: { name, private: false } })),
      { pkg: { name: 'agent-qa', private: false } },
    ]),
    /duplicate public package/,
  )
  assert.throws(
    () => derivePublishOrder(publicPackageNames.map(name => ({ pkg: { name, private: name === 'agent-qa' } }))),
    /private public package/,
  )
  assert.throws(
    () => derivePublishOrder([
      ...publicPackageNames.map(name => ({ pkg: { name, private: false } })),
      { pkg: { name: '@vostride/agent-qa-extra', private: false } },
    ]),
    /extra public package/,
  )
})
