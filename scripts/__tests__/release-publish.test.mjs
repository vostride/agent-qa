import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import {
  assertTrustedPublishEnvironment,
  createPublishCommands,
  parseReleaseArgs as parsePublishArgs,
  publishPackages,
  runCli as runPublishCli,
} from '../release/publish.mjs'
import { publicPackageNames } from '../release/packages.mjs'

function stagedRecord(name, rootDir) {
  const dir = join(rootDir, name.replace('@vostride/', '').replaceAll('/', '-'))
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version: '0.1.1', private: false }, null, 2))
  return { name, dir, pkg: { name, version: '0.1.1', private: false } }
}

const trustedEnv = { GITHUB_ACTIONS: 'true', ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'token' }

function npmError(stderr) {
  return Object.assign(new Error(`Command failed: npm\n${stderr}`), { status: 1, stderr })
}

function fakeNpm(present) {
  const publishedDirs = []
  const execFileSync = (cmd, args) => {
    if (args[0] === 'view') {
      const spec = args[1]
      if (present.has(spec.slice(0, spec.lastIndexOf('@')))) return '"0.1.1"'
      throw npmError('npm error code E404\nnpm error 404 No match found for version 0.1.1')
    }
    throw new Error(`unexpected npm call: ${args.join(' ')}`)
  }
  const spawnSync = (cmd, args, options) => {
    publishedDirs.push(options.cwd)
    return { status: 0, signal: null, stdout: null, stderr: '' }
  }
  return { execFileSync, spawnSync, publishedDirs }
}

async function withStagedPackages(run) {
  const rootDir = await mkdtemp(join(tmpdir(), 'agent-qa-release-publish-resume-'))
  try {
    const stagedDir = join(rootDir, '.release/staged-packages')
    const records = publicPackageNames.map(name => stagedRecord(name, stagedDir))
    await run({ rootDir, stagedDir, records })
  } finally {
    await rm(rootDir, { recursive: true, force: true })
  }
}

test('a partial publish resumes from the first package npm does not have, in publish order', async () => {
  await withStagedPackages(async ({ rootDir, stagedDir, records }) => {
    const present = new Set(publicPackageNames.slice(0, 3))
    const npm = fakeNpm(present)
    const lines = []
    const result = await publishPackages({
      rootDir,
      stagedDir,
      env: trustedEnv,
      npmVersion: '11.6.1',
      execFileSync: npm.execFileSync,
      spawnSync: npm.spawnSync,
      log: line => lines.push(line),
    })

    assert.deepEqual(npm.publishedDirs, records.slice(3).map(record => record.dir))
    assert.deepEqual(result.skipped, publicPackageNames.slice(0, 3))
    assert.deepEqual(result.published, publicPackageNames.slice(3))
    for (const name of present) assert.ok(lines.includes(`already on npm: ${name}@0.1.1`))
  })
})

test('a version npm already has in full publishes nothing and succeeds', async () => {
  await withStagedPackages(async ({ rootDir, stagedDir }) => {
    const npm = fakeNpm(new Set(publicPackageNames))
    const result = await publishPackages({
      rootDir,
      stagedDir,
      env: trustedEnv,
      npmVersion: '11.6.1',
      execFileSync: npm.execFileSync,
      spawnSync: npm.spawnSync,
      log: () => {},
    })

    assert.deepEqual(npm.publishedDirs, [])
    assert.deepEqual(result.skipped, publicPackageNames)
    assert.deepEqual(result.published, [])
  })
})

test('a version npm does not have yet publishes every package in publish order', async () => {
  await withStagedPackages(async ({ rootDir, stagedDir, records }) => {
    const npm = fakeNpm(new Set())
    const result = await publishPackages({
      rootDir,
      stagedDir,
      env: trustedEnv,
      npmVersion: '11.6.1',
      execFileSync: npm.execFileSync,
      spawnSync: npm.spawnSync,
      log: () => {},
    })

    assert.deepEqual(npm.publishedDirs, records.map(record => record.dir))
    assert.deepEqual(result.published, publicPackageNames)
    assert.deepEqual(result.skipped, [])
  })
})

