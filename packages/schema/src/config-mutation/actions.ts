// The closed action class, as input DTOs (Phase 395, D-01 / D-11 / D-13 · CFGM-01, CFGM-05).
//
// ONE DTO PER OP, NAMED FOR ITS OP ID, MINTED HERE (384 D-16). The registry op that carries each of
// these lives in `packages/agent`, the MCP projection that will publish them lives in 396, and the
// parity walk that enumerates them lives in 397 — three consumers, so the shapes live in `schema`
// where none of them owns the vocabulary. A per-op sibling shape would be three spellings whose
// disagreement is only visible at runtime.
//
// EVERY SCHEMA IS `.strict()`, AND THAT IS THE SECURITY PROPERTY RATHER THAN A STYLE. These inputs
// are filled by a language model, so an unrecognised key is not a typo to forgive: it is either a
// hallucinated field the op would silently ignore, or an attempt to smuggle a value past the shape
// the guard reasons about. `.strict()` makes both a refusal at the boundary.
//
// `ConfigAuthSetInputSchema` IS THE ONE TO READ TWICE. D-11 ratified set_auth as REFS-ONLY as law:
// it writes the NAME of an auth state, the NAME of a plugin package, the NAME of an environment
// variable — never a credential. That is enforced here by the absence of any field a credential
// could be assigned to, which is a property of the shape rather than a rule somebody remembers, and
// `__tests__/proposal.test.ts` enumerates the keyset so adding one would be a visible edit. The
// behavioural half — a value in one of the REFERENCE fields that is not shaped like a reference is
// refused `refs-only` at construction — is defence in depth on top of this, not instead of it.

import { z } from 'zod'

import { CROSS_BOUNDARY_REASONS } from './constants'

/**
 * The runtimes a hook may declare.
 *
 * SPELLED HERE rather than imported because the hooks file schema lives in `@vostride/agent-qa-core`
 * and this package may not import a first-party package (its package-class boundary). The words are
 * identical to `core`'s `HookDefinitionSchema.runtime` on purpose: a reader comparing them is
 * comparing one vocabulary seen from two layers, and a proposal that offered a fifth runtime would
 * be refused by the whole-file validation this phase runs before anything surfaces (CFGM-01).
 */
export const CONFIG_HOOK_RUNTIMES = ['node', 'bun', 'python', 'bash'] as const

export type ConfigHookRuntime = (typeof CONFIG_HOOK_RUNTIMES)[number]

/**
 * The classes a target may declare at creation (432 D-19).
 *
 * Spelled here for the reason {@link CONFIG_HOOK_RUNTIMES} is: the words match `core`'s
 * `TargetSchema.environment`, and whole-config validation refuses any drift before the change is
 * written. Absent means undeclared, which is non-production (D-18).
 */
export const CONFIG_TARGET_ENVIRONMENTS = ['local', 'shared', 'production'] as const

export type ConfigTargetEnvironment = (typeof CONFIG_TARGET_ENVIRONMENTS)[number]

/**
 * `config.target.create` — add a web target to `registry.targets`.
 *
 * `platform` IS A LITERAL, NOT AN ENUM OF THREE. The mobile platforms need a device profile, an app
 * package or a bundle id and a running Appium — facts a chat utterance does not carry and this
 * phase's scaffold cannot derive. A target class this op cannot honestly build is better refused by
 * the type than half-built by the op.
 */
export const ConfigTargetCreateInputSchema = z.object({
  /** The registry key. Also what a test's `target:` names. */
  name: z.string().min(1),
  platform: z.literal('web'),
  /** The base URL, absolute. D-15's hostname gate runs before this op is reached. */
  url: z.string().min(1),
  // 2026-10-02 (quick 261002-ctr): no `authStateName`. See `ConfigAuthSetInputSchema`.
  /** A label for the target's environment. Omitted means undeclared. */
  environment: z.enum(CONFIG_TARGET_ENVIRONMENTS).optional(),
}).strict()

export type ConfigTargetCreateInput = z.infer<typeof ConfigTargetCreateInputSchema>

/**
 * `config.target.edit` — change an existing target's URL.
 *
 * THE CHANGES ARE NESTED rather than flattened beside `name`, so "which target" and "what about it"
 * cannot be confused by a model filling the shape, and so an empty `changes` object is a
 * distinguishable input rather than an edit of nothing that looks like an edit of everything.
 * `platform` is absent deliberately: changing a target's platform is creating a different target.
 */
export const ConfigTargetEditInputSchema = z.object({
  name: z.string().min(1),
  changes: z.object({
    url: z.string().min(1).optional(),
  }).strict(),
}).strict()

export type ConfigTargetEditInput = z.infer<typeof ConfigTargetEditInputSchema>

