import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  derivePublishOrder,
  getPublicPackages,
  publicPackageNames,
  workspacePackageDirs,
} from '../release/packages.mjs'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

function publishableManifestNames() {
  return workspacePackageDirs(repoRoot)
    .map(dir => JSON.parse(readFileSync(join(repoRoot, dir, 'package.json'), 'utf8')))
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

test('a listed package that does not declare "private": false is told to declare it', () => {
  for (const value of [undefined, 'false', 0]) {
    const records = publicPackageNames.map(name => ({
      pkg: name === 'agent-qa' ? { name, private: value } : { name, private: false },
    }))
    assert.throws(() => derivePublishOrder(records), {
      message: 'public package must declare "private": false: agent-qa',
    })
  }
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

async function withPublicPackages(placements, fn) {
  const rootDir = await mkdtemp(join(tmpdir(), 'agent-qa-release-roots-'))
  try {
    for (const name of publicPackageNames) {
      const dir = placements[name] ?? join('packages', name.replace('@vostride/', ''))
      mkdirSync(join(rootDir, dir), { recursive: true })
      writeFileSync(join(rootDir, dir, 'package.json'), JSON.stringify({ name, version: '0.1.1', private: false }))
    }
    return await fn(rootDir)
  } finally {
    await rm(rootDir, { recursive: true, force: true })
  }
}

test('public packages are read from packages/ and plugins/', async () => {
  const name = publicPackageNames[0]
  await withPublicPackages({ [name]: join('plugins', 'acme') }, rootDir => {
    const records = getPublicPackages({ rootDir })
    assert.deepEqual(records.map(record => record.name), publicPackageNames)
    assert.equal(records[0].manifestPath, join(rootDir, 'plugins', 'acme', 'package.json'))
  })
})

test('public packages are read from packages/ alone when plugins/ is absent', async () => {
  await withPublicPackages({}, rootDir => {
    const records = getPublicPackages({ rootDir })
    assert.deepEqual(records.map(record => record.name), publicPackageNames)
    assert.ok(records.every(record => record.manifestPath.startsWith(join(rootDir, 'packages'))))
  })
})

test('an unlisted public package under plugins/ is refused as extra', async () => {
  await withPublicPackages({}, rootDir => {
    mkdirSync(join(rootDir, 'plugins', 'acme'), { recursive: true })
    writeFileSync(
      join(rootDir, 'plugins', 'acme', 'package.json'),
      JSON.stringify({ name: '@vostride/agent-qa-plugin-acme', version: '0.1.1', private: false }),
    )
    assert.throws(() => getPublicPackages({ rootDir }), /extra public package: @vostride\/agent-qa-plugin-acme/)
  })
})
