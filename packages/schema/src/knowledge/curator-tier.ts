import type { CurationAuthorship } from '../delta/envelope'

/**
 * D-06 curator capability tier. `full` = clean LLM authorship by a v46-capable family;
 * `degraded` = LLM authorship that needed repair, a weak/unknown family, or absent
 * authorship facts (conservative); `floor` = the deterministic fallback path.
 */
export type CuratorTier = 'full' | 'degraded' | 'floor'

/**
 * D-03 closed procedure-parameter type union. `secret` exists so the extraction
 * disposition can structurally reject unparameterized secrets.
 */
export type ProcedureParamType = 'string' | 'number' | 'boolean' | 'secret'

/**
 * PROVISIONAL v46-capable family prefixes: the tool-calling + structured-output rows of the
 * model package's family table. The list lives HERE (not in the model package) because schema
 * must never import from model — dependency direction. Matched case-insensitively at token
 * boundaries against `model.family ?? model.id` (RESEARCH A1: authorship stamps only
 * `model.id` today, so id is the fallback match key).
 */
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

/**
 * The ONE pure, total D-06 tier derivation over raw authorship facts. Absent authorship and
 * every unknown shape resolve to `degraded` — never a throw, never a widened string.
 */
export function curatorTier(authorship: CurationAuthorship | undefined): CuratorTier {
  if (authorship === undefined) return 'degraded'
  if (authorship.path === 'deterministic-fallback') return 'floor'
  if (authorship.path === 'llm-repaired') return 'degraded'
  const key = authorship.model?.family ?? authorship.model?.id
  if (key === undefined) return 'degraded'
  return matchesCapableFamily(key) ? 'full' : 'degraded'
}
