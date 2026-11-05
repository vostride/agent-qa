# agent-qa package instructions: @vostride/agent-qa-ios

## Scope

This package owns the iOS Appium adapter, WebdriverIO session handling,
XCUITest capabilities, and iOS mobile action execution.
It also lists the iOS simulators on this machine, and opens sessions on remote
Appium servers.

## Read First

- `package.json`
- `src/adapter.ts`
- `src/session.ts`
- `src/simulators-here.ts`
- `src/types.ts`
- `src/__tests__/adapter.test.ts`

## Commands

- Test: `pnpm --filter @vostride/agent-qa-ios test`
- Typecheck: `pnpm --filter @vostride/agent-qa-ios typecheck`
- Build: `pnpm --filter @vostride/agent-qa-ios build`
