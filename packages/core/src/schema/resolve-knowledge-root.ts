import path from 'node:path'

// `configDir` is the directory holding `agent-qa.config.yaml`.
export function resolveKnowledgeRoot(knowledge: { dir: string }, configDir: string): string {
  return path.resolve(configDir, knowledge.dir)
}
