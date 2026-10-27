// The two closed vocabularies D-02 and D-03 bound (Phase 395, CFGM-01 / CFGM-02).
//
// PINNED CONSTANTS, NEVER CONFIGURATION (386 D-15). Both values below are JUDGEMENTS about what a
// person must be asked about before a machine edits their repository, and a judgement a project can
// switch off is not a guard — it is a default. They live in `schema` because the classifier that
// reads them (395-04), the surfaces that render their consequences, and the grant machinery that
// refuses on them are three packages, and three spellings of one vocabulary is the sibling-input
// failure this project keeps rediscovering.
//
// EACH CONSTANT CARRIES A RETUNE COMMENT stating the judgement and naming who owns changing it,
// because a pinned value with no stated owner is a value the next person guesses at.

/**
 * The named classes of "this crosses a boundary a standing approval may not cover" (D-02).
 *
 * CLOSED AT THE CLASSES D-02 BOUNDS, and closed is the point. Cross-boundary-ness is computed per
 * VALUE — a base URL edited to point at a new origin is cross-boundary, the same edit to the same
 * origin is not — so what is pinned here is the set of REASONS a classifier may give, never a map
 * from ops to answers. A static per-op map could not see the origin change at all, which is why
 * D-02 put the flag on the proposal.
 *
 * The members, and what each one is a fact about:
 *
 *   secret-adjacent-field — the edited path is at or under {@link SECRET_ADJACENT_CONFIG_FIELDS}.
 *   new-origin            — a URL value whose scheme/host/port differ from the one it replaces.
 *   hook-added            — a hook is code this project will EXECUTE; adding one is not a setting.
 *   out-of-set-path       — the change writes a file outside the enumerated config file set.
 *
 * RETUNE: adding a fifth member, or removing one, is a decision about what a person is asked to
 * look at, made with the case that showed it. Do not widen this by pattern; the classifier's job is
 * to produce one of these words or nothing.
 */
export const CROSS_BOUNDARY_REASONS = [
  'secret-adjacent-field',
  'new-origin',
  'hook-added',
  'out-of-set-path',
] as const

export type CrossBoundaryReason = (typeof CROSS_BOUNDARY_REASONS)[number]

/**
 * The config paths whose edit is secret-adjacent, as SUBTREE ROOTS rather than as leaves.
 *
 * ROOTS, NOT LEAVES, AND THAT IS THE ANTI-DOOR-ENUMERATION HALF. D-03 removed the settable-field
 * whitelist because a rule that can only refuse what it can NAME cannot be driven to zero by naming
 * more things. The same reasoning applies here in the other direction: this list names the ROOT of
 * each region, and everything under a root is secret-adjacent whether or not anybody enumerated it,
 * so a key added to the auth plugin declaration next year is covered on the day it is added.
 *
 * A `*` segment matches exactly one path segment — the record keys (target names, plugin indices)
 * that the config schema itself leaves open.
 *
 * Each entry, and why it is here:
 *
 *   workspace.envFile           — names the file the environment values are read from; repointing
 *                                 it changes which values resolve into a run.
 *   workspace.secretsFile       — names the untracked secrets file; same argument, one step closer.
 *   services.authState          — the directory captured auth state (session cookies, bearer
 *                                 tokens) is written to and loaded from.
 *   plugins.auth                — declares the plugin that RESOLVES credentials; it loads in-process.
 *   plugins.providers           — provider plugins load in-process with full host access and carry
 *                                 provider credentials.
 *   registry.providers          — device-farm provider entries; the shape whose fields are a
 *                                 username and an access key.
 *   registry.targets.*.authState — binds one target to a stored auth state, i.e. decides which
 *                                 identity a run acts as.
 *   use.authState               — the SAME fact, at the path the committed configuration actually
 *                                 spells it (395-05, added with the field that showed it).
 *
 * `use.authState` WAS MISSING, AND FINDING OUT WHY IS WORTH THE PARAGRAPH. 395-02 listed
 * `registry.targets.*.authState` from `WebPlatformConfig`, which is the RESOLVED platform
 * configuration a run computes — `core`'s `TargetSchema` is `.strict()` and has no `authState` key,
 * so nothing can ever be committed at that path. The committed configuration binds an auth state at
 * `use.authState` (`AuthStateUseSchema`: a name, or `{ name, load, capture }`), and that path was
 * unflagged: every op that binds an identity would have produced an unflagged proposal a standing
 * grant could cover. The listed root is KEPT rather than corrected away — this list may not shrink to
 * make a proposal grantable, and a root that matches nothing costs nothing — but the reason it was
 * wrong is recorded here so the next reader does not read a resolved-config path as a committed one.
 *
 * RETUNE: this list is owned by whoever owns D-02/D-03 — a phase that finds a secret-bearing region
 * of the config schema these roots do not cover adds the ROOT, with the field that showed it. It may
 * not shrink to make a proposal grantable: a value here being flagged is the whole reason the
 * standing-grant refusal has anything to refuse. It is deliberately not derived from the config
 * schema by pattern (a name-matching heuristic over field names is exactly the enumeration this
 * avoids); it is a short list of places, stated once.
 */
export const SECRET_ADJACENT_CONFIG_FIELDS = [
  'workspace.envFile',
  'workspace.secretsFile',
  'services.authState',
  'plugins.auth',
  'plugins.providers',
  'registry.providers',
  'registry.targets.*.authState',
  'use.authState',
] as const

export type SecretAdjacentConfigField = (typeof SECRET_ADJACENT_CONFIG_FIELDS)[number]

/**
 * Does an edit at this dotted config path reach one of the secret-adjacent roots?
 *
 * SHIPPED BESIDE THE CONSTANT because the rule below is not obvious from the strings, and a caller
 * that re-derived it would be the second spelling of a judgement the file header says must have
 * exactly one. 395-04's classifier calls this; so does anything that wants to explain a flag.
 *
 * IT MATCHES IN BOTH DIRECTIONS, and the second one is the half that is easy to miss. A path AT or
 * UNDER a root is the obvious case: `plugins.auth.0.package` is inside `plugins.auth`. But a path
 * ABOVE a root reaches it too — `config.field.set` at `plugins` REPLACES the whole subtree,
 * including the auth declarations, so an ancestor edit is a secret-adjacent edit even though the
 * path a person typed does not appear on the list. A matcher that only walked downwards would let
 * the widest possible edit through as unflagged, which is the reverse of the risk ordering.
 */
export function isSecretAdjacentConfigField(path: string): boolean {
  const segments = path.split('.')
  return SECRET_ADJACENT_CONFIG_FIELDS.some((root) => {
    const rootSegments = root.split('.')
    const shared = Math.min(segments.length, rootSegments.length)
    for (let index = 0; index < shared; index++) {
      if (rootSegments[index] === '*') continue
      if (rootSegments[index] !== segments[index]) return false
    }
    return true
  })
}
