# agent-qa package instructions: @vostride/agent-qa-tools-local

## Scope

This package is the storageImplementation home for future local tool execution
and host-IO adapters behind the neutral `ToolsPort`. It is currently a shell
awaiting the milestone that provides concrete local tool adapters.

## Read First

- `package.json`
- `src/index.ts`
- `src/ownership-contract.ts`

## Commands

- Test: `pnpm --filter @vostride/agent-qa-tools-local test`
- Typecheck: `pnpm --filter @vostride/agent-qa-tools-local typecheck`
- Build: `pnpm --filter @vostride/agent-qa-tools-local build`

## Local Rules

- Depend on `@vostride/agent-qa-agent` for the neutral `ToolsPort`; never make
  the neutral agent package depend on this local package.
- Keep concrete host-IO, filesystem, and process behavior behind the tools port
  and out of provider-neutral packages.
- Do not add concrete tool adapters until the milestone that fills this local
  implementation home.
- Keep agent planning, knowledge persistence, and agent persistence out of this
  package.
- Do not import model provider SDKs or platform adapters here.

## Verification

Run focused package checks:

```bash
pnpm --filter @vostride/agent-qa-tools-local test
pnpm --filter @vostride/agent-qa-tools-local typecheck
```
