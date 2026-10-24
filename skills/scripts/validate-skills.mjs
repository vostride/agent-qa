import { readFileSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'

const root = new URL('..', import.meta.url).pathname
const skills = ['agent-qa-authoring', 'agent-qa-result-triage', 'agent-qa-debug-fix', 'agent-qa-knowledge']
const requiredReferences = {
  'agent-qa-authoring': ['references/agent-qa-contracts.json'],
  'agent-qa-result-triage': ['references/triage-categories.md'],
  'agent-qa-debug-fix': [],
  'agent-qa-knowledge': ['references/knowledge-reads.md'],
}

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
  for (const reference of requiredReferences[skill]) {
    const referencePath = join(dir, reference)
    if (!existsSync(referencePath)) throw new Error(`${skill}: missing ${reference}`)
    if (statSync(referencePath).size === 0) throw new Error(`${skill}: empty ${reference}`)
  }
}

console.log('agent-qa skills pack validation passed')