test('creates trusted-publishing npm publish commands for every staged package', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'agent-qa-release-publish-cmds-'))
  try {
    const stagedRecords = publicPackageNames.map(name => stagedRecord(name, rootDir))
    const commands = createPublishCommands({ stagedRecords, version: '0.1.1' })

    assert.equal(commands.length, publicPackageNames.length)
    assert.deepEqual(commands.map(command => command.cwd), stagedRecords.map(record => record.dir))
    for (const command of commands) {
      assert.equal(command.command, 'npm')
      assert.deepEqual(command.args, ['publish', '--access', 'public'])
      const text = JSON.stringify(command)
      assert.equal(text.includes('NPM_TOKEN'), false)
      assert.equal(text.includes('--tag latest'), false)
      assert.equal(/docker/i.test(text), false)
    }
  } finally {
    await rm(rootDir, { recursive: true, force: true })
  }
})

test('requires GitHub OIDC trusted-publishing environment and rejects token paths', () => {
  assert.doesNotThrow(() => assertTrustedPublishEnvironment({
    env: { GITHUB_ACTIONS: 'true', ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'token' },
    npmVersion: '11.5.1',
  }))
  assert.throws(() => assertTrustedPublishEnvironment({ env: { GITHUB_ACTIONS: 'true' }, npmVersion: '11.5.1' }), /ACTIONS_ID_TOKEN_REQUEST_TOKEN/)
  assert.throws(() => assertTrustedPublishEnvironment({ env: { GITHUB_ACTIONS: 'true', ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'token' }, npmVersion: '11.4.0' }), /npm CLI >=11\.5\.1/)
  assert.throws(() => assertTrustedPublishEnvironment({ env: { GITHUB_ACTIONS: 'true', ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'token' }, npmVersion: 'bad-version' }), /npm CLI >=11\.5\.1/)
  assert.throws(() => assertTrustedPublishEnvironment({ env: { ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'token' }, npmVersion: '11.5.1' }), /GitHub Actions/)
  assert.throws(() => assertTrustedPublishEnvironment({ env: { GITHUB_ACTIONS: 'true', ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'token', NPM_TOKEN: 'token' }, npmVersion: '11.5.1' }), /NPM_TOKEN/)
})

test('publishes from explicit .release/staged-packages and never source package directories', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'agent-qa-release-publish-'))
  try {
    const stagedDir = join(rootDir, '.release/staged-packages')
    for (const name of publicPackageNames) stagedRecord(name, stagedDir)
    const calls = []
    await publishPackages({
      rootDir,
      stagedDir,
      env: { GITHUB_ACTIONS: 'true', ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'token', NPM_CONFIG_PROVENANCE: 'false' },
      npmVersion: '11.6.1',
      execFileSync: (cmd, args) => {
        if (args[0] === 'view') throw npmError('npm error code E404')
        throw new Error(`unexpected npm call: ${args.join(' ')}`)
      },
      spawnSync: (cmd, args, options) => {
        calls.push([cmd, args, options.cwd, options.env])
        return { status: 0, signal: null, stdout: null, stderr: '' }
      },
      log: () => {},
    })

    assert.equal(calls.length, publicPackageNames.length)
    assert.ok(calls.every(([, , cwd]) => cwd.startsWith(stagedDir)))
    assert.ok(calls.every(([, , cwd]) => !cwd.includes('/packages/')))
    assert.ok(calls.every(([, , , env]) => !('NPM_CONFIG_PROVENANCE' in env)))
  } finally {
    await rm(rootDir, { recursive: true, force: true })
  }
})

