# agent-qa package instructions: @vostride/agent-qa-mcp

## Scope

This package owns the Model Context Protocol server factory, the declared
tool -> registry op mapping and its projection into tool schemas, masked tool
results, entity resource templates, and the loopback HTTP face. Every tool is a
projection of a function-layer registry op invoked through `invokeFunction`;
the CLI's `agent-qa mcp` serves it over stdio or HTTP.

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
