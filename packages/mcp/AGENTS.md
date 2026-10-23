# agent-qa package instructions: @vostride/agent-qa-mcp

Inherit the root `agent-qa/AGENTS.md` branding, security, and release rules.

## Scope

This package owns the Model Context Protocol server factory, the declared
tool -> registry op mapping and its projection into tool schemas, masked tool
results, entity resource templates, the v1 tool migration map, and the loopback
HTTP face. Every tool is a projection of a function-layer registry op invoked
through `invokeFunction`; the CLI's `agent-qa mcp` serves it over stdio or HTTP.

## Read First

- `package.json`
- `src/index.ts`
- `src/mapping.ts`
- `src/projection.ts`
- `src/catalog.ts`
- `src/masked-result.ts`
- `src/http.ts`
- `src/__tests__/`

## Commands

- Test: `pnpm --filter @vostride/agent-qa-mcp test`
- Typecheck: `pnpm --filter @vostride/agent-qa-mcp typecheck`
- Build: `pnpm --filter @vostride/agent-qa-mcp build`

## Local Rules

- Public MCP tools use `agent_qa_*`.
- Do not introduce a stale no-separator MCP tool prefix.
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
