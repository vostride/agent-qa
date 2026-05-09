import { cp, mkdir, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const sourceRoot = join(here, '../../..', 'skills')
const targetRoot = join(here, '..', 'skills')
const skillNames = ['agent-qa-authoring', 'agent-qa-result-triage', 'agent-qa-debug-fix']

function rejectGeneratedOrLocalFiles(path) {
  const normalized = path.split('\\').join('/')
  return ![
    '/node_modules/',
    '/.turbo/',
    '/.git/',
    '/dist/',
    '/scripts/',
  ].some(segment => normalized.includes(segment))
    && !normalized.endsWith('/pnpm-lock.yaml')
    && !normalized.endsWith('/package-lock.json')
    && !normalized.endsWith('/.DS_Store')
}

await rm(targetRoot, { recursive: true, force: true })
await mkdir(targetRoot, { recursive: true })

for (const skillName of skillNames) {
  const sourceDir = join(sourceRoot, skillName)
  const targetDir = join(targetRoot, skillName)
  if (!existsSync(sourceDir)) {
    throw new Error(`Missing source skill directory: ${sourceDir}`)
  }

  await cp(sourceDir, targetDir, {
    recursive: true,
    filter: rejectGeneratedOrLocalFiles,
  })
}

console.log(`Copied ${skillNames.length} agent-qa skills to ${targetRoot}`)
