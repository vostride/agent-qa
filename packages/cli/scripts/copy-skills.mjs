import { cp, mkdir, rm } from 'node:fs/promises'
import { existsSync, readdirSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const sourceRoot = join(here, '../../..', 'skills')
const targetRoot = join(here, '..', 'skills')

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

const skillNames = skillFolderNames(sourceRoot)

const SKIPPED_FOLDERS = new Set(['node_modules', '.turbo', '.git', 'dist'])
const SKIPPED_FILES = new Set(['pnpm-lock.yaml', 'package-lock.json', '.DS_Store'])

// Judged inside the skill folder, so the checkout's own location never decides what is copied.
function keepsSkillFile(sourceDir) {
  return path => {
    const segments = relative(sourceDir, path).split(sep).filter(Boolean)
    return !segments.some(segment => SKIPPED_FOLDERS.has(segment))
      && !SKIPPED_FILES.has(segments.at(-1) ?? '')
  }
}

await rm(targetRoot, { recursive: true, force: true })
await mkdir(targetRoot, { recursive: true })

for (const skillName of skillNames) {
  const sourceDir = join(sourceRoot, skillName)
  const targetDir = join(targetRoot, skillName)
  await cp(sourceDir, targetDir, {
    recursive: true,
    filter: keepsSkillFile(sourceDir),
  })
}

console.log(`Copied ${skillNames.length} agent-qa skills to ${targetRoot}`)
