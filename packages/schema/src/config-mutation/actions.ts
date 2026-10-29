// `.strict()` is the security property: a model fills these inputs, so an unknown key is refused.

import { z } from 'zod'

import { CROSS_BOUNDARY_REASONS } from './constants'

// Copied from `core`'s `HookDefinitionSchema.runtime`, which this package may not import.
export const CONFIG_HOOK_RUNTIMES = ['node', 'bun', 'python', 'bash'] as const

export type ConfigHookRuntime = (typeof CONFIG_HOOK_RUNTIMES)[number]

// Matches `core`'s `TargetSchema.environment`; absent means undeclared, which is non-production.
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
  // The hostname gate runs before this op is reached.
  url: z.string().min(1),
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

// Refs only: every field names where a value lives, so no field can hold a secret.
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

// Any path, with no whitelist: validation of the whole config guards it, not a list of names.
export const ConfigFieldSetInputSchema = z.object({
  /** A dotted config path, e.g. `use.timeout` — split on `.` by the yaml Document mutation. */
  path: z.string().min(1),
  value: z.union([z.string(), z.number(), z.boolean()]),
}).strict()

export type ConfigFieldSetInput = z.infer<typeof ConfigFieldSetInputSchema>

// One field: a model picks only the domain, and host code derives the scheme, name and files.
export const ConfigProjectScaffoldInputSchema = z.object({
  // The bare domain from the utterance, e.g. `booking.com`; the hostname gate already ran.
  domain: z.string().min(1),
}).strict()

export type ConfigProjectScaffoldInput = z.infer<typeof ConfigProjectScaffoldInputSchema>

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

// Config operations write their change before they answer, in one call.

// The report names the issues and never the value; nothing is written or kept.
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

// `interrupted` rolls nothing back: written files are plain edits a person reverts with git.
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
