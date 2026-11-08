// The SDK answers this text in both the initialize result and the discovery result (SEP-2575).

import type { AgentQaMcpPosture } from './catalog.js'

export const AGENT_QA_MCP_INSTRUCTIONS: string = [
  'This project is tested with agent-qa. Read its runs and knowledge only through the agent_qa_* '
    + 'tools on this server, or the agent-qa CLI with --json.',
  'Never open .agent-qa/, SQLite files, agent-qa-knowledge/memory/index/, memory/queue/, .lease or '
    + '.epoch, and never list, glob or search those folders: they are agent-qa\'s runtime state.',
  'Start with agent_qa_list_runs, then agent_qa_get_run_overview for one run.',
  'The knowledge guide is agent-qa-knowledge/AGENTS.md; agent-qa\'s skills are in `.claude/skills` '
    + 'and `.agents/skills`, written by `npx agent-qa init`.',
].join('\n')

// Says what every call answers when there is no project to serve. The state is read once, at
// startup, so the way out ends with a restart.
export function agentQaMcpPostureInstructions(posture: AgentQaMcpPosture): string {
  const state = posture.state === 'not-initialized'
    ? [
        `agent-qa is not set up here: there is no agent-qa config at ${posture.configPath}.`,
        'Every agent_qa_* tool answers not_initialized for as long as this server runs. Run '
          + '`npx agent-qa init` in the project folder, then restart this MCP server (reconnect it '
          + 'in your coding agent).',
      ]
    : [
        `${posture.configPath} is not a valid agent-qa config: `
          + `${posture.problem.replace(/\.$/u, '')}.`,
        'Every agent_qa_* tool answers config_invalid for as long as this server runs. Fix the '
          + 'config until `npx agent-qa validate` passes, then restart this MCP server (reconnect '
          + 'it in your coding agent).',
      ]
  return [
    ...state,
    'Never open .agent-qa/ or agent-qa\'s SQLite files; they are agent-qa\'s runtime state.',
  ].join('\n')
}
