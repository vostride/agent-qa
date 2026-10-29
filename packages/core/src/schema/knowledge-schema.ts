import { z } from 'zod'

// A pure string predicate; composition roots resolve the path through `resolve-knowledge-root.ts`.
const isRepoRelative = (dir: string): boolean =>
  !/^[/\\]|^[A-Za-z]:[\\/]/.test(dir) && !/^\.\.(?:[/\\]|$)/.test(dir)

export const KnowledgeConfigSchema = z.object({
  dir: z.string().trim().min(1)
    .refine(isRepoRelative, {
      message: 'knowledge.dir must be repo-relative — the committed knowledge root must live inside the repo for PR review and the committed .gitignore split',
    })
    .default('agent-qa-knowledge'),
}).strict()
