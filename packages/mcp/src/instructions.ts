// The SDK answers this text in both the initialize result and the discovery result (SEP-2575).

import type { AgentQaMcpPosture } from './catalog.js'

export const AGENT_QA_MCP_INSTRUCTIONS: string = [
  'This project is tested with agent-qa. Read its runs and knowledge only through the agent_qa_* '
    + 'tools on this server, or the agent-qa CLI with --json.',
  'Never open .agent-qa/, SQLite files, agent-qa-knowledge/memory/index/, memory/queue/, .lease or '
    + '.epoch, and never list, glob or search those folders: they are agent-qa\'s runtime state.',
  'Start with agent_qa_list_runs, then agent_qa_get_run_overview for one run.',
  'The knowledge guide is agent-qa-knowledge/AGENTS.md; `npx agent-qa skills` lists the skills and '
    + 'their folder.',
].join('\n')

// Says what every call answers when there is no project to serve.
export function agentQaMcpPostureInstructions(posture: AgentQaMcpPosture): string {
  return [
    `agent-qa is not set up here: there is no agent-qa config at ${posture.configPath}. Every `
      + 'agent_qa_* tool answers not_initialized until you run `npx agent-qa init` in the project '
      + 'folder.',
    'Never open .agent-qa/ or agent-qa\'s SQLite files; they are agent-qa\'s runtime state.',
  ].join('\n')
}
