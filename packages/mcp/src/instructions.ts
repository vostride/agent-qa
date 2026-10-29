// Static text; with no initialize handshake (SEP-2575) the SDK answers it in the discovery result.

export const AGENT_QA_MCP_INSTRUCTIONS: string = [
  'This project is tested with agent-qa. Read its runs and knowledge only through the agent_qa_* '
    + 'tools on this server, or the agent-qa CLI with --json.',
  'Never open .agent-qa/, SQLite files, agent-qa-knowledge/memory/index/, memory/queue/, .lease or '
    + '.epoch, and never list, glob or search those folders: they are agent-qa\'s runtime state.',
  'Start with agent_qa_list_runs, then agent_qa_get_run_overview for one run.',
  'The knowledge guide is agent-qa-knowledge/AGENTS.md; `npx agent-qa skills` lists the skills and '
    + 'their folder.',
].join('\n')
