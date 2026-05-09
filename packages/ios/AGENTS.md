# agent-qa package instructions: @vostride/agent-qa-ios

Inherit the root `agent-qa/AGENTS.md` branding, security, and release rules.

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

## Local Rules

- Running iOS simulator tests requires macOS and Xcode. Linux/source init should
  not hard-break until an iOS run, doctor, or install-specific path needs host
  capability.
- Keep XCUITest setup failures actionable and platform-aware.
- Do not hardcode local simulator names outside config or tests.
- Preserve WebdriverIO session cleanup paths so failed runs do not leak sessions.
- Keep iOS-specific behavior in this package or shared mobile core helpers.

## Verification

Run focused package checks:

```bash
pnpm --filter @vostride/agent-qa-ios test
pnpm --filter @vostride/agent-qa-ios typecheck
```
