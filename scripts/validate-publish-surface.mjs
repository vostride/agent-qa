import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const packagesRoot = join(root, 'packages')
const entryPackageName = 'agent-qa'
const scopedPrefix = '@vostride/agent-qa'
const repositoryHostPath = 'github.com/vostride/agent-qa'
const requiredLicense = 'SEE LICENSE IN LICENSE.md'
const requiredCopyright = 'Copyright 2026 Pranshu Chittora'
const requiredNoticeSnippets = [
  'Pranshu Chittora',
  'Functional Source License, Version 1.1, ALv2 Future License',
  'FSL-1.1-ALv2',
  'Apache License, Version 2.0',
  'Third-party dependencies are distributed under their own license terms',
]
const requiredSkills = ['agent-qa-authoring', 'agent-qa-result-triage', 'agent-qa-debug-fix']
const requiredSkillReferences = {
  'agent-qa-authoring': ['references/agent-qa-contracts.json'],
  'agent-qa-result-triage': ['references/triage-categories.md'],
  'agent-qa-debug-fix': [],
}
const forbiddenPackPatterns = [
  /^\.env($|\.)/,
  /^\.npmrc$/,
  /^\.git($|\/)/,
  /^\.turbo($|\/)/,
  /^\.planning($|\/)/,
  /^node_modules($|\/)/,
  /(^|\/)agent-qa\.local\.yaml$/,
  /(^|\/)\.env($|\.|\/)/,
  /(^|\/)\.env\.secrets\.local$/,
]

const args = new Set(process.argv.slice(2))
const quick = args.has('--quick')
const fixtures = args.has('--fixtures')

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf-8'))
}

function packageRecords() {
  return readdirSync(packagesRoot)
    .map(name => join(packagesRoot, name))
    .filter(dir => statSync(dir).isDirectory() && existsSync(join(dir, 'package.json')))
    .sort()
    .map(dir => ({ dir, pkg: readJson(join(dir, 'package.json')) }))
}

function label(record) {
  return record.pkg.name ?? relative(root, record.dir)
}

function assert(condition, message, errors) {
  if (!condition) errors.push(message)
}

function validateRootPackage(errors, options = { checkFiles: true }) {
  const pkg = readJson(join(root, 'package.json'))
  assert(pkg.name === 'agent-qa-monorepo', 'root package must remain named agent-qa-monorepo', errors)
  assert(pkg.private === true, 'root package must remain private', errors)
  assert(pkg.name !== entryPackageName, 'root package must not claim the public agent-qa package name', errors)
  assert(!Object.hasOwn(pkg, 'author'), 'root package must not declare author metadata', errors)
  assert(pkg.license === requiredLicense, `root package license must be ${requiredLicense}`, errors)
  if (options.checkFiles) {
    validateLicenseFile(join(root, 'LICENSE.md'), 'root', errors)
    validateNoticeFile(join(root, 'NOTICE.md'), 'root', errors)
  }
}

function validateLicenseFile(path, name, errors) {
  assert(existsSync(path), `${name} LICENSE.md is missing`, errors)
  if (!existsSync(path)) return
  const body = readFileSync(path, 'utf-8')
  assert(body.includes(requiredCopyright), `${name} LICENSE.md must identify ${requiredCopyright}`, errors)
  assert(!body.includes('Copyright 2026 Vostride'), `${name} LICENSE.md must not retain Vostride copyright`, errors)
  assert(body.includes('FSL-1.1-ALv2'), `${name} LICENSE.md must identify FSL-1.1-ALv2`, errors)
}

function validateNoticeFile(path, name, errors) {
  assert(existsSync(path), `${name} NOTICE.md is missing`, errors)
  if (!existsSync(path)) return
  const body = readFileSync(path, 'utf-8')
  for (const snippet of requiredNoticeSnippets) {
    assert(body.includes(snippet), `${name} NOTICE.md must mention ${snippet}`, errors)
  }
  assert(!body.includes('Vostride'), `${name} NOTICE.md must not claim Vostride ownership`, errors)
}

function validateWorkspaceRanges(record, errors) {
  const dependencyBlocks = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']
  for (const blockName of dependencyBlocks) {
    const block = record.pkg[blockName]
    if (!block || typeof block !== 'object') continue
    for (const [name, version] of Object.entries(block)) {
      if (name.startsWith(scopedPrefix)) {
        assert(version === 'workspace:*', `${label(record)} ${blockName}.${name} must remain workspace:* in Phase 256`, errors)
      }
    }
  }
}

