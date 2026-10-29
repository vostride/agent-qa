/**
 * a resolve hook for code that loads `writer-lease.ts` from SOURCE
 * in a worker thread or a child process (Node 24 type stripping), so no stale dist can decide a
 * cell. Source specifiers name the emitted `.js`; without a build step only the `.ts` exists, so a
 * relative `.js` that does not resolve is retried as `.ts`. Prepend it to the worker or `-e` code.
 */
export const RESOLVE_TS_SOURCE_HOOK = [
  "process.getBuiltinModule('node:module').registerHooks({",
  '  resolve(specifier, context, nextResolve) {',
  '    try { return nextResolve(specifier, context) } catch (error) {',
  "      if ((specifier.startsWith('./') || specifier.startsWith('../')) && specifier.endsWith('.js')) {",
  "        return nextResolve(specifier.slice(0, -3) + '.ts', context)",
  '      }',
  '      throw error',
  '    }',
  '  },',
  '})',
].join('\n')
