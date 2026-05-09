import assert from 'node:assert/strict'
import test from 'node:test'
import {
  assertAllowedBump,
  assertSharedPublicVersion,
  computeTargetVersion,
  rewriteInternalWorkspaceRanges,
} from '../release/version.mjs'

test('allows only patch and minor bumps on the v0 release line', () => {
  assert.equal(assertAllowedBump('patch'), 'patch')
  assert.equal(assertAllowedBump('minor'), 'minor')
  assert.throws(() => assertAllowedBump('major'), /Release bump must be patch or minor/)
  assert.throws(() => assertAllowedBump('0.2.0'), /Release bump must be patch or minor/)

  assert.equal(computeTargetVersion('0.1.0', 'patch'), '0.1.1')
  assert.equal(computeTargetVersion('0.1.0', 'minor'), '0.2.0')
  assert.throws(() => computeTargetVersion('1.0.0', 'patch'), /Release target left the 0\.x\.x line/)
})

test('rejects public package version drift', () => {
  const records = [
    { pkg: { name: '@vostride/agent-qa-core', version: '0.1.0' } },
    { pkg: { name: 'agent-qa', version: '0.1.0' } },
  ]
  assert.equal(assertSharedPublicVersion(records), '0.1.0')

  assert.throws(
    () => assertSharedPublicVersion([
      ...records,
      { pkg: { name: '@vostride/agent-qa-web', version: '0.2.0' } },
    ]),
    /public package versions must match/,
  )
})

test('rewrites only internal workspace ranges for staged manifests', () => {
  const manifest = {
    name: 'agent-qa',
    version: '0.1.0',
    dependencies: {
      '@vostride/agent-qa-core': 'workspace:*',
      '@vostride/agent-qa-ids': '^0.1.0',
      zod: '4.4.2',
    },
    devDependencies: {
      '@vostride/agent-qa-web': 'workspace:*',
      typescript: '~6.0.3',
    },
    peerDependencies: {
      '@vostride/agent-qa-mcp': 'workspace:*',
    },
    optionalDependencies: {
      '@vostride/agent-qa-ios': 'workspace:*',
    },
  }

  const rewritten = rewriteInternalWorkspaceRanges(manifest, '0.1.1')
  assert.notEqual(rewritten, manifest)
  assert.equal(rewritten.dependencies['@vostride/agent-qa-core'], '0.1.1')
  assert.equal(rewritten.dependencies['@vostride/agent-qa-ids'], '^0.1.0')
  assert.equal(rewritten.dependencies.zod, '4.4.2')
  assert.equal(rewritten.devDependencies['@vostride/agent-qa-web'], '0.1.1')
  assert.equal(rewritten.peerDependencies['@vostride/agent-qa-mcp'], '0.1.1')
  assert.equal(rewritten.optionalDependencies['@vostride/agent-qa-ios'], '0.1.1')
  assert.equal(manifest.dependencies['@vostride/agent-qa-core'], 'workspace:*')
})