function hasPublicRepositoryMetadata(pkg) {
  return pkg.repository?.type === 'git'
    && typeof pkg.repository?.url === 'string'
    && pkg.repository.url.includes(repositoryHostPath)
    && typeof pkg.repository?.directory === 'string'
    && typeof pkg.homepage === 'string'
    && pkg.homepage.includes(repositoryHostPath)
    && typeof pkg.bugs?.url === 'string'
    && pkg.bugs.url.includes(`${repositoryHostPath}/issues`)
}

function validateFilesAllowlist(record, errors) {
  const files = record.pkg.files
  assert(Array.isArray(files) && files.length > 0, `${label(record)} must declare a non-empty files allowlist`, errors)
  if (!Array.isArray(files)) return

  assert(files.includes('LICENSE.md'), `${label(record)} files must include LICENSE.md`, errors)
  assert(files.includes('NOTICE.md'), `${label(record)} files must include NOTICE.md`, errors)
  assert(!files.includes('.') && !files.includes('*'), `${label(record)} files must not publish the package root broadly`, errors)
  for (const file of files) {
    assert(!String(file).startsWith('src'), `${label(record)} files must not include source directories`, errors)
    assert(!String(file).includes('node_modules'), `${label(record)} files must not include node_modules`, errors)
    assert(!String(file).includes('.turbo'), `${label(record)} files must not include .turbo`, errors)
  }
}

function validatePublicPackage(record, allVersions, errors, options = { checkFiles: true }) {
  const name = label(record)
  assert(record.pkg.private === false, `${name} must be public with private: false`, errors)
  assert(typeof record.pkg.version === 'string' && /^0\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(record.pkg.version), `${name} version must be valid v0 semver`, errors)
  allVersions.add(record.pkg.version)

  if (record.pkg.name === entryPackageName) {
    assert(record.pkg.bin?.['agent-qa'] === './dist/cli.js', 'agent-qa must keep bin.agent-qa pointing at ./dist/cli.js', errors)
    assert(record.pkg.files?.includes('skills'), 'agent-qa files must include skills', errors)
  } else {
    assert(typeof record.pkg.name === 'string' && record.pkg.name.startsWith(`${scopedPrefix}-`), `${name} must be scoped under @vostride/*`, errors)
  }

  assert(typeof record.pkg.description === 'string' && record.pkg.description.length > 0, `${name} must have a description`, errors)
  assert(Array.isArray(record.pkg.keywords) && record.pkg.keywords.length > 0, `${name} must have keywords`, errors)
  assert(!Object.hasOwn(record.pkg, 'author'), `${name} must not declare author metadata`, errors)
  assert(record.pkg.license === requiredLicense, `${name} license must be ${requiredLicense}`, errors)
  assert(record.pkg.engines?.node === '>=24', `${name} must require Node >=24`, errors)
  assert(record.pkg.publishConfig?.access === 'public', `${name} publishConfig.access must be public`, errors)
  assert(record.pkg.publishConfig?.registry === 'https://registry.npmjs.org/', `${name} publishConfig.registry must be npm`, errors)
  assert(hasPublicRepositoryMetadata(record.pkg), `${name} must have repository, homepage, and bugs metadata`, errors)
  validateFilesAllowlist(record, errors)
  validateWorkspaceRanges(record, errors)

  if (record.pkg.name !== entryPackageName && record.pkg.name !== '@vostride/agent-qa-dashboard-ui') {
    assert(record.pkg.exports?.['.']?.types === './dist/index.d.ts', `${name} must export dist types`, errors)
    assert(record.pkg.exports?.['.']?.import === './dist/index.js', `${name} must export dist ESM`, errors)
    assert(record.pkg.exports?.['.']?.require === './dist/index.cjs', `${name} must export dist CJS`, errors)
  }

  if (record.pkg.name === '@vostride/agent-qa-dashboard-ui') {
    assert(!record.pkg.exports, '@vostride/agent-qa-dashboard-ui must not add exports unless package.json is exported for dashboard resolution', errors)
  }

  if (options.checkFiles) {
    validateLicenseFile(join(record.dir, 'LICENSE.md'), name, errors)
    validateNoticeFile(join(record.dir, 'NOTICE.md'), name, errors)
  }
}

function validateManifestSurface(errors, options = { checkFiles: true }) {
  validateRootPackage(errors, options)

  const records = packageRecords()
  const entryPackages = records.filter(record => record.pkg.name === entryPackageName)
  assert(entryPackages.length === 1, 'exactly one public entry package named agent-qa is required', errors)

  const allVersions = new Set()
  for (const record of records) {
    validatePublicPackage(record, allVersions, errors, options)
  }
  assert(allVersions.size === 1, `public package versions must match, found: ${[...allVersions].join(', ')}`, errors)
}

