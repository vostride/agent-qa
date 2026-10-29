// Admits only reference shapes and refuses the rest; a credential lexicon misses unnamed families.

// No op writes an `auth-state-name`; the kind stays as a member of a closed public set.
export const CONFIG_REFERENCE_KINDS = [
  'auth-state-name',
  'plugin-package',
  'env-var-name',
] as const

export type ConfigReferenceKind = (typeof CONFIG_REFERENCE_KINDS)[number]

/**
 * The admitted shape of each kind.
 *
 * `auth-state-name` — `core`'s `AUTH_STATE_SLUG_PATTERN`, which `TargetNameSchema` and
 *   `AuthStateNameSchema` both are. Lowercase letters, digits and hyphens, starting with a letter
 *   and ending with a letter or digit. No uppercase, no underscore, no dot, no slash, no `=`, no
 *   whitespace — which is most of what a credential encoding needs.
 * `plugin-package` — an npm package name, optionally scoped. Lowercase by npm's own rule since 2017.
 * `env-var-name` — the POSIX-portable shape a shell will export. Deliberately the LOOSEST of the
 *   three, and the one whose residue the recorded bound is about.
 */
const REFERENCE_SHAPES: Readonly<Record<ConfigReferenceKind, RegExp>> = {
  'auth-state-name': /^[a-z][a-z0-9-]*[a-z0-9]$/,
  'plugin-package': /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/,
  'env-var-name': /^[A-Za-z_][A-Za-z0-9_]*$/,
}

/**
 * The longest a reference of any kind may be.
 *
 * A LENGTH BOUND IS PART OF THE SHAPE, not a separate defence. npm's own limit is 214 characters and
 * an auth-state name is a path segment; nothing legitimate approaches either. A long value that also
 * satisfies one of the character classes above is the shape a base64 or hex-encoded secret takes,
 * and 214 is short enough to refuse the ones that are while being longer than any real name.
 */
export const MAX_CONFIG_REFERENCE_LENGTH = 214

/**
 * Is this value shaped like a reference of this kind?
 *
 * ONE FUNCTION, EVERY CALLER. The ops that write references ask this rather than each carrying its
 * own idea of the shape, because three spellings of one judgement is the sibling-input failure this
 * project keeps rediscovering. The check is keyed on the reference KIND,
 * so an op added later that writes an auth-state name inherits the refusal by naming the kind.
 */
export function isLegalConfigReference(kind: ConfigReferenceKind, value: string): boolean {
  if (value.length === 0 || value.length > MAX_CONFIG_REFERENCE_LENGTH) return false
  return REFERENCE_SHAPES[kind].test(value)
}
