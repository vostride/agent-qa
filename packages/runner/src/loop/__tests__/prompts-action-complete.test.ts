import { describe, it, expect } from 'vitest'
import { buildSystemPrompt } from '../prompts.js'

function getActionCompletionRule(systemPrompt: string): string {
  const match = systemPrompt.match(/\d+\. COMPLETION NEEDS ITS OUTCOME IN EVIDENCE:[\s\S]*?(?=\n\d+\. |\n\n Call the tool|$)/)
  return match?.[0] ?? ''
}

// Rule 19 asks for the requested outcome in evidence.
describe('completion needs its outcome in evidence', () => {
  const systemPrompt = buildSystemPrompt()
  const actionCompletionRule = getActionCompletionRule(systemPrompt)

  it('buildSystemPrompt contains the completion-needs-evidence rule', () => {
    expect(actionCompletionRule).toContain('COMPLETION NEEDS ITS OUTCOME IN EVIDENCE')
  })

  it('lists pure action verbs by surface: click, tap, select, fill', () => {
    expect(actionCompletionRule).toContain('click')
    expect(actionCompletionRule).toContain('tap')
    expect(actionCompletionRule).toContain('select')
    expect(actionCompletionRule).toContain('fill')
  })

  it('sets stepComplete only when the requested outcome is in evidence', () => {
    expect(actionCompletionRule).toContain('stepComplete: true only when the requested outcome is in evidence')
    expect(actionCompletionRule).not.toContain('stepComplete: true immediately')
  })

  it('names the outcome of a navigation control and of an effect control', () => {
    expect(actionCompletionRule).toContain('a tab, a link or a menu')
    expect(actionCompletionRule).toContain('a completed download or the exact copied value')
    expect(actionCompletionRule).toContain('after a reload or reopen within this step')
  })

  it('distinguishes multi-sub-goal steps', () => {
    expect(actionCompletionRule).toContain('multiple sub-goals')
  })

  it('references Rule 13 for multi-sub-goal steps', () => {
    expect(actionCompletionRule).toContain('Rule 13')
  })

  it('pairs Rule 19 with the outcome-evidence rule (Rule 22)', () => {
    expect(systemPrompt).toContain('22. OUTCOME EVIDENCE:')
    expect(systemPrompt).toContain('check the requested effect')
    expect(systemPrompt).toContain('do not repeat an action unless the step asks for repetition')
  })
})
