import type { CurationAuthorship } from '../delta/envelope'

// `degraded` covers repaired output, a weak or unknown family, and missing authorship facts.
export type CuratorTier = 'full' | 'degraded' | 'floor'

// `secret` exists so extraction can reject an unparameterized secret.
export type ProcedureParamType = 'string' | 'number' | 'boolean' | 'secret'

// Kept here because schema must not import the model package, which owns the family table.
const CAPABLE_FAMILY_PREFIXES: readonly string[] = [
  'claude',
  'gpt-4o',
  'gpt-4.1',
  'gpt-5',
  'o1',
  'o3',
  'o4',
  'gemini-1.5',
  'gemini-2.5',
  'gemini-3',
]

/** A prefix only matches when the next character is a token boundary (or the end). */
export function matchesCapableFamily(key: string): boolean {
  const normalized = key.trim().toLowerCase()
  return CAPABLE_FAMILY_PREFIXES.some((prefix) => {
    if (!normalized.startsWith(prefix)) return false
    const next = normalized.charAt(prefix.length)
    return next === '' || next === '-' || next === '.' || next === '_' || next === ':' || next === '/'
  })
}

// Absent authorship and every unknown shape resolve to `degraded`, never a throw.
export function curatorTier(authorship: CurationAuthorship | undefined): CuratorTier {
  if (authorship === undefined) return 'degraded'
  if (authorship.path === 'deterministic-fallback') return 'floor'
  if (authorship.path === 'llm-repaired') return 'degraded'
  const key = authorship.model?.family ?? authorship.model?.id
  if (key === undefined) return 'degraded'
  return matchesCapableFamily(key) ? 'full' : 'degraded'
}
