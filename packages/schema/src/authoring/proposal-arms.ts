// Where an authored test is written, and the run-evidence coordinate vocabulary.
//
// the `test-draft` envelope arm this module was named for is deleted with
// the proposal inbox. An authored test that a keep-gate did not reject is written to its test path in
// the call that authored it, and the op answers which file it wrote (`TestFileWriteSchema`), so
// nothing waits for a person to accept it. What survives here is what that write and the run
// evidence still need: the target path derived from the draft shelf, and the evidence coordinates
// an authoring result carries. The module keeps its name so its history stays addressable.
//
// THE SUITE DIRECTORY IS NOT GUESSED, it is read off the shelf path (see `authoredSuiteTargetPath`).

import { z } from 'zod'

import { slugBranch } from '../ids/slug'

/**
 * How long a slugged test name may be before it is cut.
 *
 * raise it if real authored names are being truncated into collisions — the apply refuses
 * a target that already exists, so a collision costs a refusal rather than an overwrite, which is
 * the direction to fail in but not a direction to sit in. It may not become unbounded: this value
 * becomes a filename, and some filesystems still cap a component at 255 bytes.
 */
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

/**
 * Which durable record an evidence coordinate addresses.
 *
 * THE ONE CHANNEL VOCABULARY. The router builds these coordinates and `authoring.draft.write`'s
 * `stop` arm carries them, and the two are the same thing seen from either side of the
 * result — so the words are spelled here, in `schema`, and the router imports them. A second
 * spelling inside `agent` would be free to drift from the one a caller was answered with, which is
 * the drift a wire projection can never detect because both halves would parse.
 */
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
