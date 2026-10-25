# agent-qa package instructions: @vostride/agent-qa-dashboard-ui

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
