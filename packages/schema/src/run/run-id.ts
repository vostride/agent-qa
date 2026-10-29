import { z } from 'zod'

import { slugBranch } from '../ids/slug'

declare const runIdBrand: unique symbol

export type RunId = string & { readonly [runIdBrand]: 'RunId' }

export const asRunId = (value: string): RunId => value as RunId

// Refuses any id `slugBranch` would rewrite, because the run id names its directory on disk.
export const runIdSchema = z
  .string()
  .refine((value) => slugBranch(value) === value, {
    message:
      'a run id must be usable, exactly as written, as the name of the run\'s own directory: '
      + 'it may not be empty, and may not carry path separators, parent-directory segments or '
      + 'control characters',
  })
  .transform(asRunId)
