import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'

const root = new URL('..', import.meta.url).pathname

function skillFolderNames(skillsRoot) {
  const names = readdirSync(skillsRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && entry.name !== 'scripts')
    .filter(entry => existsSync(join(skillsRoot, entry.name, 'SKILL.md')))
    .map(entry => entry.name)
    .sort()
  if (names.length === 0) throw new Error(`no skill folders with a SKILL.md under ${skillsRoot}`)
  return names
}

function quotedReferences(body) {
  const names = [...body.matchAll(/references\/[A-Za-z0-9._-]+/gu)].map(match => match[0].replace(/\.+$/u, ''))
  return [...new Set(names)]
}

const skills = skillFolderNames(root)

for (const skill of skills) {
  const dir = join(root, skill)
  const skillPath = join(dir, 'SKILL.md')
  const openAiPath = join(dir, 'agents/openai.yaml')
  if (!existsSync(skillPath)) throw new Error(`${skill}: missing SKILL.md`)
  if (!existsSync(openAiPath)) throw new Error(`${skill}: missing agents/openai.yaml`)
  const body = readFileSync(skillPath, 'utf-8')
  if (!body.startsWith('---\nname: ')) throw new Error(`${skill}: missing frontmatter name`)
  if (!body.includes('description: ')) throw new Error(`${skill}: missing frontmatter description`)
  if (!body.includes('agent_qa_')) throw new Error(`${skill}: missing MCP tool guidance`)
  if (body.includes('agentqa_')) throw new Error(`${skill}: stale agentqa_ MCP tool prefix`)
  if (/^["']?dependencies["']?\s*:/mu.test(readFileSync(openAiPath, 'utf-8'))) {
    throw new Error(
      `${skill}: agents/openai.yaml declares dependencies; a Codex skill dependency cannot name the project's MCP entry`,
    )
  }
  for (const reference of quotedReferences(body)) {
    const referencePath = join(dir, reference)
    if (!existsSync(referencePath)) throw new Error(`${skill}: missing ${reference}`)
    if (statSync(referencePath).size === 0) throw new Error(`${skill}: empty ${reference}`)
  }
}

console.log('agent-qa skills pack validation passed')
