import { describe, it, expect } from 'vitest'
import { buildSystemPrompt } from '../prompts.js'

function getActionCompletionRule(systemPrompt: string): string {
  const match = systemPrompt.match(/\d+\. ACTION STEP COMPLETION:[\s\S]*?(?=\n\d+\. |\n\n Call the tool|$)/)
  return match?.[0] ?? ''
}

describe('ACTION-COMPLETE-01 — action step completion', () => {
  const systemPrompt = buildSystemPrompt()
  const actionCompletionRule = getActionCompletionRule(systemPrompt)

  it('buildSystemPrompt contains ACTION STEP COMPLETION guidance', () => {
    expect(actionCompletionRule).toContain('ACTION STEP COMPLETION')
  })

  it('lists pure action verbs: click, tap, press, select, fill', () => {
    expect(actionCompletionRule).toContain('click')
    expect(actionCompletionRule).toContain('tap')
    expect(actionCompletionRule).toContain('press')
    expect(actionCompletionRule).toContain('select')
    expect(actionCompletionRule).toContain('fill')
  })

  it('instructs to set stepComplete immediately', () => {
    expect(actionCompletionRule).toContain('stepComplete: true immediately')
  })

  it('mentions downloads, external links, new tabs as no-visible-change scenarios', () => {
    expect(actionCompletionRule).toContain('download')
    expect(actionCompletionRule).toContain('external link')
    expect(actionCompletionRule).toContain('new tab')
  })

  it('distinguishes single-action steps from multi-sub-goal steps', () => {
    expect(actionCompletionRule).toContain('SINGLE-ACTION steps only')
    expect(actionCompletionRule).toContain('multiple sub-goals')
  })

  it('references Rule 13 for multi-sub-goal steps', () => {
    expect(actionCompletionRule).toContain('Rule 13')
  })
})
