// The server's initialize instructions: init's pointer, delivered by
// the one channel every MCP host receives. agent-qa never writes CLAUDE.md. Static text
// on purpose: nothing from the workspace or the caller is interpolated. Protocol grounding: on the
// stateless revision there is no initialize handshake (SEP-2575), and the SDK answers the same
// text in the discovery result, so a host reaches it on either revision.

export const AGENT_QA_MCP_INSTRUCTIONS: string = [
  'This project is tested with agent-qa. Read its runs and knowledge only through the agent_qa_* '
    + 'tools on this server, or the agent-qa CLI with --json.',
  'Never open .agent-qa/, SQLite files, agent-qa-knowledge/memory/index/, memory/queue/, .lease or '
    + '.epoch, and never list, glob or search those folders: they are agent-qa\'s runtime state.',
  'Start with agent_qa_list_runs, then agent_qa_get_run_overview for one run.',
  'The knowledge guide is agent-qa-knowledge/AGENTS.md; `npx agent-qa skills` lists the skills and '
    + 'their folder.',
].join('\n')
