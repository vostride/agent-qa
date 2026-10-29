// D-13 judge family identity map. This is an IDENTITY table, deliberately separate from
// model's capability family-table (capability ≠ identity): the mechanics mirror that module
// without importing it, because eval core must stay provider-neutral and an identity law
// must not drift with capability tuning. Family resolves from model-id TOKENS ONLY — a
// ModelProfile.provider value is a transport id ('openai-compatible' serves Llama, Qwen,
// and DeepSeek alike) and can never establish family. Unknown resolves to undefined, which
// downstream eligibility treats as same-family and therefore forbidden — never a guess.

/** Closed coarse family-name union — gpt and the o-series are ONE openai family. */
export type JudgeFamily =
  | 'claude'
  | 'openai'
  | 'gemini'
  | 'llama'
  | 'qwen'
  | 'deepseek'
  | 'mistral'

/**
 * Conservative model-id-token seeds per family. Unsure tokens are omitted on purpose:
 * unknown ⇒ undefined ⇒ forbidden is the safe default. The map is embedded in
 * JUDGE_CONFIG so any edit here is covered by the pinned-hash bump guard.
 */
export const JUDGE_FAMILY_MAP: Readonly<Record<JudgeFamily, readonly string[]>> = Object.freeze({
  claude: Object.freeze(['claude']),
  openai: Object.freeze(['gpt', 'o1', 'o3', 'o4']),
  gemini: Object.freeze(['gemini']),
  llama: Object.freeze(['llama', 'llama3']),
  qwen: Object.freeze(['qwen']),
  deepseek: Object.freeze(['deepseek']),
  mistral: Object.freeze(['mistral', 'mixtral', 'pixtral']),
})

const BOUNDARIES = new Set(['-', '_', '.', '/', ':'])

/** Additive lineage only: these overrides can forbid more models, never permit more. */
export const JUDGE_LINEAGE_OVERRIDES: readonly {
  token: string
  families: readonly JudgeFamily[]
}[] = Object.freeze([
  Object.freeze({ token: 'deepseek-r1-distill-llama', families: Object.freeze(['deepseek', 'llama'] as const) }),
  Object.freeze({ token: 'deepseek-r1-distill-qwen', families: Object.freeze(['deepseek', 'qwen'] as const) }),
])

function matchesAtBoundary(id: string, token: string): boolean {
  let from = 0
  for (;;) {
    const idx = id.indexOf(token, from)
    if (idx === -1) return false
    if (idx === 0 || BOUNDARIES.has(id[idx - 1])) return true
    from = idx + 1
  }
}

/**
 * Resolve a model id to its judge family: lowercase the id, walk every family's tokens with
 * boundary-anchored matching, longest-matching-token-wins across ALL families. Returns
 * undefined when nothing matches — unknown is forbidden downstream, never guessed.
 */
export function resolveJudgeFamily(modelId: string): JudgeFamily | undefined {
  const id = modelId.toLowerCase()
  let best: { length: number; family: JudgeFamily } | undefined

  for (const family of Object.keys(JUDGE_FAMILY_MAP) as JudgeFamily[]) {
    for (const token of JUDGE_FAMILY_MAP[family]) {
      if (!matchesAtBoundary(id, token)) continue
      if (!best || token.length > best.length) {
        best = { length: token.length, family }
      }
    }
  }

  return best?.family
}

/** The base longest-token identity union every matching forbidding lineage override. */
export function resolveJudgeFamilies(modelId: string): ReadonlySet<JudgeFamily> {
  const base = resolveJudgeFamily(modelId)
  const families = new Set<JudgeFamily>(base === undefined ? [] : [base])
  for (const override of JUDGE_LINEAGE_OVERRIDES) {
    if (matchesAtBoundary(modelId.toLowerCase(), override.token)) {
      for (const family of override.families) families.add(family)
    }
  }
  return families
}

export function judgeFamiliesIntersect(a: ReadonlySet<JudgeFamily>, b: ReadonlySet<JudgeFamily>): boolean {
  return [...a].some(family => b.has(family))
}

export function displayJudgeFamilies(families: ReadonlySet<JudgeFamily>): string | undefined {
  return families.size === 0 ? undefined : [...families].sort().join(',')
}
