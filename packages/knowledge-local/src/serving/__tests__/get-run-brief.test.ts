import { APP_OBSERVED_DATA_OPEN } from '@vostride/agent-qa-safety'
import { asRecordId, type IndexEntry } from '@vostride/agent-qa-schema'
import { describe, expect, it } from 'vitest'

import type { PolicyLadder } from '../policy-ladder.js'
import { assembleRunBrief } from '../get-run-brief.js'

// These cases pin the brief; the composite and trace claims are pinned in `serve-trace.test.ts`.
function briefOnly(input: Parameters<typeof assembleRunBrief>[0]): ReturnType<typeof assembleRunBrief>['brief'] {
  return assembleRunBrief(input).brief
}

type OriginStampedEntry = IndexEntry & {
  origin?: 'app-observed' | 'user'
  originClass?: 'agent-observed' | 'agent-verified' | 'import' | 'user'
}

const scope = { tier: 'test', key: 'checkout' } as const

function candidate(
  id: string,
  overrides: Partial<OriginStampedEntry> = {},
): OriginStampedEntry {
  return {
    id: asRecordId(id),
    kind: 'fact',
    title: id,
    summary: id.slice(0, 4).padEnd(4, 'x'),
    trust: 1,
    anchors: [{ t: 'el', role: 'button', name: id }],
    status: 'active',
    servedAsCanary: false,
    scope,
    validity: 'current',
    ...overrides,
  }
}

function policy(
  text = '',
  oversized: PolicyLadder['oversized'] = [],
): PolicyLadder {
  return {
    text,
    files: text.length === 0 ? [] : ['policies/global.md'],
    oversized,
  }
}

describe('tiered run brief assembly', () => {
  it('fills L0 verbatim before L1 cautions and L2 procedures and facts', () => {
    const policyText = 'POLICY: preserve authored bytes\n'
    const userSummary = `User-authored fact: ${'u'.repeat(150)}`
    const block = briefOnly({
      candidates: [
        candidate('fact-learned', { summary: 'Learned checkout fact.' }),
        candidate('fact-user', { origin: 'user', summary: userSummary }),
        candidate('procedure-observed', {
          kind: 'procedure',
          origin: 'app-observed',
          summary: 'The observed checkout procedure completed.',
        }),
        candidate('caution-stale', {
          kind: 'caution',
          summary: 'The saved-card control may be stale.',
        }),
      ],
      policy: policy(policyText),
      scope,
      budget: 256,
      recordCap: 8,
    })

    expect(block.tiers.L0).toBe(`${policyText}${userSummary}`)
    expect(block.tiers.L1).toContain('The saved-card control may be stale.')
    expect(block.tiers.L2).toContain('The observed checkout procedure completed.')
    expect(block.tiers.L2).toContain('Learned checkout fact.')
    expect(block.tiers.L2).toContain(APP_OBSERVED_DATA_OPEN)
    expect(block.lines.map(({ id, tier }) => [id, tier])).toEqual([
      ['fact-user', 'L0'],
      ['caution-stale', 'L1'],
      ['procedure-observed', 'L2'],
      ['fact-learned', 'L2'],
    ])
    expect(block.lines[0]?.summary).toBe(userSummary)
    expect(block.admissions.map(({ id }) => id)).toEqual(block.lines.map(({ id }) => id))
    expect(block.admissions.every(({ renderedCost }) => renderedCost > 0)).toBe(true)
  })

  it('never budgets authored L0 out under starvation', () => {
    const policyText = 'Keep this policy byte-for-byte, including the final newline.\n'
    const block = briefOnly({
      candidates: [
        candidate('caution-a', { kind: 'caution' }),
        candidate('procedure-b', { kind: 'procedure' }),
      ],
      policy: policy(policyText),
      scope,
      budget: 0,
      recordCap: 8,
    })

    expect(block.tiers.L0).toBe(policyText)
    expect(block.tiers.L1).toBe('')
    expect(block.tiers.L2).toBe('')
    expect(block.truncation).toBe('truncated 0 of 2')
  })

  it('pins the exact-fit and one-line-short truncation boundary', () => {
    const candidates = [
      candidate('caution-a', { kind: 'caution' }),
      candidate('procedure-b', { kind: 'procedure' }),
      candidate('fact-c'),
      candidate('fact-d'),
    ]
    const input = {
      candidates,
      policy: policy(),
      scope,
      recordCap: 4,
    }

    const exact = briefOnly({ ...input, budget: 20 })
    const oneShort = briefOnly({ ...input, budget: 19 })

    expect(exact.lines).toHaveLength(4)
    expect(exact.truncation).toBe('')
    expect(oneShort.lines).toHaveLength(3)
    expect(oneShort.truncation).toBe('truncated 3 of 4')
  })

  it('returns empty learned tiers for empty and policy-only stores', () => {
    const empty = briefOnly({
      candidates: [],
      policy: policy(),
      scope,
      budget: 8,
      recordCap: 8,
    })
    const policyOnly = briefOnly({
      candidates: [],
      policy: policy('Only authored policy.'),
      scope,
      budget: 8,
      recordCap: 8,
    })

    expect(empty).toEqual({
      tiers: { L0: '', L1: '', L2: '' },
      lines: [],
      truncation: '',
      admissions: [],
    })
    expect(policyOnly).toEqual({
      tiers: { L0: 'Only authored policy.', L1: '', L2: '' },
      lines: [],
      truncation: '',
      admissions: [],
    })
  })

  it('is input-order independent and surfaces oversized-policy warnings', () => {
    const candidates = [
      candidate('fact-c'),
      candidate('caution-a', { kind: 'caution' }),
      candidate('procedure-b', { kind: 'procedure' }),
    ]
    const input = {
      policy: policy('Whole oversized policy.', [{
        file: 'policies/global.md',
        approxTokens: 4_001,
      }]),
      scope,
      budget: 8,
      recordCap: 8,
      asOfBuild: 23,
    }

    const forward = briefOnly({ ...input, candidates })
    const reverse = briefOnly({ ...input, candidates: [...candidates].reverse() })

    expect(reverse).toEqual(forward)
    expect(forward.tiers.L0).toBe('Whole oversized policy.')
    expect(forward.truncation).toContain('policies/global.md')
    expect(forward.truncation).toContain('4001')
    expect(JSON.stringify(forward)).not.toMatch(/\b20\d{2}-\d{2}-\d{2}[T ]/)
  })
})
