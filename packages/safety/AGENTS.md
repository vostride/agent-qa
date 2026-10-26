# agent-qa package instructions: @vostride/agent-qa-safety

## Scope

This package is the browser-safe safety kernel. It owns three things:

- the provider-request prompt walker and the declared-secret masking middleware
  factory: `mapPromptLeaves`, `createMaskingMiddleware` and the
  `ProviderRequestParams` type;
- the neutral execution-context resolver seam: `getActiveExecutionContext`,
  `resolveExecutionContext`, `setActiveExecutionContextResolver`, and the
  `ExecutionContextResolver` and `ExecutionContextSignals` types;
- the app-observed data delimiters: `wrapAppObservedData`,
  `APP_OBSERVED_DATA_OPEN` and `APP_OBSERVED_DATA_CLOSE`.

## Read First

- `package.json`
- `src/index.ts`
- `src/egress/masking-middleware.ts`
- `src/egress/map-prompt-leaves.ts`
- `src/policy/execution-context.ts`
- `src/serving/data-delimiters.ts`

## Commands

- Test: `pnpm --filter @vostride/agent-qa-safety test`
- Typecheck: `pnpm --filter @vostride/agent-qa-safety typecheck`
- Build: `pnpm --filter @vostride/agent-qa-safety build`
