// What a REFERENCE looks like, stated positively.
//
// D-11 RATIFIED `set_auth` AS REFS-ONLY AS LAW: the committed configuration names WHERE a value
// lives — an auth state, a plugin package, an environment variable — and never holds one. 395-02
// enforced half of that with the SHAPE of the input DTO: `ConfigAuthSetInputSchema` has no field a
// credential could be assigned to. This file is the other half, and it exists because the first half
// is not enough: a model that wants to be helpful will put a bearer token in `pluginPackage`, and
// the field it arrived in says nothing about what it holds.
//
// THE RULE IS PHRASED OVER WHAT IT ADMITS, NEVER OVER WHAT IT REFUSES, and that is the whole design.
// The tempting implementation is a credential lexicon — "refuse anything that looks like an AWS key,
// a bearer token, a PEM block" — and this project has measured that shape failing twice under its
// own name: A RULE THAT CAN ONLY REFUSE WHAT IT CAN NAME CANNOT BE DRIVEN TO ZERO BY NAMING MORE
// THINGS. Every credential family nobody thought of walks through it. The rule below names nothing
// it refuses. It names what an auth-state name IS, what a package name IS, what an environment
// variable name IS — three small closed shapes the configuration schema already imposes — and
// refuses the complement. A credential family invented tomorrow is refused on the day it is invented
// unless it happens to be spelled like a reference, and THAT residue is a bound this phase records
// rather than a hole it pretends to have closed (see the KNOWN BOUND cell in `config-ops.test.ts`).
//
// THIS IS AN ADMISSION GATE, NOT THE ONLY GATE. Values that pass here still travel D-09's detector
// scan and the seeded known-secret half, and the artifact they end up in is scanned again before
// anything surfaces. The three do not overlap by accident: the shape rule refuses what a reference
// cannot be, the detector half refuses named credential families, and the seeded half refuses values
// the masker already knows — which is the only one of the three that catches a family nobody named.
//
// THE PATTERNS ARE RESTATED HERE ON `CONFIG_HOOK_RUNTIMES`' PRECEDENT, one file over: the config
// schema lives in `@vostride/agent-qa-core` and this package may not import a first-party package.
// `AUTH_STATE_SLUG_PATTERN` in `core/src/auth-state/schema.ts` is the same expression, deliberately.
// The layering makes the direction of any drift safe rather than merely unlikely: whole-config
// validation runs on every proposal, so a name this gate admits and `core` refuses becomes a
// schema-fail blocked record — a worse message, never a worse outcome.

/**
 * The reference kinds the config editor can be asked to write.
 *
 * a kind is added here when an op learns to write a new class of reference, together with
 * the shape the configuration schema already imposes on it. It is NOT a place to add a shape because
 * a value was refused: the question a new member answers is "what does this reference look like",
 * and if the answer is "anything", the field is not a reference and D-11 does not cover it.
 */
// no op writes an `auth-state-name` today — the three that did lost
// the field, because the committed configuration has no key for it. The kind and its shape stay: a
// member of a closed public set, matching `core`'s auth-state slug, for the op that next binds one.
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
