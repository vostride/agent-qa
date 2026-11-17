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
- `src/i18n/index.ts`
- `src/i18n/languages.ts`
- `src/i18n/terms.md`
- Relevant `src/__tests__/*.test.ts` or `*.test.tsx`

## Translations

- The dashboard ships English and nine translations. English text lives in
  `src/i18n/locales/en/<area>.ts`, one file per key prefix, and every key has one home. Each
  language has `src/i18n/locales/<code>/` with the same file names.
- A change that adds or rewords English text updates all nine translations in the same change,
  following `src/i18n/terms.md`, the translator's rule book. Each language's section there is
  kept in step with its catalog. English shows through only for a key that was missed.
- Nothing checks for a missing translation, and no test, type or warning for one is added.
  `src/i18n/__tests__/translations-keep-placeholders-and-tags.test.ts` checks that a
  translation keeps English's slots and tags and carries bare tags only; it does not check
  wording.
- Read text through `useTranslation` in a component and through `t` from `@/i18n` in a plain
  module, at render and never at module scope. A table of text is a `textTable`, and a text
  constant is a zero-argument function. Put `t` in the dependency list of a `useMemo` or
  `useCallback` that holds text.
- A sentence is one key with slots (`{{name}}`), never glued from parts. A count uses `count`
  with `_one` and `_other` forms. No code compares or cuts a shown sentence to decide
  something; pass the code or flag instead.
- A link inside a sentence is a bare `<a>…</a>` tag in the catalog, drawn with `Trans` and a
  `components` map that sets the address. A tag is never named after an HTML void element such
  as `link` or `br`: `Trans` closes it at once and the words fall outside it.
- A config key shown as code inside a sentence is a bare `<code>…</code>` tag in the catalog.
  The Remotes sentences are split at those tags by `src/lib/config-copy.ts`, not by `Trans`,
  because one of them holds the config syntax `<name>`. No code searches a sentence for a key.
- Text from outside the UI (server messages, run output, model text, the project's tests,
  suites and hooks), Monaco's own text and the schema package's sentences are shown as
  produced. `agent-qa`, YAML keys, commands and file names stay as written in every language.
- Dates, times, numbers and durations go through `src/lib/format.ts`. English keeps its
  formats in every browser. `formatRegionalNumber` and `formatRegionalDateTime` follow the
  browser's regional variant of the dashboard's language when the browser has one.
  `formatNumber`, `formatTokens`, `formatDateTime`, `formatPercent`, `formatUnit`,
  `formatUnitList`, `formatTimeAgo` and `formatRelativeCompact` use the dashboard's language
  alone.
- The language choice lives in the browser's storage only. It is never written to the config
  file or sent to the server.
- A real-browser test states its language: a plain launch passes `--lang=en-US`, a persistent
  context passes `locale: 'en-US'` because it ignores that argument, and a test about another
  language states its own `locale`. This package's tests read the US English language list
  `src/test/i18n.ts` states; a test that needs another list states its own.
- No catalog key name, in any language, may contain the gate-run marker words that
  `packages/knowledge-local/src/projection/__tests__/gate-run-exclusion.e2e.test.ts` scans
  every source line for; that test expects a fixed list of the files that carry the marker.

## Commands

- Test: `pnpm --filter @vostride/agent-qa-dashboard-ui test`
- Typecheck: `pnpm --filter @vostride/agent-qa-dashboard-ui typecheck`
- Build: `pnpm --filter @vostride/agent-qa-dashboard-ui build`
- Dev server: `pnpm --filter @vostride/agent-qa-dashboard-ui dev`
