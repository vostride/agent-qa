// A leaf module, so planner-tools and turn-engine read one value without an import cycle.

import { AUTHORING_DRAFT_WRITE_FUNCTION_ID } from '../functions/ops/authoring-draft-write.js'
import { AUTHORING_DRAFT_VERIFY_FUNCTION_ID } from '../functions/ops/authoring-verify-draft.js'
import { AUTHORING_FUNNEL_GET_FUNCTION_ID } from '../functions/ops/authoring-funnel-get.js'

// A set, compared with every registry op carrying `sessionRef`, so a new one cannot go unguarded.
export const SESSION_STAMPED_FUNCTION_IDS: ReadonlySet<string> = new Set([
  AUTHORING_DRAFT_WRITE_FUNCTION_ID,
  AUTHORING_DRAFT_VERIFY_FUNCTION_ID,
])

/** The ops whose `window` this surface may scope to the session it knows. */
export const WINDOW_STAMPED_FUNCTION_IDS: ReadonlySet<string> = new Set([
  AUTHORING_FUNNEL_GET_FUNCTION_ID,
])

// Not a stamp: the op derives `scope` when absent, and these ids tell the model who fills it.
export const HOST_DERIVED_SCOPE_FUNCTION_IDS: ReadonlySet<string> = new Set([
  AUTHORING_DRAFT_WRITE_FUNCTION_ID,
])