test('parses and dispatches node scripts/release/publish.mjs --staged-dir .release/staged-packages', async () => {
  assert.deepEqual(parsePublishArgs(['--staged-dir', '.release/staged-packages']), { stagedDir: '.release/staged-packages' })
  assert.throws(() => parsePublishArgs([]), /missing --staged-dir/)
  assert.throws(() => parsePublishArgs(['--staged-dir', '.release/staged-packages', '--bad']), /invalid args/)

  const rootDir = await mkdtemp(join(tmpdir(), 'agent-qa-release-publish-cli-'))
  try {
    const stagedDir = join(rootDir, '.release/staged-packages')
    for (const name of publicPackageNames) stagedRecord(name, stagedDir)
    const calls = []
    const lines = []
    await runPublishCli(['--staged-dir', '.release/staged-packages'], {
      rootDir,
      env: { GITHUB_ACTIONS: 'true', ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'token' },
      npmVersion: '11.6.1',
      execFileSync: (cmd, args) => {
        if (args[0] === 'view') throw npmError('npm error code E404')
        throw new Error(`unexpected npm call: ${args.join(' ')}`)
      },
      spawnSync: (cmd, args, options) => {
        calls.push([cmd, args, options.cwd])
        return { status: 0, signal: null, stdout: null, stderr: '' }
      },
      log: line => lines.push(line),
    })
    assert.equal(calls.length, publicPackageNames.length)
    assert.ok(calls.every(([, args]) => args[0] === 'publish'))
    assert.deepEqual(lines, [`published: ${publicPackageNames.join(', ')}`, 'skipped: none'])

    await assert.rejects(
      runPublishCli(['--staged-dir', '.release/staged-packages'], {
        rootDir,
        env: { GITHUB_ACTIONS: 'true', ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'token', NPM_TOKEN: 'token' },
        npmVersion: '11.6.1',
        execFileSync: () => {},
        spawnSync: () => {
          throw new Error('npm publish must not run')
        },
      }),
      /NPM_TOKEN/,
    )
  } finally {
    await rm(rootDir, { recursive: true, force: true })
  }
})

function scriptedNpm({ present = new Set(), viewErrors = new Map(), publishErrors = new Map() }) {
  const publishedDirs = []
  const stderr = []
  const execFileSync = (cmd, args) => {
    if (args[0] !== 'view') throw new Error(`unexpected npm call: ${args.join(' ')}`)
    const name = args[1].slice(0, args[1].lastIndexOf('@'))
    if (viewErrors.has(name)) throw npmError(viewErrors.get(name))
    if (present.has(name)) return '"0.1.1"'
    throw npmError('npm error code E404')
  }
  const spawnSync = (cmd, args, options) => {
    const name = JSON.parse(readFileSync(join(options.cwd, 'package.json'), 'utf8')).name
    const failure = publishErrors.get(name)
    if (failure) {
      if (failure.landed) present.add(name)
      const signal = failure.signal ?? null
      return { status: signal ? null : 1, signal, stdout: null, stderr: failure.stderr ?? '' }
    }
    publishedDirs.push(options.cwd)
    return { status: 0, signal: null, stdout: null, stderr: '' }
  }
  return {
    execFileSync,
    spawnSync,
    publishedDirs,
    stderr: { write: chunk => stderr.push(String(chunk)) },
    written: stderr,
  }
}

const publishOverExisting =
  'npm error code E403\nnpm error 403 403 Forbidden - PUT https://registry.npmjs.org/@vostride%2fagent-qa-runner - You cannot publish over the previously published versions: 0.1.1.'

test('an E403 over a version npm then reports present counts as already published and the publish continues', async () => {
  await withStagedPackages(async ({ rootDir, stagedDir, records }) => {
    const name = publicPackageNames[3]
    const npm = scriptedNpm({ publishErrors: new Map([[name, { stderr: publishOverExisting, landed: true }]]) })
    const lines = []
    const result = await publishPackages({
      rootDir,
      stagedDir,
      env: trustedEnv,
      npmVersion: '11.6.1',
      execFileSync: npm.execFileSync,
      spawnSync: npm.spawnSync,
      stderr: npm.stderr,
      log: line => lines.push(line),
    })

    assert.deepEqual(result.skipped, [name])
    assert.deepEqual(result.published, publicPackageNames.filter(other => other !== name))
    assert.deepEqual(npm.publishedDirs, records.filter((_, index) => index !== 3).map(record => record.dir))
    assert.ok(lines.includes(`already on npm: ${name}@0.1.1`))
    assert.match(npm.written.join(''), /E403/)
  })
})

