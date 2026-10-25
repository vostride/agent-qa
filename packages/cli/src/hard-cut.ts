export const RE_INITIALIZE_URL = 'https://vostride.com/docs/agent-qa/migrate/v0-1-to-v0-2'

export const HARD_CUT_STEPS = [
  'This config was written for agent-qa before v2. v2 does not upgrade a workspace; re-create it:',
  '  1. Stop agent-qa in this project: the dashboard, the daemon (agent-qa daemon stop) and any MCP server.',
  '  2. Copy aside rules you wrote: agent-qa-knowledge/policies/*.md and the agent-rules.md file your config names.',
  '  3. Delete .agent-qa/, agent-qa-knowledge/ and agent-qa-memory/.',
  '  4. Run agent-qa init --force. Your own tests, .env and .env.secrets.local are kept.',
  `What re-initializing loses, and every step: ${RE_INITIALIZE_URL}`,
].join('\n')

export function INVALID_CONFIG_FIX(configPath: string): string {
  return `Fix or remove the key named above in ${configPath}, then run agent-qa validate. To start over, agent-qa init --force rewrites agent-qa.config.yaml.`
}

export function isHardCutIssue(issue: { code?: unknown; params?: unknown }): boolean {
  return (
    issue.code === 'custom' &&
    typeof issue.params === 'object' &&
    issue.params !== null &&
    (issue.params as Record<string, unknown>).hardCut === true
  )
}
