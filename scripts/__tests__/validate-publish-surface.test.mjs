import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  builtPackageSourceMapErrors,
  copiedSkillErrors,
  danglingSourceMapUrls,
  pluginPackageErrors,
  sourceSkillNames,
} from '../validate-publish-surface.mjs'

const scriptsDir = join(dirname(fileURLToPath(import.meta.url)), '..')
const script = join(scriptsDir, 'validate-publish-surface.mjs')

function withDist(files, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'agent-qa-dist-'))
  try {
    for (const [name, body] of Object.entries(files)) {
      mkdirSync(join(dir, name, '..'), { recursive: true })
      writeFileSync(join(dir, name), body)
    }
    return fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('a declaration that names a source map the build did not emit is reported', () => {
  withDist(
    {
      'index.d.ts': 'export declare const a: 1;\n//# sourceMappingURL=index.d.ts.map',
      'index.d.cts': 'export declare const a: 1;\n//# sourceMappingURL=index.d.cts.map\n',
      'server/index.d.ts': 'export {};\n//# sourceMappingURL=index.d.ts.map',
    },
    (dir) => {
      assert.deepEqual(
        danglingSourceMapUrls(dir).sort((a, b) => a.file.localeCompare(b.file)),
        [
          { file: 'index.d.cts', url: 'index.d.cts.map' },
          { file: 'index.d.ts', url: 'index.d.ts.map' },
          { file: join('server', 'index.d.ts'), url: 'index.d.ts.map' },
        ],
      )
    },
  )
})

test('source map URLs pass when the map sits beside the file, is inline or is absent', () => {
  withDist(
    {
      'index.js': 'export const a = 1;\n\n//# sourceMappingURL=index.js.map',
      'index.js.map': '{}',
      'index.cjs': 'exports.a = 1;\n//# sourceMappingURL=data:application/json;base64,e30=',
      'index.d.ts': 'export declare const a: 1;\n',
      'style.css': 'a{}\n/*# sourceMappingURL=style.css.map */',
      'style.css.map': '{}',
    },
    (dir) => assert.deepEqual(danglingSourceMapUrls(dir), []),
  )
})

test('a dangling source map URL fails the publish surface with the package and file named', () => {
  withDist({ 'dist/index.d.ts': 'export {};\n//# sourceMappingURL=index.d.ts.map' }, (dir) => {
    assert.deepEqual(builtPackageSourceMapErrors([{ dir, pkg: { name: '@vostride/agent-qa-fixture' } }]), [
      '@vostride/agent-qa-fixture dist/index.d.ts points at source map index.d.ts.map, which is not emitted',
    ])
  })
})

test('a package with no dist fails the publish surface with a build instruction', () => {
  withDist({ 'package.json': '{}' }, (dir) => {
    assert.deepEqual(builtPackageSourceMapErrors([{ dir, pkg: { name: '@vostride/agent-qa-fixture' } }]), [
      '@vostride/agent-qa-fixture has no dist to check source map URLs in; run `pnpm build` first',
    ])
  })
})

test('every public package has a dist and ships only source map URLs whose maps it ships', () => {
  assert.deepEqual(builtPackageSourceMapErrors(), [])
})

test('the validator runs its checks when invoked through a symlinked directory', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-qa-symlinked-scripts-'))
  try {
    const linked = join(dir, 'scripts')
    symlinkSync(scriptsDir, linked, 'dir')
    const result = spawnSync(
      process.execPath,
      [join(linked, 'validate-publish-surface.mjs'), '--fixtures'],
      { encoding: 'utf8' },
    )
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /publish surface validation fixtures passed/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('importing the validator without a script path neither throws nor runs the checks', () => {
  const result = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', `await import(${JSON.stringify(pathToFileURL(script).href)})`],
    { encoding: 'utf8' },
  )
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout, '')
})

function pluginRecord(overrides = {}) {
  const pkg = {
    name: '@vostride/agent-qa-plugin-acme',
    version: '0.2.6',
    private: false,
    license: 'FSL-1.1-ALv2',
    keywords: ['agent-qa', 'agent-qa-plugin'],
    repository: {
      type: 'git',
      url: 'git+https://github.com/vostride/agent-qa.git',
      directory: 'plugins/acme',
    },
    type: 'module',
    exports: { './package.json': './package.json' },
    files: ['dist', 'skill', 'LICENSE.md', 'NOTICE.md'],
    dependencies: { '@vostride/agent-qa-plugin-kit': 'workspace:*', 'acme-sdk': '1.2.3' },
    'agent-qa': {
      plugin: {
        kind: 'remote',
        runs: 'process',
        protocol: 1,
        entry: './dist/main.js',
        serves: ['web'],
        methods: [],
        options: './dist/options.schema.json',
        settings: './dist/settings.schema.json',
        skill: './skill',
      },
    },
    ...overrides,
  }
  return { dir: join(tmpdir(), 'plugins', 'acme'), pkg }
}

function withoutKey(object, key) {
  const { [key]: _removed, ...rest } = object
  return rest
}

test('a plugin package that exports only its manifest and ships dist and skill passes', () => {
  assert.deepEqual(pluginPackageErrors(pluginRecord()), [])
})

test('a plugin package is refused for each publish rule it breaks', () => {
  const name = '@vostride/agent-qa-plugin-acme'
  const base = pluginRecord().pkg
  const cases = [
    [{ main: './dist/main.js' }, `${name} must not declare main`],
    [
      { exports: { './package.json': './package.json', '.': './dist/main.js' } },
      `${name} must export only ./package.json`,
    ],
    [{ files: ['dist', 'LICENSE.md', 'NOTICE.md'] }, `${name} files must include skill`],
    [{ keywords: ['agent-qa'] }, `${name} keywords must include agent-qa-plugin`],
    [{ scripts: { postinstall: 'node setup.js' } }, `${name} must not declare a postinstall script`],
    [{ peerDependencies: { 'acme-sdk': '^1' } }, `${name} must not declare peerDependencies`],
    [
      { 'agent-qa': { plugin: { kind: 'model-auth', runs: 'in-process', entry: './dist/main.js' } } },
      `${name} agent-qa.plugin must be a remote plugin manifest`,
    ],
    [
      { 'agent-qa': { plugin: { ...base['agent-qa'].plugin, entry: './main.js' } } },
      `${name} agent-qa.plugin entry must sit under ./dist/`,
    ],
    [{ private: true }, `${name} must be public with private: false`],
    [
      { dependencies: { ...base.dependencies, '@vostride/agent-qa-core': 'workspace:*' } },
      `${name} dependencies.@vostride/agent-qa-core is an agent-qa package other than the plugin kit`,
    ],
    [
      { repository: { ...base.repository, directory: 'packages/acme' } },
      `${name} repository.directory must be plugins/acme`,
    ],
  ]
  for (const [overrides, expected] of cases) {
    assert.deepEqual(pluginPackageErrors(pluginRecord(overrides)), [expected], expected)
  }
})

test('a plugin package without exports or a manifest is refused', () => {
  const name = '@vostride/agent-qa-plugin-acme'
  const record = pluginRecord()
  record.pkg = withoutKey(withoutKey(record.pkg, 'exports'), 'agent-qa')
  assert.deepEqual(pluginPackageErrors(record), [
    `${name} must export only ./package.json`,
    `${name} agent-qa.plugin must be a remote plugin manifest`,
  ])
})

function writeSkill(skillsRoot, name, files) {
  for (const [file, body] of Object.entries(files)) {
    mkdirSync(join(skillsRoot, name, file, '..'), { recursive: true })
    writeFileSync(join(skillsRoot, name, file), body)
  }
}

test('the packaged skill check names a source skill folder whose packaged copy is missing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-qa-copied-skills-'))
  try {
    const source = join(dir, 'source')
    const packaged = join(dir, 'packaged')
    const files = {
      'SKILL.md': '---\nname: agent-qa-zzz\ndescription: x\n---\nRead references/notes.md.\n',
      'agents/openai.yaml': 'interface: {}\n',
      'references/notes.md': 'notes\n',
    }
    writeSkill(source, 'agent-qa-zzz', files)
    mkdirSync(join(source, 'scripts'), { recursive: true })
    mkdirSync(packaged, { recursive: true })

    assert.deepEqual(sourceSkillNames(source), ['agent-qa-zzz'])
    assert.deepEqual(copiedSkillErrors(source, packaged), [
      'agent-qa packaged skill missing agent-qa-zzz/SKILL.md',
      'agent-qa packaged skill missing agent-qa-zzz/agents/openai.yaml',
      'agent-qa packaged skill missing agent-qa-zzz/references/notes.md',
    ])

    writeSkill(packaged, 'agent-qa-zzz', files)
    assert.deepEqual(copiedSkillErrors(source, packaged), [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a skills folder holding no folder with a SKILL.md is refused', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-qa-copied-skills-'))
  try {
    mkdirSync(join(dir, 'scripts'), { recursive: true })
    assert.throws(() => sourceSkillNames(dir), /no skill folders with a SKILL\.md under/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
