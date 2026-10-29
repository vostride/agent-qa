import { describe, it, expect } from 'vitest'
import { buildSystemPrompt, buildVerifierStableTier } from '../prompts.js'
import { tokenize } from '../requested-conditions.js'

const PLATFORMS = ['web', 'android', 'ios', undefined] as const

const SECRETS_RULE =
  '23. SECRETS: [secret:NAME] is a declared secret whose value exists but is hidden from you. ' +
  'To type it, use {{secret:NAME}} verbatim as the action value, never [secret:NAME].'

const NUMBERED_PLACEHOLDER = /<[A-Z]+_[0-9]+>/

function rule23(platform: (typeof PLATFORMS)[number]): string {
  const prompt = buildSystemPrompt(platform)
  const block = prompt.slice(prompt.indexOf('Rules:\n'), prompt.indexOf('\n\nCall the tool'))
  return block.slice(block.indexOf('\n23. ') + 1)
}

describe('secret placeholder prompt contract', () => {
  for (const platform of PLATFORMS) {
    const label = platform ?? 'undefined (platform-neutral)'

    describe(`platform: ${label}`, () => {
      const prompt = buildSystemPrompt(platform)

      it('carries a numbered SECRET PLACEHOLDER rule', () => {
        expect(prompt).toMatch(/^23\. SECRETS: /m)
      })

      it('names both placeholder forms — template and redacted display marker', () => {
        expect(prompt).toContain('{{secret:NAME}}')
        expect(prompt).toContain('[secret:NAME]')
      })

      it('states the value exists and is deliberately hidden, not missing', () => {
        expect(prompt).toContain('whose value exists but is hidden from you')
      })

      it('does not disclose or request any concrete secret value', () => {
        expect(prompt).not.toMatch(/secret value is\s+\S/i)
        expect(prompt).not.toContain('ask the user for the secret')
      })
    })
  }
})

describe('the secret forms in prompts and the tokenizer', () => {
  it('Rule 23 is one line that names both forms and how to type a secret', () => {
    for (const platform of PLATFORMS) {
      const rule = rule23(platform)
      expect(rule).not.toContain('\n')
      expect(rule).toBe(SECRETS_RULE)
      expect(rule).toContain('{{secret:NAME}}')
      expect(rule).toContain('[secret:NAME]')
      const secretLines = buildSystemPrompt(platform)
        .split('\n')
        .filter((line) => /secret/i.test(line))
      expect(secretLines).toEqual([SECRETS_RULE])
    }
  })

  it('no prompt names a numbered placeholder', () => {
    for (const platform of PLATFORMS) {
      expect(buildSystemPrompt(platform).match(NUMBERED_PLACEHOLDER)?.[0]).toBeUndefined()
    }
    expect(buildVerifierStableTier().match(NUMBERED_PLACEHOLDER)?.[0]).toBeUndefined()
  })

  it('the requested-conditions tokenizer keeps the two secret forms as single tokens', () => {
    const texts = (value: string) => tokenize(value).map((token) => token.text)
    expect(texts('Sign in as [secret:EMAIL] then {{secret:PW}}')).toEqual([
      'Sign',
      'in',
      'as',
      '[secret:EMAIL]',
      'then',
      '{{secret:PW}}',
    ])
    expect(texts('Sign in as <EMAIL_0>')).toEqual(['Sign', 'in', 'as', 'EMAIL', '0'])
  })
})
