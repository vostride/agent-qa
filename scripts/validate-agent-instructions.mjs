import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const ignoredDirs = new Set(['.git', '.turbo', '.pnpm-store', '.release', 'dist', 'node_modules'])
const requiredRootSnippets = ['agent-qa', 'AGENT_QA_*', 'agent_qa_*', '@vostride/agent-qa-*']
const forbiddenBranding = ['AgentQA', 'AGENTQA', 'agentqa', 'agentqa_']
const forbiddenStart = '<!-- branding-forbidden:start -->'
const forbiddenEnd = '<!-- branding-forbidden:end -->'

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function assert(condition, message, errors) {
  if (!condition) errors.push(message)
}

function walkFiles(dir, visitor) {
  if (!existsSync(dir)) return
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirs.has(entry.name)) continue

    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      walkFiles(path, visitor)
    } else if (entry.isFile()) {
      visitor(path, entry.name)
    }
  }
}

function packageRecords(rootDir) {
  const packagesRoot = join(rootDir, 'packages')
  if (!existsSync(packagesRoot)) return []

  return readdirSync(packagesRoot)
    .map(name => join(packagesRoot, name))
    .filter(dir => statSync(dir).isDirectory() && existsSync(join(dir, 'package.json')))
    .sort()
    .map(dir => ({ dir, pkg: readJson(join(dir, 'package.json')) }))
}

function stripAllowedForbiddenBlock(rootDir, file, body, errors) {
  const rootAgentsPath = join(rootDir, 'AGENTS.md')
  if (file !== rootAgentsPath) return body

  const start = body.indexOf(forbiddenStart)
  const end = body.indexOf(forbiddenEnd)
  if (start === -1 || end === -1 || end < start) {
    errors.push('root AGENTS.md is missing a valid branding forbidden examples block')
    return body
  }

  return `${body.slice(0, start)}${body.slice(end + forbiddenEnd.length)}`
}

function validateAgentFileNames(rootDir, errors) {
  walkFiles(rootDir, (file, name) => {
    if (name.toLowerCase() === 'agents.md' && name !== 'AGENTS.md') {
      errors.push(`${relative(rootDir, file)} uses lowercase agents.md; use AGENTS.md`)
    }
  })
}

function forbiddenBrandingErrors(label, body) {
  return forbiddenBranding
    .filter(forbidden => body.includes(forbidden))
    .map(forbidden => `${label} contains forbidden branding: ${forbidden}`)
}

// 431 D-17: instructions init generates are not files in this repository, so they are linted as
// the exact bytes their source template produces.
export function validateGeneratedInstructions(documents) {
  return documents.flatMap(document => forbiddenBrandingErrors(document.label, document.body))
}

export async function loadGeneratedInstructions(rootDir = root) {
  const commands = join(rootDir, 'packages/cli/src/commands')
  const guide = await import(pathToFileURL(join(commands, 'knowledge-guide.ts')).href)
  const block = await import(pathToFileURL(join(commands, 'managed-block.ts')).href)
  return [
    { label: 'generated agent-qa-knowledge/AGENTS.md', body: guide.buildKnowledgeAgentGuide() },
    {
      label: 'generated root AGENTS.md pointer',
      body: block.renderManagedBlock({
        descriptor: block.AGENT_QA_INIT_MARKDOWN_BLOCK,
        body: guide.buildAgentInstructionPointer(),
        target: 'AGENTS.md',
      }),
    },
  ]
}

function validateBrandingInAgentFiles(rootDir, errors) {
  const agentFiles = []
  walkFiles(rootDir, (file, name) => {
    if (name === 'AGENTS.md') agentFiles.push(file)
  })

  for (const file of agentFiles.sort()) {
    const body = readFileSync(file, 'utf8')
    const scanned = stripAllowedForbiddenBlock(rootDir, file, body, errors)
    errors.push(...forbiddenBrandingErrors(relative(rootDir, file), scanned))
  }
}

export function validateAgentInstructions(rootDir = root, options = {}) {
  // 2026-08-17 (Phase 398 plan 03): 22 -> 23 for `packages/analytics`. The count is pinned rather
  // than derived on purpose — a package arriving without an AGENTS.md is meant to red here — so a
  // new workspace member is a deliberate bump plus its own instructions file, never a silent one.
  const expectedPackageCount = options.expectedPackageCount ?? 23
  const errors = []
  const rootAgentsPath = join(rootDir, 'AGENTS.md')

  assert(existsSync(rootAgentsPath), 'root AGENTS.md is missing', errors)

  const records = packageRecords(rootDir)
  assert(
    records.length === expectedPackageCount,
    `expected ${expectedPackageCount} package AGENTS.md files, found ${records.length} package root(s)`,
    errors,
  )

  if (existsSync(rootAgentsPath)) {
    const rootAgents = readFileSync(rootAgentsPath, 'utf8')
    for (const snippet of requiredRootSnippets) {
      assert(rootAgents.includes(snippet), `root AGENTS.md must contain ${snippet}`, errors)
    }
  }

  for (const record of records) {
    const agentsPath = join(record.dir, 'AGENTS.md')
    const packageName = record.pkg.name ?? relative(rootDir, record.dir)

    assert(existsSync(agentsPath), `${packageName} AGENTS.md is missing`, errors)
    if (!existsSync(agentsPath)) continue

    const body = readFileSync(agentsPath, 'utf8')
    assert(body.includes(packageName), `${packageName} AGENTS.md must contain exact package name`, errors)
    assert(body.includes('pnpm --filter'), `${packageName} AGENTS.md must contain pnpm --filter`, errors)
  }

  validateAgentFileNames(rootDir, errors)
  validateBrandingInAgentFiles(rootDir, errors)
  errors.push(...validateGeneratedInstructions(options.generatedInstructions ?? []))

  return errors
}

async function main() {
  const errors = validateAgentInstructions(root, {
    generatedInstructions: await loadGeneratedInstructions(root),
  })
  if (errors.length === 0) {
    console.log('agent-qa AGENTS.md validation passed')
    return
  }

  console.error('agent-qa AGENTS.md validation failed:')
  for (const error of errors) console.error(`- ${error}`)
  process.exitCode = 1
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}
