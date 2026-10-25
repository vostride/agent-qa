# agent-qa

agent-qa runs plain-English tests against real web, Android and iOS apps, keeps the evidence of every step, and learns from each run.

## Docs (Markdown)

- Start: https://vostride.com/docs/agent-qa.md
- Agent quickstart: https://vostride.com/docs/agent-qa/agent-quickstart.md
- Docs index: https://vostride.com/docs.md
- Site index: https://vostride.com/llms.txt

## What's in this repo

- CLI `agent-qa`: `packages/cli`
- MCP server (`agent_qa_*` tools): `packages/mcp`
- Dashboard: `packages/dashboard-server` and `packages/dashboard-ui`
- Web, Android and iOS adapters: `packages/web`, `packages/android` and `packages/ios`
- Packaged skills: `skills/`; Docker images: `docker/`
- Each package's `AGENTS.md` says what it does.

## Names you'll see

- `agent-qa.config.yaml`, `agent-qa.local.yaml`
- `.agent-qa/` (runtime files)
- `AGENT_QA_*` env vars, `agent_qa_*` MCP tools
- npm: `agent-qa`, `@vostride/agent-qa-*`
