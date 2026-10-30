import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { derivePublishOrder, getPublicPackages, publicPackageNames } from '../release/packages.mjs'

const packagesDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'packages')

function publishableManifestNames() {
  return readdirSync(packagesDir)
    .map(dirName => join(packagesDir, dirName, 'package.json'))
    .filter(manifestPath => existsSync(manifestPath))
    .map(manifestPath => JSON.parse(readFileSync(manifestPath, 'utf8')))
    .filter(pkg => pkg.private !== true)
    .map(pkg => pkg.name)
}

test('publish order lists exactly the publishable manifests and puts every internal dependency first', () => {
  assert.deepEqual(new Set(publishableManifestNames()), new Set(publicPackageNames))
  const records = getPublicPackages()
  const position = new Map(publicPackageNames.map((name, index) => [name, index]))
  for (const record of records) {
    for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
      for (const dep of Object.keys(record.pkg[field] ?? {})) {
        if (!position.has(dep)) continue
        assert.ok(
          position.get(dep) < position.get(record.pkg.name),
          `${record.pkg.name} publishes before ${dep}`,
        )
      }
    }
  }
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

test('a manifest with no private field counts as publishable and must be in the publish order', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'agent-qa-release-publish-order-'))
  try {
    const writeManifest = (dirName, pkg) => {
      mkdirSync(join(rootDir, 'packages', dirName), { recursive: true })
      writeFileSync(join(rootDir, 'packages', dirName, 'package.json'), JSON.stringify(pkg))
    }
    for (const name of publicPackageNames) {
      writeManifest(name.replace('@vostride/', ''), { name, version: '0.1.1', private: false })
    }
    writeManifest('agent-qa-unlisted', { name: '@vostride/agent-qa-unlisted', version: '0.1.1' })

    assert.throws(
      () => getPublicPackages({ rootDir }),
      /extra public package: @vostride\/agent-qa-unlisted/,
    )
  } finally {
    await rm(rootDir, { recursive: true, force: true })
  }
})
