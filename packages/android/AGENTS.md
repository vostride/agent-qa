# agent-qa package instructions: @vostride/agent-qa-android

Inherit the root `agent-qa/AGENTS.md` branding, security, and release rules.

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

## Local Rules

- Keep Android setup failures actionable. Report missing Appium, driver, device,
  app package, and activity details clearly.
- Treat UiAutomator2 driver installation as idempotent where setup code handles
  it.
- Do not hardcode local emulator names outside config or tests.
- Preserve WebdriverIO session cleanup paths so failed runs do not leak sessions.
- Keep platform-specific behavior in Android package code or shared mobile core
  helpers, not in unrelated CLI or dashboard surfaces.

## Verification

Run focused package checks:

```bash
pnpm --filter @vostride/agent-qa-android test
pnpm --filter @vostride/agent-qa-android typecheck
```
