// The suite directory is read off the shelf path, never guessed.

import { z } from 'zod'

import { slugBranch } from '../ids/slug'

// Becomes a filename, so it stays bounded: some filesystems cap a name at 255 bytes.
export const AUTHORED_SUITE_SLUG_MAX_LENGTH = 60

/** The name a draft whose test name slugs to nothing at all is filed under. */
const AUTHORED_SUITE_FALLBACK_SLUG = 'authored-test'

/**
 * Where an accepted draft is written, derived from where its DRAFT already lives.
 *
 * THE SUITE DIRECTORY IS NOT GUESSED, it is read off the shelf path. A draft is staged at
 * `<suiteDir>/<shelfDir>/<digest>.yaml`, so walking two segments up recovers the directory this
 * project's `workspace.testMatch` actually admits — and a project whose tests live under `e2e/`
 * gets `e2e/<slug>.yaml` without this function knowing that any such project exists. A hardcoded
 * `tests/` here would be a second spelling of a CONFIGURABLE fact, and the first project to
 * configure it differently would have every accepted draft written somewhere its own suite
 * discovery cannot see.
 *
 * The slug goes through {@link slugBranch}, which is the ONE security-reviewed path-segment
 * sanitizer — a model-authored test name reaches this function, so the value that becomes a
 * filename must not be able to name a separator, a parent directory or a hidden file.
 */
export function authoredSuiteTargetPath(draftShelfPath: string, testName: string): string {
  const segments = draftShelfPath.split('/').filter((segment) => segment.length > 0)
  const suiteDirectory = segments.slice(0, Math.max(segments.length - 2, 0)).join('/')
  const slug = slugBranch(testName)
    .toLowerCase()
    .slice(0, AUTHORED_SUITE_SLUG_MAX_LENGTH)
    .replace(/[.\-]+$/, '')
  const name = `${slug.length > 0 ? slug : AUTHORED_SUITE_FALLBACK_SLUG}.yaml`
  return suiteDirectory.length > 0 ? `${suiteDirectory}/${name}` : name
}

// Spelled here because the router builds these and `authoring.draft.write` returns them.
export const RUN_EVIDENCE_CHANNELS = ['step-trace', 'state-before', 'state-after'] as const

export type RunEvidenceChannel = (typeof RUN_EVIDENCE_CHANNELS)[number]

/**
 * A COORDINATE into a run's own durable records. Never a payload.
 *
 * `.strict()` is the refusal surface: a screen state, an element tree or a rendered snapshot
 * copied onto a stop payload fails to parse here rather than becoming a durable record nobody meant
 * to write. The key set is additionally pinned by equality in `router.test-d.ts`.
 */
export const RunEvidenceRefSchema = z.object({
  runId: z.string().min(1),
  filePath: z.string().min(1),
  testName: z.string().min(1),
  stepIndex: z.number().int().nonnegative(),
  /** Absent on the `step-trace` channel, which addresses the whole step. */
  subActionIndex: z.number().int().nonnegative().optional(),
  channel: z.enum(RUN_EVIDENCE_CHANNELS),
}).strict()

export type RunEvidenceRef = z.infer<typeof RunEvidenceRefSchema>
