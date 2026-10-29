import path from 'node:path'

/**
 * Resolve the repo-relative directory validated by KnowledgeConfigSchema. `configDir` is the
 * directory containing agent-qa.config.yaml (the repository root by the committed-root
 * convention). Composition roots call this helper; Phase 374 has no live producer, so the first
 * runtime caller is Phase 378's Curator binding.
 */
export function resolveKnowledgeRoot(knowledge: { dir: string }, configDir: string): string {
  return path.resolve(configDir, knowledge.dir)
}
