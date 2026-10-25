# agent-qa package instructions: @vostride/agent-qa-arch

## Scope

This private utility package owns the architecture-as-code vocabulary, manifest,
and the architecture lint engine, run by `pnpm --filter @vostride/agent-qa-arch test`.
It enforces package class rules, dependency direction, knowledge-write
firewalls, native-store/provider denylist checks, and the transitional core
ratchet baseline.

## Read First

- `package.json`
- `src/index.ts`
- `src/manifest.ts`
- `src/contract-types.ts`
- `src/lint/classify-rule.ts`
- `src/lint/apply-ledger.ts`
- `src/lint/direction.ts`
- `src/lint/extract-specifiers.ts`
- `src/lint/knowledge-write.ts`
- `src/lint/reconcile-deps.ts`
- `src/lint/workspace-members.ts`

## Commands

- Test: `pnpm --filter @vostride/agent-qa-arch test`
- Typecheck: `pnpm --filter @vostride/agent-qa-arch typecheck`