function validateCopiedSkills(errors) {
  const skillsRoot = join(root, 'packages/cli/skills')
  for (const skillName of requiredSkills) {
    const skillDir = join(skillsRoot, skillName)
    assert(existsSync(join(skillDir, 'SKILL.md')), `agent-qa packaged skill missing ${skillName}/SKILL.md`, errors)
    assert(existsSync(join(skillDir, 'agents/openai.yaml')), `agent-qa packaged skill missing ${skillName}/agents/openai.yaml`, errors)
    for (const ref of requiredSkillReferences[skillName]) {
      assert(existsSync(join(skillDir, ref)), `agent-qa packaged skill missing ${skillName}/${ref}`, errors)
    }
  }
  assert(!existsSync(join(skillsRoot, 'scripts')), 'agent-qa packaged skills must not include skills/scripts', errors)
}

function collectTextFiles(dir) {
  if (!existsSync(dir)) return []
  const files = []
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry === '.turbo') continue
    const path = join(dir, entry)
    const stat = statSync(path)
    if (stat.isDirectory()) {
      files.push(...collectTextFiles(path))
    } else if (/\.(md|json|ts|tsx|js|mjs|yaml|yml)$/.test(entry)) {
      files.push(path)
    }
  }
  return files
}

function validateNoStaleMcpToolPrefix(errors) {
  const scanned = [
    ...requiredSkills.map(skillName => join(root, 'skills', skillName)),
    join(root, 'packages/cli/skills'),
    join(root, 'packages/mcp/src'),
    join(root, 'packages/mcp/references'),
  ]
  for (const target of scanned) {
    if (!existsSync(target)) {
      errors.push(`publish surface scan target missing: ${relative(root, target)}`)
      continue
    }
    const files = statSync(target).isDirectory() ? collectTextFiles(target) : [target]
    for (const file of files) {
      const body = readFileSync(file, 'utf-8')
      assert(!body.includes('agentqa_'), `${relative(root, file)} contains stale agentqa_ MCP tool prefix`, errors)
    }
  }
}

function runSourceSkillsValidation(errors) {
  try {
    execFileSync(process.execPath, [join(root, 'skills/scripts/validate-skills.mjs')], {
      cwd: root,
      stdio: 'pipe',
      encoding: 'utf-8',
    })
  } catch (err) {
    errors.push(`source skills validation failed: ${err.stderr || err.message}`)
  }
}

function runCopySkills(errors) {
  try {
    execFileSync(process.execPath, [join(root, 'packages/cli/scripts/copy-skills.mjs')], {
      cwd: root,
      stdio: 'pipe',
      encoding: 'utf-8',
    })
  } catch (err) {
    errors.push(`copy skills failed: ${err.stderr || err.message}`)
  }
}

function parsePackOutput(output, record, errors) {
  const start = output.indexOf('[')
  const end = output.lastIndexOf(']')
  if (start === -1 || end === -1 || end < start) {
    errors.push(`${label(record)} npm pack did not return JSON output`)
    return []
  }

  try {
    const parsed = JSON.parse(output.slice(start, end + 1))
    return parsed[0]?.files?.map(file => file.path) ?? []
  } catch (err) {
    errors.push(`${label(record)} npm pack JSON parse failed: ${err.message}`)
    return []
  }
}

function validatePackFiles(record, files, errors) {
  const name = label(record)
  const noticeExists = existsSync(join(root, 'NOTICE.md'))
  assert(files.includes('package.json'), `${name} tarball must include package.json`, errors)
  assert(files.includes('LICENSE.md'), `${name} tarball must include LICENSE.md`, errors)
  if (noticeExists) {
    assert(files.includes('NOTICE.md'), `${name} tarball must include NOTICE.md because root NOTICE.md exists`, errors)
  }
  assert(files.some(file => file.startsWith('dist/')), `${name} tarball must include dist output after build`, errors)

  if (record.pkg.name === entryPackageName) {
    for (const skillName of requiredSkills) {
      assert(files.some(file => file.startsWith(`skills/${skillName}/`)), `agent-qa tarball must include skills/${skillName}`, errors)
    }
  }

  if (record.pkg.name === '@vostride/agent-qa-dashboard-ui') {
    assert(files.some(file => file === 'dist/index.html' || file.startsWith('dist/assets/')), '@vostride/agent-qa-dashboard-ui tarball must include built dashboard assets', errors)
  }

  for (const file of files) {
    for (const pattern of forbiddenPackPatterns) {
      assert(!pattern.test(file), `${name} tarball includes forbidden path ${file}`, errors)
    }
  }
}

