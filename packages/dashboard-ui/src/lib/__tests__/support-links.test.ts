import { describe, expect, it } from 'vitest'

import {
  GITHUB_ISSUE_URL,
  GITHUB_REPOSITORY_URL,
  SUPPORT_EMAIL,
  SUPPORT_FEEDBACK_SUBJECT,
  buildFeedbackMailto,
} from '@/lib/support-links'

const FORBIDDEN_SENTINELS = [
  'agent-qa.config.yaml',
  'https://app.example.test',
  'checkout flow',
  'memory observation',
  'sk_live_secret',
  'auth-state-prod',
  'r_secret-run-id',
  '/Users/pranshu/project',
  'AGENT_QA_SECRET',
  'localStorage',
  'screenshot.png',
  'recording.webm',
  'Error: boom',
]

const FORBIDDEN_NO_SEPARATOR_BRAND = ['Agent', 'QA'].join('')

function parseFeedbackMailto(url: string) {
  const prefix = `mailto:${SUPPORT_EMAIL}?`
  expect(url.startsWith(prefix)).toBe(true)

  const params = new URLSearchParams(url.slice(prefix.length))
  return {
    params,
    subject: params.get('subject'),
    body: params.get('body'),
  }
}

describe('support link constants', () => {
  it('defines exact static support targets', () => {
    expect(GITHUB_ISSUE_URL).toBe('https://github.com/vostride/agent-qa/issues/new')
    expect(GITHUB_ISSUE_URL).not.toContain('?')
    expect(GITHUB_REPOSITORY_URL).toBe('https://github.com/vostride/agent-qa')
    expect(SUPPORT_EMAIL).toBe('support@vostride.com')
    expect(SUPPORT_FEEDBACK_SUBJECT).toBe('agent-qa feedback')
  })
})

describe('buildFeedbackMailto', () => {
  it.each([undefined, null, '   '])('falls back to an unavailable version for %s', (version) => {
    const { subject, body } = parseFeedbackMailto(buildFeedbackMailto(version))

    expect(subject).toBe('agent-qa feedback')
    expect(body).toBe(
      [
        'Please describe what happened:',
        '',
        '---',
        'agent-qa debug info',
        'version: unavailable',
        'surface: dashboard',
      ].join('\n'),
    )
  })

  it('includes a trimmed safe version and dashboard surface', () => {
    const { subject, body } = parseFeedbackMailto(buildFeedbackMailto(' 0.1.18 '))

    expect(subject).toBe('agent-qa feedback')
    expect(body).toContain('version: 0.1.18')
    expect(body).toContain('surface: dashboard')
  })

  it('uses lowercase agent-qa public copy', () => {
    const { subject, body } = parseFeedbackMailto(buildFeedbackMailto('0.1.18'))

    expect(subject).toContain('agent-qa')
    expect(subject).not.toContain(FORBIDDEN_NO_SEPARATOR_BRAND)
    expect(body).toContain('agent-qa debug info')
    expect(body).not.toContain(FORBIDDEN_NO_SEPARATOR_BRAND)
  })

  it('percent-encodes subject and body query values without plus signs', () => {
    const url = buildFeedbackMailto('0.1.18')

    expect(url).toContain('subject=agent-qa%20feedback')
    expect(url).toContain('body=Please%20describe%20what%20happened%3A')
    expect(url).toContain('%0A---%0Aagent-qa%20debug%20info%0A')
    expect(url).not.toContain('+')
  })

  it('excludes forbidden local-data sentinels from the URL and decoded body', () => {
    const url = buildFeedbackMailto('0.1.18')
    const { body } = parseFeedbackMailto(url)

    for (const sentinel of FORBIDDEN_SENTINELS) {
      expect(url).not.toContain(sentinel)
      expect(body).not.toContain(sentinel)
    }
  })
})