/**
 * `config.auth.set` — declare an auth plugin for a target, or ask where an environment variable goes.
 *
 * REFS ONLY, AND THERE IS NO FIELD TO PUT A SECRET IN (D-11, ratified as law). Every field below
 * names WHERE a value lives; none of them holds one. The committed configuration therefore stays
 * secret-free by construction, which is what makes masking-at-resolution sound — a masker can only
 * mask values it can see, and the reason it can see all of them is that they never enter this file.
 *
 * 2026-10-02 (quick 261002-ctr): NO `authStateName`, here or on `config.target.create` /
 * `config.target.edit`. The three ops wrote it to `use.authState`, and the committed configuration
 * has no such key: `core`'s `UseSchema` and `TargetSchema` are both `.strict()` without one, so
 * whole-config validation answered every such call `blocked / schema-fail`. An auth state is bound
 * where the schema accepts it, in a test's or a suite's own `use.authState`.
 */
export const ConfigAuthSetInputSchema = z.object({
  /** Which target this auth applies to, by registry name. */
  target: z.string().min(1),
  /** The NAME of an auth plugin package to declare under `plugins.auth`. */
  pluginPackage: z.string().min(1).optional(),
  /** The NAME of an environment variable the plugin reads. Never its value. */
  envVarName: z.string().min(1).optional(),
}).strict()

export type ConfigAuthSetInput = z.infer<typeof ConfigAuthSetInputSchema>

/**
 * `config.hook.add` — declare a hook in the hooks file.
 *
 * A HOOK IS CODE THIS PROJECT WILL RUN, which is why `hook-added` is one of the four cross-boundary
 * reasons and why this input names a FILE rather than carrying a body: the script is a thing a
 * person writes and reviews in their editor, and a proposal that carried executable text would be
 * asking for approval of two artifacts in one decision.
 */
export const ConfigHookAddInputSchema = z.object({
  /** The human-facing hook name; the hook id is minted host-side. */
  name: z.string().min(1),
  runtime: z.enum(CONFIG_HOOK_RUNTIMES),
  /** Workspace-relative path to the script. */
  file: z.string().min(1),
  /** A duration string as the hooks file spells them, e.g. `30s`. Host default when absent. */
  timeout: z.string().min(1).optional(),
  network: z.boolean().optional(),
}).strict()

export type ConfigHookAddInput = z.infer<typeof ConfigHookAddInputSchema>

/**
 * `config.field.set` — set any schema-addressable path (D-03).
 *
 * ANY PATH, and the absence of a settable-field whitelist is the decision rather than an omission —
 * a whitelist is the door-enumeration failure this project has measured twice: a rule that can only
 * refuse what it can NAME cannot be driven to zero by naming more things. The guards here are
 * whole-input by construction instead: post-mutation validation of the ENTIRE config (CFGM-01) for
 * correctness, and D-02's per-value classifier for safety.
 *
 * Relocated from `proposal.ts` by 395-02 so the seven action inputs are one file a reader can read
 * as the closed class it is. The shape is byte-unchanged.
 */
export const ConfigFieldSetInputSchema = z.object({
  /** A dotted config path, e.g. `use.timeout` — split on `.` by the yaml Document mutation. */
  path: z.string().min(1),
  value: z.union([z.string(), z.number(), z.boolean()]),
}).strict()

export type ConfigFieldSetInput = z.infer<typeof ConfigFieldSetInputSchema>

/**
 * `config.project.scaffold` — configure a project from zero (D-13, CFGM-05).
 *
 * ONE FIELD, AND THE MODEL FILLS ONLY THAT ONE. D-13 is explicit: the LLM picks the DOMAIN token
 * from the utterance and deterministic host code derives everything else — the scheme, the target
 * name, the file set. Every field this shape does not have is a field a model could otherwise
 * invent, and `booking.com` versus `booking.de` is a coin flip review should not have to catch.
 */
export const ConfigProjectScaffoldInputSchema = z.object({
  /** The bare domain from the utterance, e.g. `booking.com`. D-15's hostname gate ran already. */
  domain: z.string().min(1),
}).strict()

export type ConfigProjectScaffoldInput = z.infer<typeof ConfigProjectScaffoldInputSchema>

// 2026-10-01, 432-17 (D-05/D-07/D-09): `config.undo.propose` and `config.proposal.apply` are deleted
// with the proposal inbox, and so are their inputs and the git-commit apply receipts. A change is
// written in its own call and reverted with git (D-07); there is no undo op (D-09).

/** How one file of a config change is written: added, replaced, or removed. */
export const CONFIG_FILE_CHANGE_KINDS = ['add', 'modify', 'delete'] as const

export type ConfigFileChangeKind = (typeof CONFIG_FILE_CHANGE_KINDS)[number]

/**
 * One file a config change writes: its workspace-relative path, the kind of write, the digest of
 * the bytes the change was computed against (absent for an add), and the new bytes. The writer
 * refuses when the file no longer holds the bytes `baseDigest` names, so a change never lands over
 * an edit it did not see.
 */
export const ConfigChangeFileSchema = z.object({
  path: z.string().min(1),
  changeKind: z.enum(CONFIG_FILE_CHANGE_KINDS),
  baseDigest: z.string().min(1).optional(),
  newContentBase64: z.string(),
}).strict()

