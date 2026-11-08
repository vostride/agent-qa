import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { cp, mkdir, rm, writeFile } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { getPublicPackages, publicPackageNames } from './packages.mjs'
import { rewriteInternalWorkspaceRanges } from './version.mjs'

const dependencyBlocks = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']
const entryPackageName = 'agent-qa'
const sourceOnlyScripts = ['prepack', 'prepare', 'prepublishOnly', 'postpack', 'copy:skills']
const repositorySlug = 'vostride/agent-qa'
const absoluteOrAnchorUrl = /^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i

function rejectGeneratedOrLocalFiles(path) {
  const normalized = path.split('\\').join('/')
  return ![
    '/node_modules/',
    '/.turbo/',
    '/.git/',
    '/.agent-qa/',
  ].some(segment => normalized.includes(segment))
    && !normalized.endsWith('/pnpm-lock.yaml')
    && !normalized.endsWith('/package-lock.json')
    && !normalized.endsWith('/npm-debug.log')
    && !normalized.endsWith('/yarn-error.log')
    && !normalized.endsWith('/.DS_Store')
}

function stagedPackageDir(outputDir, record) {
  return join(outputDir, record.packageDirName ?? record.dir.split(/[\\/]/).at(-1))
}

const skippedSkillFolders = new Set(['node_modules', '.turbo', '.git', 'dist'])
const skippedSkillFiles = new Set(['pnpm-lock.yaml', 'package-lock.json', '.DS_Store'])

// Judged inside the skill folder, so the checkout's own location never decides what is staged.
function keepsSkillFile(sourceDir) {
  return path => {
    const segments = relative(sourceDir, path).split(sep).filter(Boolean)
    return !segments.some(segment => skippedSkillFolders.has(segment))
      && !skippedSkillFiles.has(segments.at(-1) ?? '')
  }
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function stripSourceOnlyScripts(pkg) {
  const next = { ...pkg }
  if (!next.scripts || typeof next.scripts !== 'object') return next
  next.scripts = { ...next.scripts }
  for (const scriptName of sourceOnlyScripts) delete next.scripts[scriptName]
  if (Object.keys(next.scripts).length === 0) delete next.scripts
  return next
}

function hasWorkspaceRange(pkg) {
  for (const blockName of dependencyBlocks) {
    const block = pkg[blockName]
    if (!block || typeof block !== 'object') continue
    for (const range of Object.values(block)) {
      if (range === 'workspace:*') return true
    }
  }
  return false
}

function validateExactInternalRanges(pkg, targetVersion) {
  for (const blockName of dependencyBlocks) {
    const block = pkg[blockName]
    if (!block || typeof block !== 'object') continue
    for (const [name, range] of Object.entries(block)) {
      if (name.startsWith('@vostride/agent-qa-') && range !== targetVersion) {
        throw new Error(`${pkg.name} ${blockName}.${name} must be exact ${targetVersion}`)
      }
    }
  }
}

function skillFolderNames(skillsRoot) {
  const names = existsSync(skillsRoot)
    ? readdirSync(skillsRoot, { withFileTypes: true })
        .filter(entry => entry.isDirectory() && entry.name !== 'scripts')
        .filter(entry => existsSync(join(skillsRoot, entry.name, 'SKILL.md')))
        .map(entry => entry.name)
        .sort()
    : []
  if (names.length === 0) throw new Error(`no skill folders with a SKILL.md under ${skillsRoot}`)
  return names
}

function quotedReferences(body) {
  const names = [...body.matchAll(/references\/[A-Za-z0-9._-]+/gu)].map(match => match[0].replace(/\.+$/u, ''))
  return [...new Set(names)]
}

async function stageCliSkills(sourcePackageDir, targetPackageDir) {
  const sourceRoot = join(sourcePackageDir, 'skills')
  const targetRoot = join(targetPackageDir, 'skills')
  const skillNames = skillFolderNames(sourceRoot)
  await rm(targetRoot, { recursive: true, force: true })
  await mkdir(targetRoot, { recursive: true })

  for (const skillName of skillNames) {
    const sourceDir = join(sourceRoot, skillName)
    const body = readFileSync(join(sourceDir, 'SKILL.md'), 'utf8')
    for (const file of ['SKILL.md', 'agents/openai.yaml', ...quotedReferences(body)]) {
      const filePath = join(sourceDir, file)
      if (!existsSync(filePath)) throw new Error(`missing CLI skill file for staged package: ${skillName}/${file}`)
      if (statSync(filePath).size === 0) throw new Error(`empty CLI skill file for staged package: ${skillName}/${file}`)
    }
    await cp(sourceDir, join(targetRoot, skillName), {
      recursive: true,
      filter: keepsSkillFile(sourceDir),
    })
  }
}

// npm resolves relative README links against the package directory, so any the README gains are
// pointed at main on GitHub, like the absolute ones it already carries.
export function absolutizeReadmeLinks(body) {
  const repoPath = path => path.replace(/^\.?\//, '')
  const raw = path => absoluteOrAnchorUrl.test(path) ? path : `https://raw.githubusercontent.com/${repositorySlug}/main/${repoPath(path)}`
  const blob = path => absoluteOrAnchorUrl.test(path) ? path : `https://github.com/${repositorySlug}/blob/main/${repoPath(path)}`
  return body
    .replace(/\b(src|srcset)="([^"]+)"/g, (_, attr, path) => `${attr}="${raw(path)}"`)
    .replace(/\bhref="([^"]+)"/g, (_, path) => `href="${blob(path)}"`)
    .replace(/(!?)\[([^\]]*)\]\(([^)\s]+)\)/g, (_, bang, text, path) => `${bang}[${text}](${bang ? raw(path) : blob(path)})`)
}