function validatePackDryRuns(errors) {
  runCopySkills(errors)
  const npmCache = mkdtempSync(join(tmpdir(), 'agent-qa-npm-pack-cache-'))
  const npmEnv = {
    ...process.env,
    npm_config_audit: 'false',
    npm_config_fund: 'false',
    npm_config_cache: npmCache,
    npm_config_logs_dir: join(npmCache, 'logs'),
  }
  delete npmEnv.npm_config_verify_deps_before_run

  try {
    for (const record of packageRecords()) {
      let output = ''
      try {
        output = execFileSync('npm', ['pack', '--dry-run', '--json'], {
          cwd: record.dir,
          encoding: 'utf-8',
          env: npmEnv,
        })
      } catch (err) {
        errors.push(`${label(record)} npm pack dry-run failed: ${err.stderr || err.message}`)
        continue
      }

      const files = parsePackOutput(output, record, errors)
      validatePackFiles(record, files, errors)
    }
  } finally {
    rmSync(npmCache, { recursive: true, force: true })
  }
}

function expectFixtureFailure(name, fn, expectedText) {
  const errors = []
  fn(errors)
  if (!errors.some(error => error.includes(expectedText))) {
    throw new Error(`${name} fixture did not fail with ${expectedText}. Errors: ${errors.join('; ') || 'none'}`)
  }
}

function runFixtures() {
  const records = packageRecords()
  const entry = records.find(record => record.pkg.name === entryPackageName)
  const scoped = records.find(record => record.pkg.name !== entryPackageName)
  if (!entry || !scoped) throw new Error('fixture setup could not find entry and scoped packages')

  expectFixtureFailure('missing metadata', (errors) => {
    const record = { ...entry, pkg: { ...entry.pkg, license: undefined } }
    validatePublicPackage(record, new Set(), errors, { checkFiles: false })
  }, 'license')

  expectFixtureFailure('private public package', (errors) => {
    const record = { ...scoped, pkg: { ...scoped.pkg, private: true } }
    validatePublicPackage(record, new Set(), errors, { checkFiles: false })
  }, 'private: false')

  expectFixtureFailure('package name drift', (errors) => {
    const record = { ...scoped, pkg: { ...scoped.pkg, name: 'agent-qa-core' } }
    validatePublicPackage(record, new Set(), errors, { checkFiles: false })
  }, '@vostride')

  expectFixtureFailure('version drift', (errors) => {
    const versions = new Set()
    validatePublicPackage(entry, versions, errors, { checkFiles: false })
    validatePublicPackage({ ...scoped, pkg: { ...scoped.pkg, version: '0.2.0' } }, versions, errors, { checkFiles: false })
    assert(versions.size === 1, `public package versions must match, found: ${[...versions].join(', ')}`, errors)
  }, 'versions must match')

  expectFixtureFailure('major version drift', (errors) => {
    validatePublicPackage({ ...entry, pkg: { ...entry.pkg, version: '1.0.0' } }, new Set(), errors, { checkFiles: false })
  }, 'v0 semver')

  expectFixtureFailure('missing copied skills', (errors) => {
    const temp = mkdtempSync(join(tmpdir(), 'agent-qa-publish-fixture-'))
    try {
      const originalRoot = join(root, 'packages/cli/skills')
      const missingRoot = join(temp, 'skills')
      for (const skillName of requiredSkills) {
        assert(existsSync(join(missingRoot, skillName, 'SKILL.md')), `agent-qa packaged skill missing ${skillName}/SKILL.md`, errors)
      }
      assert(existsSync(originalRoot), 'fixture sanity check failed: real skills root missing', errors)
    } finally {
      rmSync(temp, { recursive: true, force: true })
    }
  }, 'packaged skill missing')

  console.log('publish surface validation fixtures passed')
}

function runValidation() {
  const errors = []
  validateManifestSurface(errors)
  validateCopiedSkills(errors)
  validateNoStaleMcpToolPrefix(errors)
  runSourceSkillsValidation(errors)

  if (!quick) {
    validatePackDryRuns(errors)
  }

  if (errors.length > 0) {
    console.error('publish surface validation failed:')
    for (const error of errors) {
      console.error(`- ${error}`)
    }
    process.exitCode = 1
    return
  }

  console.log(`publish surface validation passed (${quick ? 'quick' : 'full'})`)
}

if (fixtures) {
  runFixtures()
} else {
  runValidation()
}
