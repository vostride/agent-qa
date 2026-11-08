// The guide links the recipe page; the block and the MCP instructions do not.

import { describe, expect, it } from 'vitest'

import { AGENT_QA_MCP_INSTRUCTIONS } from '@vostride/agent-qa-mcp'

import {
  CODING_AGENTS_URL,
  buildAgentInstructionPointer,
  buildKnowledgeAgentGuide,
} from '../../commands/knowledge-guide.js'

const SKILLS = [
  { name: 'agent-qa-authoring', shortDescription: 'Author agent-qa tests safely' },
  { name: 'agent-qa-plugin-acme', shortDescription: 'Acme browsers for web tests' },
]

describe('agent guides link the published recipe page', () => {
  it('the guide links the published recipe page, and the block does not', () => {
    expect(CODING_AGENTS_URL).toBe('https://vostride.com/docs/agent-qa/coding-agents')
    expect(buildKnowledgeAgentGuide()).toContain(CODING_AGENTS_URL)
    expect(buildAgentInstructionPointer(SKILLS, '1.2.3').join('\n')).not.toContain('coding-agents')
  })

  it('the block names the MCP server, lists each skill it is given with the version and ends with npx agent-qa init, and the MCP instructions carry no recipe link', () => {
    const block = buildAgentInstructionPointer(SKILLS, '1.2.3')
    expect(block.join('\n')).toContain('the agent_qa_* tools of\nthe agent-qa MCP server')
    const listed = block.indexOf('- Skills (agent-qa 1.2.3):')
    expect(listed, 'the skills heading').toBeGreaterThan(0)
    expect(block.slice(listed + 1, listed + 1 + SKILLS.length)).toEqual([
      '  - agent-qa-authoring: Author agent-qa tests safely',
      '  - agent-qa-plugin-acme: Acme browsers for web tests',
    ])
    expect(block.at(-1)).toBe('- Skills or MCP server missing or stale: run `npx agent-qa init`')
    expect(AGENT_QA_MCP_INSTRUCTIONS.length, 'the MCP instructions have text').toBeGreaterThan(0)
    expect(AGENT_QA_MCP_INSTRUCTIONS).not.toContain('coding-agents')
  })
})