// A plugin documents its own options and settings, so its README ships in place of the root one.
function keepsOwnReadme(record) {
  return record.pkg['agent-qa']?.plugin !== undefined && existsSync(join(record.dir, 'README.md'))
}

function readRootReadme(rootDir) {
  const readmePath = join(rootDir ?? process.cwd(), 'README.md')
  if (!existsSync(readmePath)) throw new Error(`missing root README for staged packages: ${readmePath}`)
  return absolutizeReadmeLinks(readFileSync(readmePath, 'utf8'))
}

export async function stagePublishPackages(options = {}) {
  const rootDir = options.rootDir
  const targetVersion = options.targetVersion
  const outputDir = options.outputDir ?? join(rootDir ?? process.cwd(), '.release/staged-packages')
  if (!targetVersion) throw new Error('missing targetVersion')

  const readme = readRootReadme(rootDir)
  const records = getPublicPackages({ rootDir })
  await rm(outputDir, { recursive: true, force: true })
  await mkdir(outputDir, { recursive: true })

  const stagedRecords = []
  for (const record of records) {
    const targetDir = stagedPackageDir(outputDir, record)
    await cp(record.dir, targetDir, {
      recursive: true,
      filter: rejectGeneratedOrLocalFiles,
    })
    if (record.pkg.name === entryPackageName) {
      await stageCliSkills(record.dir, targetDir)
    }
    if (!keepsOwnReadme(record)) await writeFile(join(targetDir, 'README.md'), readme, 'utf8')
    const stagedManifestPath = join(targetDir, 'package.json')
    const stagedManifest = stripSourceOnlyScripts(rewriteInternalWorkspaceRanges({ ...record.pkg, version: targetVersion }, targetVersion))
    stagedManifest.version = targetVersion
    await writeFile(stagedManifestPath, `${JSON.stringify(stagedManifest, null, 2)}\n`, 'utf8')
    stagedRecords.push({
      ...record,
      dir: targetDir,
      manifestPath: stagedManifestPath,
      pkg: stagedManifest,
      sourceDir: record.dir,
    })
  }

  validateStagedPackageManifests({ stagedRecords, targetVersion })
  return stagedRecords
}

export function validateStagedPackageManifests(options = {}) {
  const targetVersion = options.targetVersion
  const stagedRecords = options.stagedRecords ?? discoverStagedRecords(options.stagedDir)
  if (!targetVersion) throw new Error('missing targetVersion')

  for (const record of stagedRecords) {
    const pkg = record.pkg ?? readJson(record.manifestPath ?? join(record.dir, 'package.json'))
    if (pkg.version !== targetVersion) {
      throw new Error(`${pkg.name} staged package version must be ${targetVersion}`)
    }
    if (hasWorkspaceRange(pkg)) {
      throw new Error(`${pkg.name} staged package.json must not contain workspace:*`)
    }
    validateExactInternalRanges(pkg, targetVersion)
  }

  return stagedRecords
}

export function discoverStagedRecords(stagedDir) {
  if (!stagedDir || !existsSync(stagedDir)) {
    throw new Error(`staged package directory is missing: ${stagedDir}`)
  }

  const records = readdirSync(stagedDir)
    .map(name => join(stagedDir, name))
    .filter(dir => statSync(dir).isDirectory() && existsSync(join(dir, 'package.json')))
    .map(dir => {
      const manifestPath = join(dir, 'package.json')
      const pkg = readJson(manifestPath)
      return { name: pkg.name, dir, manifestPath, packageDirName: relative(stagedDir, dir), pkg }
    })

  const byName = new Map(records.map(record => [record.pkg.name, record]))
  return publicPackageNames.map(name => {
    const record = byName.get(name)
    if (!record) throw new Error(`staged package directory is missing: ${name}`)
    return record
  })
}

function parseArgs(argv) {
  let targetVersion
  let outputDir
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--target-version') {
      targetVersion = argv[index + 1]
      index += 1
    } else if (arg === '--out' || arg === '--output-dir') {
      outputDir = argv[index + 1]
      index += 1
    } else {
      throw new Error(`invalid args: ${argv.join(' ')}`)
    }
  }
  if (!targetVersion) throw new Error('missing --target-version')
  if (!outputDir) throw new Error('missing --out')
  return { targetVersion, outputDir }
}

export async function runCli(argv = process.argv.slice(2), options = {}) {
  const parsed = parseArgs(argv)
  const stagedRecords = await stagePublishPackages({
    rootDir: options.rootDir ?? process.cwd(),
    targetVersion: parsed.targetVersion,
    outputDir: parsed.outputDir,
  })
  ;(options.output ?? process.stdout).write?.(`staged ${stagedRecords.length} packages in ${parsed.outputDir}\n`)
  return stagedRecords
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], 'file:').href) {
  runCli().catch(error => {
    console.error(error.message)
    process.exitCode = 1
  })
}
