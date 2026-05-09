# agent-qa package instructions: @vostride/agent-qa-dashboard-ui

Inherit the root `agent-qa/AGENTS.md` branding, security, and release rules.

## Scope

This package owns the React 19 and Vite dashboard UI assets served by the local
dashboard. It includes routes, pages, shared components, Monaco editing,
command palette behavior, charts, tables, and YAML authoring surfaces.

## Read First

- `package.json`
- `src/app.tsx`
- `src/components/app-sidebar.tsx`
- `src/components/command-palette.tsx`
- `src/components/monaco-editor.tsx`
- `src/pages/config.tsx`
- `src/lib/routes.ts`
- Relevant `src/__tests__/*.test.ts` or `*.test.tsx`

## Commands

- Test: `pnpm --filter @vostride/agent-qa-dashboard-ui test`
- Typecheck: `pnpm --filter @vostride/agent-qa-dashboard-ui typecheck`
- Build: `pnpm --filter @vostride/agent-qa-dashboard-ui build`
- Dev server: `pnpm --filter @vostride/agent-qa-dashboard-ui dev`

## Local Rules

- Follow existing React Router route and page patterns in `src/app.tsx`.
- Use existing UI primitives and component patterns before creating new ones.
- Keep Monaco theme and YAML tooling changes localized to `src/lib` and editor
  components.
- Preserve command palette route behavior and keyboard interactions.
- Do not add marketing-style landing pages; dashboard surfaces should stay
  operational, dense, and scannable.
- Keep API calls in `src/lib/api.ts` or nearby established helpers.

## Verification

Run focused UI checks:

```bash
pnpm --filter @vostride/agent-qa-dashboard-ui test
pnpm --filter @vostride/agent-qa-dashboard-ui typecheck
```
