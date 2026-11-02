import { z } from 'zod'

export const WorkspaceSchema = z.strictObject({
  testMatch: z.array(z.string().min(1)).min(1),
  suiteMatch: z.array(z.string().min(1)).min(1),
  testPathIgnore: z.array(z.string()).optional(),
  hooksFile: z.string().min(1, 'hooksFile is required.'),
  envFile: z.string().min(1, 'envFile is required.'),
  secretsFile: z.string().min(1, 'secretsFile is required.'),
})
