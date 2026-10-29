import { z } from 'zod'

import { slugBranch } from '../ids/slug'

declare const runIdBrand: unique symbol

export type RunId = string & { readonly [runIdBrand]: 'RunId' }

export const asRunId = (value: string): RunId => value as RunId

/**
 * THE run-id codec. One declaration, four call sites.
 *
 * WHAT IT REFUSES, AND WHY SCHEMA IS ALLOWED TO. A run id BECOMES A DIRECTORY NAME:
 * `<configDir>/.agent-qa/runs/<slugBranch(runId)>/` is where a run's `events.jsonl`, its
 * `handoff.json` and its audit rows live. Path-safety on the value that names that directory is
 * therefore a property of the id itself, and it is judgeable without leaving this package.
 *
 * THE PREDICATE IS `slugBranch` — NOT A SECOND SPELLING OF ITS RULES. The one security-reviewed
 * path-segment sanitizer already lives here (`ids/slug.ts`), and the run directory is derived
 * through it. So the rule this codec states is exactly: *an id the path layer would have to
 * REWRITE is refused rather than rewritten*. Re-deriving "separators, `..`, control characters"
 * as a regex here would be a second copy of that file's rules, free to disagree with it the day
 * either one changes — and it is a disagreement between those two that a traversal defect is made
 * of. Empty falls out of the same clause: `slugBranch('')` is `'default'`, which is precisely the
 * rewrite this refuses (measured pre-fix: an empty caller-supplied id ran a whole run into a
 * shared `runs/default/` directory).
 *
 * IT IS DELIBERATELY NOT THE CANONICAL ID SHAPE. `r_`-prefixed ten-word ids are
 * `@vostride/agent-qa-ids`' vocabulary; this package has zero internal dependencies and may not
 * name it, and re-spelling `isCanonicalRunId` here would be a second definition of a run's
 * identity. "Is this an id this system would have minted" is asked in the invocation core, where
 * the canonical predicate can be injected from the package that owns it.
 */
export const runIdSchema = z
  .string()
  .refine((value) => slugBranch(value) === value, {
    message:
      'a run id must be usable, exactly as written, as the name of the run\'s own directory: '
      + 'it may not be empty, and may not carry path separators, parent-directory segments or '
      + 'control characters',
  })
  .transform(asRunId)
