import { z } from 'zod'
import ms from 'ms'
import { isCanonicalHookId } from '@vostride/agent-qa-ids'

const HookDurationString = z.string()
  .refine((v) => ms(v as ms.StringValue) !== undefined, {
    message: 'Invalid duration format (e.g., "30s", "2m", "1h")',
  })
  .transform((v) => ms(v as ms.StringValue) as number)

const HOOK_ID_MESSAGE = 'Hook ID must be h_ followed by 10 id-agent words'

export const HookDefinitionSchema = z.object({
  id: z.string().refine((value) => isCanonicalHookId(value), {
    message: HOOK_ID_MESSAGE,
  }),
  name: z.string().min(1),
  runtime: z.enum(['node', 'bun', 'python', 'bash']),
  file: z.string().min(1),
  deps: z.array(z.string()).optional().default([]),
  packageFile: z.string().optional(),
  timeout: HookDurationString,
  network: z.boolean().optional().default(true),
})

export const HooksFileSchema = z.object({
  hooks: z.array(HookDefinitionSchema),
}).superRefine((val, ctx) => {
  const ids = new Set<string>()
  const names = new Set<string>()
  for (let i = 0; i < val.hooks.length; i++) {
    if (ids.has(val.hooks[i].id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['hooks', i, 'id'],
        message: `Duplicate hook id: "${val.hooks[i].id}"`,
      })
    }
    if (names.has(val.hooks[i].name)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['hooks', i, 'name'],
        message: `Duplicate hook name: "${val.hooks[i].name}"`,
      })
    }
    ids.add(val.hooks[i].id)
    names.add(val.hooks[i].name)
  }
})

export type HooksFileConfig = z.infer<typeof HooksFileSchema>
