import type { TestDefinition } from '../types/test.js'
import type { SuiteDefinition } from './types.js'

function isPlainObject(val: unknown): val is Record<string, unknown> {
  return typeof val === 'object' && val !== null && !Array.isArray(val)
}

function deepMerge(base: unknown, override: unknown): unknown {
  if (!isPlainObject(base) || !isPlainObject(override)) return override
  const result: Record<string, unknown> = { ...base }
  for (const key of Object.keys(override)) {
    if (key in result && isPlainObject(result[key]) && isPlainObject(override[key])) {
      result[key] = deepMerge(result[key], override[key])
    } else {
      result[key] = override[key]
    }
  }
  return result
}

// Merges the suite's target and use into a member and drops its `url`: the suite owns startup.
export function patchTestForSuite(
  test: TestDefinition,
  suite: SuiteDefinition,
  _index: number,
): TestDefinition {
  const patched = structuredClone(test)

  if (suite.target) {
    ;(patched as any).target = suite.target
  }

  if (suite.use && (patched as any).use) {
    ;(patched as any).use = deepMerge(suite.use, (patched as any).use)
  } else {
    ;(patched as any).use = (patched as any).use ?? suite.use
  }

  delete (patched as any).url

  return patched
}