test('an E403 over a version npm still does not report stops the publish before any later package', async () => {
  await withStagedPackages(async ({ rootDir, stagedDir, records }) => {
    const name = publicPackageNames[3]
    const npm = scriptedNpm({ publishErrors: new Map([[name, { stderr: publishOverExisting, landed: false }]]) })
    await assert.rejects(
      publishPackages({
        rootDir,
        stagedDir,
        env: trustedEnv,
        npmVersion: '11.6.1',
        execFileSync: npm.execFileSync,
        spawnSync: npm.spawnSync,
        stderr: npm.stderr,
        log: () => {},
      }),
      new RegExp(`npm publish failed for ${name}@0\\.1\\.1: exit 1`),
    )
    assert.deepEqual(npm.publishedDirs, records.slice(0, 3).map(record => record.dir))
    assert.match(npm.written.join(''), /cannot publish over the previously published versions/)
  })
})

test('an E404 from npm publish stops the publish before any later package', async () => {
  await withStagedPackages(async ({ rootDir, stagedDir, records }) => {
    const name = publicPackageNames[1]
    const notFound = `npm error code E404\nnpm error 404 Not Found - PUT https://registry.npmjs.org/${name} - Not found`
    const npm = scriptedNpm({ publishErrors: new Map([[name, { stderr: notFound, landed: true }]]) })
    await assert.rejects(
      publishPackages({
        rootDir,
        stagedDir,
        env: trustedEnv,
        npmVersion: '11.6.1',
        execFileSync: npm.execFileSync,
        spawnSync: npm.spawnSync,
        stderr: npm.stderr,
        log: () => {},
      }),
      new RegExp(`npm publish failed for ${name}@0\\.1\\.1: exit 1`),
    )
    assert.deepEqual(npm.publishedDirs, records.slice(0, 1).map(record => record.dir))
    assert.match(npm.written.join(''), /E404/)
  })
})

test('an npm view that fails for another reason stops the publish before that package', async () => {
  await withStagedPackages(async ({ rootDir, stagedDir, records }) => {
    const name = publicPackageNames[2]
    const npm = scriptedNpm({ viewErrors: new Map([[name, 'npm error code ECONNRESET']]) })
    await assert.rejects(
      publishPackages({
        rootDir,
        stagedDir,
        env: trustedEnv,
        npmVersion: '11.6.1',
        execFileSync: npm.execFileSync,
        spawnSync: npm.spawnSync,
        stderr: npm.stderr,
        log: () => {},
      }),
      new RegExp(`could not verify npm version for ${name}@0\\.1\\.1`),
    )
    assert.deepEqual(npm.publishedDirs, records.slice(0, 2).map(record => record.dir))
  })
})

const publishNotices = [
  'npm notice Publishing to https://registry.npmjs.org/ with tag latest and public access',
  'npm notice publish Signed provenance statement with source and build information from GitHub Actions',
  'npm notice publish Provenance statement published to transparency log: https://search.sigstore.dev/?logIndex=1',
].join('\n')

test("a successful publish writes npm's notices to the release log", async () => {
  await withStagedPackages(async ({ rootDir, stagedDir }) => {
    const written = []
    const result = await publishPackages({
      rootDir,
      stagedDir,
      env: trustedEnv,
      npmVersion: '11.6.1',
      execFileSync: (cmd, args) => {
        if (args[0] === 'view') throw npmError('npm error code E404')
        throw new Error(`unexpected npm call: ${args.join(' ')}`)
      },
      spawnSync: () => ({ status: 0, signal: null, stdout: null, stderr: `${publishNotices}\n` }),
      stderr: { write: chunk => written.push(String(chunk)) },
      log: () => {},
    })

    assert.deepEqual(result.published, publicPackageNames)
    assert.deepEqual(written, publicPackageNames.map(() => `${publishNotices}\n`))
  })
})

test('a publish killed by a signal stops the publish before any later package', async () => {
  await withStagedPackages(async ({ rootDir, stagedDir, records }) => {
    const name = publicPackageNames[2]
    const npm = scriptedNpm({ publishErrors: new Map([[name, { signal: 'SIGKILL', landed: true }]]) })
    await assert.rejects(
      publishPackages({
        rootDir,
        stagedDir,
        env: trustedEnv,
        npmVersion: '11.6.1',
        execFileSync: npm.execFileSync,
        spawnSync: npm.spawnSync,
        stderr: npm.stderr,
        log: () => {},
      }),
      new RegExp(`npm publish failed for ${name}@0\\.1\\.1: killed by SIGKILL`),
    )
    assert.deepEqual(npm.publishedDirs, records.slice(0, 2).map(record => record.dir))
  })
})
