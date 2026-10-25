# agent-qa package instructions: @vostride/agent-qa-ios

## Scope

This package owns the iOS Appium adapter, WebdriverIO session handling,
XCUITest capabilities, and iOS mobile action execution.

## Read First

- `package.json`
- `src/adapter.ts`
- `src/session.ts`
- `src/types.ts`
- `src/__tests__/adapter.test.ts`

## Commands

- Test: `pnpm --filter @vostride/agent-qa-ios test`
- Typecheck: `pnpm --filter @vostride/agent-qa-ios typecheck`
- Build: `pnpm --filter @vostride/agent-qa-ios build`