export type ConfigChangeFile = z.infer<typeof ConfigChangeFileSchema>

// ---- 2026-09-30, 432-11 D-05/D-07: what a config change did, answered in the call ------------------
//
// The six config operations write their change before they answer. There is no proposal, no
// inbox record and no second call to apply it: the answer is either what was written, a refusal
// that wrote nothing, or an interruption that names exactly the files already written.

/**
 * Why a change was blocked: the resulting configuration would not validate. The report names the
 * issues and never the value. Nothing is written or kept. A config change is not scanned for
 * secrets (441 D-15).
 */
export const CONFIG_BLOCKED_REASONS = ['schema-fail'] as const

export type ConfigBlockedReason = (typeof CONFIG_BLOCKED_REASONS)[number]

/**
 * Why a config change was refused with nothing written.
 *
 * The first seven are facts about the request, decided before any file is touched:
 *
 *   target-exists         — a create names a target the registry already holds; a create never
 *                           replaces one.
 *   target-not-found      — an edit or an auth binding names a target that is not configured; the
 *                           refusal lists the configured names.
 *   refs-only             — the input carried something that is not a reference (a credential);
 *                           the value is never quoted.
 *   unsupported-reference — a legal reference this configuration has nowhere to record.
 *   not-a-hostname        — the scaffold's token does not parse as a hostname.
 *   already-configured    — the scaffold would replace targets the project already declares.
 *   unrenderable-diff     — the change's bytes differ but render as nothing a person could read.
 *
 * The last three are facts about the files at the moment of writing:
 *
 *   file-changed          — a whole file differs from the bytes the change was built from.
 *   field-changed         — a field the change depends on changed since the call read it (a
 *                           target created meanwhile under the same name).
 *   write-refused         — the config transaction refused the change on the file as it now
 *                           stands (it no longer validates, parses or resolves).
 */
export const CONFIG_CHANGE_REFUSAL_REASONS = [
  'target-exists',
  'target-not-found',
  'refs-only',
  'unsupported-reference',
  'not-a-hostname',
  'already-configured',
  'unrenderable-diff',
  'file-changed',
  'field-changed',
  'write-refused',
] as const

export type ConfigChangeRefusalReason = (typeof CONFIG_CHANGE_REFUSAL_REASONS)[number]

/**
 * What one config operation did, answered after it wrote (432-11 D-05/D-07).
 *
 *   applied     — the change is on disk. `files` are the workspace-relative files written, in write
 *                 order; `fields` are the config fields the change set; `shownDiff` is the diff of
 *                 the change against the files as this call read them. An outside edit to another
 *                 field, merged in the write's own turn, is kept and is not part of this diff.
 *   blocked     — the change would not validate. It carries the report and never the change;
 *                 nothing was written and nothing was kept.
 *   no-change   — the configuration already holds the value.
 *   refused     — the request or the files at write time refused the change; nothing was written.
 *   interrupted — a multi-file change stopped part way. `written` hold their new bytes, `failed`
 *                 did not, `unwritten` were never reached. Nothing is rolled back: the files are
 *                 plain edits a person reverts with git.
 */
export const ConfigChangeOutputSchema = z.discriminatedUnion('outcome', [
  z.object({
    outcome: z.literal('applied'),
    summaryLine: z.string().min(1),
    files: z.array(z.string().min(1)).min(1),
    fields: z.array(z.string().min(1)).min(1),
    /** Whether the change adds a hook, a new origin, a secret-adjacent field or an out-of-set file. */
    crossBoundary: z.boolean(),
    crossBoundaryReasons: z.array(z.enum(CROSS_BOUNDARY_REASONS)),
    shownDiff: z.string().min(1),
  }).strict(),
  z.object({
    outcome: z.literal('blocked'),
    /** What was attempted, never what was found. */
    summaryLine: z.string().min(1),
    blockedReason: z.enum(CONFIG_BLOCKED_REASONS),
    paths: z.array(z.string().min(1)).min(1),
    /** Whole-config validation issues, in the validator's own words, reduced to position for YAML. */
    validationIssues: z.array(z.string().min(1)).optional(),
  }).strict(),
  z.object({ outcome: z.literal('no-change'), path: z.string().min(1) }).strict(),
  z.object({
    outcome: z.literal('refused'),
    reason: z.enum(CONFIG_CHANGE_REFUSAL_REASONS),
    /** What was refused and what to do instead. Names fields and files, never a value. */
    detail: z.string().min(1),
    /** The configured names a caller could have meant. */
    candidates: z.array(z.string().min(1)).optional(),
  }).strict(),
  z.object({
    outcome: z.literal('interrupted'),
    summaryLine: z.string().min(1),
    written: z.array(z.string().min(1)),
    failed: z.object({
      path: z.string().min(1),
      reason: z.enum(['file-changed', 'write-failed']),
    }).strict(),
    unwritten: z.array(z.string().min(1)),
    detail: z.string().min(1),
  }).strict(),
])

export type ConfigChangeOutput = z.infer<typeof ConfigChangeOutputSchema>
