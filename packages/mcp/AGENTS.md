# agent-qa package instructions: @vostride/agent-qa-mcp

Inherit the root `agent-qa/AGENTS.md` branding, security, and release rules.

## Scope

This package owns the Model Context Protocol server, local HTTP transport,
stdio transport, tool schemas, schema references, and dashboard-backed authoring
and run tools.

## Read First

- `package.json`
- `src/server.ts`
- `src/local-http.ts`
- `src/schema-reference.ts`
- `src/index.ts`
- `src/__tests__/`
- `references/`

## Commands

- Test: `pnpm --filter @vostride/agent-qa-mcp test`
- Typecheck: `pnpm --filter @vostride/agent-qa-mcp typecheck`
- Build: `pnpm --filter @vostride/agent-qa-mcp build`

## Local Rules

- Public MCP tools use `agent_qa_*`.
- Do not introduce a stale no-separator MCP tool prefix.
- Keep schema references synchronized with core schemas.
- Authoring and run tools that need dashboard state must keep explicit dashboard
  URL handling and clear errors when the dashboard is unavailable.
- Keep local HTTP defaults loopback-only unless a plan explicitly changes
  networking behavior.
- Do not expose secrets through MCP tool responses.

## Verification

Run focused MCP checks:

```bash
pnpm --filter @vostride/agent-qa-mcp test
pnpm --filter @vostride/agent-qa-mcp typecheck
```
