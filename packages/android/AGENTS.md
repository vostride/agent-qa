# agent-qa package instructions: @vostride/agent-qa-android

## Scope

This package owns the Android Appium adapter, WebdriverIO session handling,
UiAutomator2 capabilities, and Android mobile action execution.

## Read First

- `package.json`
- `src/adapter.ts`
- `src/session.ts`
- `src/types.ts`
- `src/__tests__/adapter.test.ts`

## Commands

- Test: `pnpm --filter @vostride/agent-qa-android test`
- Typecheck: `pnpm --filter @vostride/agent-qa-android typecheck`
- Build: `pnpm --filter @vostride/agent-qa-android build`
