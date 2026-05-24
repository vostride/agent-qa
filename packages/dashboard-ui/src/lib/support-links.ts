export const GITHUB_ISSUE_URL = 'https://github.com/vostride/agent-qa/issues/new'
export const GITHUB_REPOSITORY_URL = 'https://github.com/vostride/agent-qa'
export const SUPPORT_EMAIL = 'support@vostride.com'
export const SUPPORT_FEEDBACK_SUBJECT = 'agent-qa feedback'

export function buildFeedbackMailto(version?: string | null): string {
  const safeVersion = version?.trim() || 'unavailable'
  const body = [
    'Please describe what happened:',
    '',
    '---',
    'agent-qa debug info',
    `version: ${safeVersion}`,
    'surface: dashboard',
  ].join('\n')

  return `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent(SUPPORT_FEEDBACK_SUBJECT)}&body=${encodeURIComponent(body)}`
}
