// Every starting point links the recipe page within its bounds.

import { describe, expect, it } from 'vitest'

import { AGENT_QA_MCP_INSTRUCTIONS } from '@vostride/agent-qa-mcp'

import {
  CODING_AGENTS_URL,
  buildAgentInstructionPointer,
  buildKnowledgeAgentGuide,
} from '../../commands/knowledge-guide.js'

describe('agent guides link the published recipe page', () => {
  it('the pointer and the guide each link the published recipe page', () => {
    expect(CODING_AGENTS_URL).toBe('https://vostride.com/docs/agent-qa/coding-agents')
    const subjects: [string, string][] = [
      ['the root pointer', buildAgentInstructionPointer().join('\n')],
      ['the generated guide', buildKnowledgeAgentGuide()],
    ]
    expect(subjects.every(([, text]) => text.length > 0), 'every subject has text').toBe(true)
    expect(subjects.filter(([, text]) => !text.includes(CODING_AGENTS_URL))
      .map(([label]) => `${label} does not link ${CODING_AGENTS_URL}`)).toEqual([])
  })

  it('the pointer keeps at most 9 lines and the guide at most 50 with the link, and the MCP instructions carry none', () => {
    expect(buildAgentInstructionPointer().length, 'pointer lines').toBeLessThanOrEqual(9)
    expect(buildKnowledgeAgentGuide().split('\n').length, 'guide lines').toBeLessThanOrEqual(50)
    expect(AGENT_QA_MCP_INSTRUCTIONS.length, 'the MCP instructions have text').toBeGreaterThan(0)
    expect(AGENT_QA_MCP_INSTRUCTIONS).not.toContain('coding-agents')
  })
})
