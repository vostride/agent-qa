# agent-qa package instructions: @vostride/agent-qa-runner-local

## Scope

This package is the host-adapter home for the runner action-plan cache. It owns
the host APIs the storage-neutral `@vostride/agent-qa-runner` package deliberately
excludes: the concrete filesystem `FsActionCache` store behind the runner
`ActionPlanCache` port, git-branch detection for cache namespacing, and branch
write-skip policy evaluation. The package root exports `FsActionCache`,
`FsStorageStateStore`, `resolveBranch` and `shouldWrite`.

## Read First

- `package.json`
- `src/index.ts`
- `src/ownership-contract.ts`
- `src/fs-action-cache.ts`
- `src/storage-state-store.ts`
- `src/branch-resolver.ts`
- `src/write-policy.ts`

## Commands

- Test: `pnpm --filter @vostride/agent-qa-runner-local test`
- Typecheck: `pnpm --filter @vostride/agent-qa-runner-local typecheck`
- Build: `pnpm --filter @vostride/agent-qa-runner-local build`
