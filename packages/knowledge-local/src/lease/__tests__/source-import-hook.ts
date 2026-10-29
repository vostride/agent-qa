// Retries an unresolved relative `.js` as `.ts`, so a worker loads source, not a stale dist.
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
