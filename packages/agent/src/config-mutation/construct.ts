// The config change construction pipeline (Phase 395, CFGM-01 / CFGM-02 / CFGM-04 · D-01 / D-03 /
// D-09 / D-10 / D-11 / D-12 / D-17).
//
// THE SIX CONFIG OPERATIONS WRITE IN THE CALL. Step 7 below is now a
// publication through the direct writer (`configWrite`): field changes through the config
// transaction, whole files over the digest they were built from. A blocked change is answered as a
// refusal carrying its report, and nothing is filed or written. Nothing here runs git.
// `config.undo.propose` and the proposal filing it alone still used
// are deleted with the proposal inbox; a written change is reverted with git.
//
// SEVEN STEPS IN ONE ORDER, AND THE ORDER IS THE CONTRACT:
//
//   1. RE-READ the committed files. CFGM-04's proposal-time law, and it is the first step rather
//      than an optimisation: every digest this proposal records is a claim about what was on disk
//      at the moment the proposal was made, so reading anything cached would make the apply's
//      re-check compare against a file nobody looked at.
//   2. MUTATE, comment-preservingly, through the host's yaml Document port. A parse→object→stringify
//      round trip destroys every comment in the house-style config and widens the rendered diff past
//      the point a person can review it, which is CFGM-01's whole subject.
//   3. RENDER the diff and take the digests, through the ONE schema primitive. Construction
//      and apply call the same export; that is the whole of the CR-02 mitigation.
//   4. VALIDATE THE WHOLE CANDIDATE SET. CFGM-01 is explicit that validation runs BEFORE the
//      change exists, so a mutation that breaks the config never becomes something a person can
//      accept. It validates the ENTIRE candidate rather than the changed field, because D-03 removed
//      the settable-field whitelist deliberately — the guards here are whole-input by construction
//      or they are door enumeration — and since 395-05 the whole input is the whole FILE SET, not
//      the config yaml alone: `config.hook.add` changes only the hooks file, and a validator that
//      never saw it would have declared valid the one artifact that change wrote.
//   5. CLASSIFY cross-boundary-ness from the actual VALUES, through `computeCrossBoundary`.
//   6. PUBLISH through the direct writer and answer what it wrote.
//
// NO SECRET SCAN. A config change is not scanned for secrets and is
// never blocked for what a value looks like: a value in a config field is the author's own text.
// What a change shows — its diff, a validator's words — reaches people and models through the
// declared-secret mask each door applies to what it shows.
//
// SIX OPS, ONE PIPELINE, AND THE SPLIT BETWEEN THEM IS THE POINT. Steps 3 to 6 are
// `checkConfigCandidate` plus `publishConfigChange` and every action reaches them: what a
// `config.target.create` and a `config.field.set` do differently is which bytes they hand it, never
// what happens to those bytes afterwards. What the ops DO own is steps 1 and 2 plus their own
// REQUEST refusals — a create against a name that exists, an edit against one that does not —
// because those are facts about the ask rather than about the resulting configuration, and the two
// dispositions are deliberately different answers (see `CONFIG_CHANGE_REFUSAL_REASONS`).
//
// A validation failure is answered as a refusal carrying its report, with nothing written or kept.
//
// NOTHING HERE COMMITS. The direct writer publishes files and runs no git; a person reviews and
// reverts the change with their own tools.
//
// PURE OVER PORTS. Every host fact — bytes, the yaml edit, the document's shape, validation, the
// writer — arrives as a dependency, so the pipeline is drivable end to end with no filesystem and
// no git, and the composed case in `cli` drives it with the real ones.

import {
  CONFIG_SET_GITIGNORE,
  UnrenderableConfigDiffError,
  base64Encode,
  isLegalConfigReference,
  renderConfigDiff,
  utf8Decode,
  utf8Encode,
} from '@vostride/agent-qa-schema'
import type {
  ConfigAuthSetInput,
  ConfigChange,
  ConfigChangeOutput,
  ConfigDiffChanged,
  ConfigDiffFileInput,
  ConfigHookAddInput,
  ConfigBlockedReason,
  ConfigChangeFile,
  ConfigProjectScaffoldInput,
  ConfigReferenceKind,
  ConfigTargetCreateInput,
  ConfigTargetEditInput,
  CrossBoundaryReason,
} from '@vostride/agent-qa-schema'

import { computeCrossBoundary } from './cross-boundary.js'
import type { CrossBoundaryFieldEdit } from './cross-boundary.js'
import { HOSTNAME_GATE_REFUSAL_DETAIL, parseHostnameToken } from './hostname-gate.js'
import type {
  ConfigFieldValue,
  ConfigFileBytes,
  ConfigFieldWriteOutcome,
  ConfigFilePublishOutcome,
  ConfigFileSet,
  ConfigFilesPortLike,
  ConfigScaffoldContentPortLike,
  ConfigStructuredValue,
  ConfigValidatePortLike,
  ConfigWritePortLike,
} from './ports.js'

/** The registry map every target op addresses. */
const TARGETS_PATH = 'registry.targets'

/** The auth plugin declaration list `config.auth.set` appends a package to. */
const AUTH_PLUGINS_PATH = 'plugins.auth'

/** The hooks file's top-level sequence. Read in the HOOKS file, never in the config yaml. */
const HOOKS_PATH = 'hooks'

export interface ConstructConfigFieldSetInput {
  /** The emitting op's bare id — becomes the payload's `action` and the envelope's `emittedBy`. */
  readonly action: string
  readonly path: string
  readonly value: ConfigFieldValue
}

/**
 * What the six config operations need: the files, the validator and the direct
 * writer that publishes the change in the call.
 */
export interface ConstructConfigChangeDeps {
  readonly configFiles: ConfigFilesPortLike
  readonly configValidate: ConfigValidatePortLike
  readonly configWrite: ConfigWritePortLike
}

/**
 * How a checked change is published.
 *
 * `fields` hands the change to the config transaction as field operations, so it merges onto the
 * file as it stands in its own write turn and keeps an outside edit to another field. `files`
 * publishes each changed file whole, over the digest it was built from.
 */
export type ConfigPublication =
  | { readonly kind: 'fields'; readonly changes: readonly ConfigChange[] }
  | { readonly kind: 'files' }

/**
 * Everything steps 3 to 7 are allowed to know about the change one op decided to make.
 *
 * FACTS, NEVER PORTS, on `CrossBoundaryFacts`' own reasoning. An op has already done its reading and
 * its mutating by the time it builds one of these; what it hands over is the candidate set and a
 * per-VALUE account of what it wrote. The pipeline cannot go back and ask for more, which is what
 * keeps "which bytes are being proposed" a question with one answer.
 */
export interface ConfigMutationPlan {
  /** The emitting op's bare id. */
  readonly action: string
  /** What the change is ABOUT, for the blocked line: a config path, a target name, a hook name. */
  readonly subject: string
  /** The one-line summary an applyable proposal carries. May print values; see below. */
  readonly summaryLine: string
  /**
   * Every SCALAR this change writes, with what it replaced.
   *
   * FLATTENED TO LEAVES, because the classifier's rules are about values: an origin comparison needs
   * a URL and not the map that contains one. `flattenScalarEdits` does the flattening, so a
   * structured write is classified on everything inside it rather than on the path of its root.
   */
  readonly fieldEdits: readonly CrossBoundaryFieldEdit[]
  /** Whether this proposal ADDS a hook. STATED by the op, never inferred from a path. */
  readonly addsHook: boolean
  /** The pinned set with this change applied — every member, changed or not. */
  readonly candidate: readonly ConfigFileBytes[]
}

/**
 * The one-line summary an applied change's receipt carries.
 *
 * REFS AND VALUES, NEVER THE DIFF. The whole envelope vocabulary is map-not-territory about summary
 * lines, and this one keeps to it: what changed and to what, in one clause. The bytes are
 * in the change's own rendered diff.
 */
export function configFieldSetSummaryLine(path: string, value: ConfigFieldValue): string {
  return `set ${path} to ${typeof value === 'string' ? value : String(value)}`
}

/**
 * The BLOCKED record's line: what was attempted and why it was refused, naming the subject only.
 *
 * IT TAKES A SUBJECT RATHER THAN A PATH, because five ops answer blocked refusals and only
 * one of them addresses a config path. What every subject has in common is that it is a REFERENCE —
 * a path, a target name, a hook name — which is the same class of fact `paths` already carries.
 */
export function configBlockedSummaryLine(subject: string, detail: string): string {
  return `${subject} — blocked: ${detail}`
}

/**
 * Construct, validate and write a `config.field.set` change in the call.
 *
 * ANSWERS A TYPED RESULT for every ordinary outcome rather than throwing. `blocked` is a refusal
 * carrying the report, with nothing written or kept; `no-change` is a set of a value the config
 * already holds, which is neither an error nor a write.
 */
export async function changeConfigField(
  input: ConstructConfigFieldSetInput,
  deps: ConstructConfigChangeDeps,
): Promise<ConfigChangeOutput> {
  // (1) CFGM-04: re-read at proposal time. Everything below is about these bytes and no others.
  const set = await deps.configFiles.read()
  const target = requireConfigFile(set)

  // (2) The comment-preserving edit, over exactly the bytes just read. The previous value comes back
  // from the SAME parse that wrote the new one, because (6) has to compare the two.
  const edit = await deps.configFiles.setField({
    ...(target.bytes === undefined ? {} : { bytes: target.bytes }),
    path: input.path,
    value: input.value,
  })

  return await publishConfigChange({
    action: input.action,
    subject: `set ${input.path}`,
    summaryLine: configFieldSetSummaryLine(input.path, input.value),
    fieldEdits: [{
      configPath: input.path,
      ...(edit.previousValue === undefined ? {} : { oldValue: edit.previousValue }),
      newValue: input.value,
    }],
    // A field set writes a config value; it does not add a hook. `config.hook.add` is its own op and
    // supplies this fact itself. Stated rather than inferred, because inferring "a hook was added"
    // from a path would be the per-op map D-02 refused.
    addsHook: false,
    candidate: candidateSet(set, [{ path: target.path, bytes: edit.bytes }]),
  }, {
    kind: 'fields',
    changes: [{ op: 'set', path: configSegments(input.path), value: input.value }],
  }, set, deps)
}

/**
 * Create a target in the call — and refuse a collision rather than merging one.
 *
 * A CREATE IS NEVER AN UPSERT, and this is CFGM-01's adjacency edge. `setIn` at an occupied path
 * REPLACES what is there, silently and comment-destructively: a person who asked to add a target
 * would get a proposal that quietly deleted the `environment` class, the `product` name and the
 * mobile fields of the one they already had, rendered as a diff they would have to read line by line
 * to notice. The refusal names the existing target and points at the op that edits one.
 */
export async function createConfigTarget(
  input: ConfigTargetCreateInput & { readonly action: string },
  deps: ConstructConfigChangeDeps,
): Promise<ConfigChangeOutput> {
  const set = await deps.configFiles.read()
  const target = requireConfigFile(set)
  const entryPath = `${TARGETS_PATH}.${input.name}`

  // no auth-state reference to admit. The input carried
  // `authStateName` and wrote it to `use.authState`, which the committed configuration has no key
  // for, so every such create was blocked by whole-config validation; the field is gone.
  const facts = await deps.configFiles.inspect({
    ...(target.bytes === undefined ? {} : { bytes: target.bytes }),
    paths: [entryPath, TARGETS_PATH],
  })
  if (factsFor(facts, entryPath).present) {
    return {
      outcome: 'refused',
      reason: 'target-exists',
      detail:
        `the target ${input.name} is already configured at ${entryPath}; a create never replaces an `
        + 'existing target, because doing so would silently discard every field it already holds. '
        + 'Use config.target.edit to change it.',
      candidates: [...(factsFor(facts, TARGETS_PATH).keys ?? [])],
    }
  }

  // THE HOUSE STYLE, AS ONE BLOCK. `demo/init/agent-qa.config.yaml` writes a web target as
  // `name: { platform, url }`, and writing it as one structured value rather than as two scalar sets
  // means one parse, one rendered block, and a diff a person reads as the addition it is. The class
  // is written only when declared: undeclared stays visibly undeclared, never defaulted.
  const entry: ConfigStructuredValue = {
    platform: input.platform,
    url: input.url,
    ...(input.environment === undefined ? {} : { environment: input.environment }),
  }
  const bytes = (await deps.configFiles.setField({
    ...(target.bytes === undefined ? {} : { bytes: target.bytes }),
    path: entryPath,
    value: entry,
  })).bytes

  const fieldEdits: CrossBoundaryFieldEdit[] = flattenScalarEdits(entryPath, entry, undefined)
  // THE NAME MUST STILL BE FREE WHEN THE WRITE TAKES ITS TURN. The collision check above read the
  // file at the start of the call; the expect makes the transaction refuse, rather than replace, a
  // target somebody created under this name in between.
  const changes: ConfigChange[] = [
    { op: 'expect', path: configSegments(entryPath), value: null },
    { op: 'set', path: configSegments(entryPath), value: entry },
  ]

  return await publishConfigChange({
    action: input.action,
    subject: `create target ${input.name}`,
    summaryLine: `create ${input.platform} target ${input.name} at ${input.url}`
      + (input.environment === undefined ? '' : ` (${input.environment})`),
    fieldEdits,
    addsHook: false,
    candidate: candidateSet(set, [{ path: target.path, bytes }]),
  }, { kind: 'fields', changes }, set, deps)
}

/**
 * Edit a target in the call — and refuse an absent target by NAME.
 *
 * THE REFUSAL LISTS THE CONFIGURED NAMES (387's never-guess posture, D-15's line). An edit of a
 * target nobody configured is almost always a near-miss — `shop` for `shop-web` — and a refusal that
 * says only "no such target" makes the next call another guess. The names are already readable
 * through `config.get`, so listing them discloses nothing.
 */
export async function editConfigTarget(
  input: ConfigTargetEditInput & { readonly action: string },
  deps: ConstructConfigChangeDeps,
): Promise<ConfigChangeOutput> {
  const set = await deps.configFiles.read()
  const target = requireConfigFile(set)
  const entryPath = `${TARGETS_PATH}.${input.name}`

  // `changes.authStateName` is gone with the other two ops' field;
  // a url is the only change, and it is not a reference.
  const facts = await deps.configFiles.inspect({
    ...(target.bytes === undefined ? {} : { bytes: target.bytes }),
    paths: [entryPath, TARGETS_PATH],
  })
  if (!factsFor(facts, entryPath).present) {
    return {
      outcome: 'refused',
      reason: 'target-not-found',
      detail:
        `no target named ${input.name} is configured at ${TARGETS_PATH}; an edit changes a target `
        + 'that exists. Use config.target.create to add one.',
      candidates: [...(factsFor(facts, TARGETS_PATH).keys ?? [])],
    }
  }

  let bytes = target.bytes
  const fieldEdits: CrossBoundaryFieldEdit[] = []
  const changes: ConfigChange[] = []
  // ORDERED, AND THE ORDER IS FIXED HERE RATHER THAN BY THE INPUT'S KEY ORDER. Two calls asking for
  // the same two changes must produce the same bytes, or the diff a person reads depends on how a
  // model happened to serialise its arguments.
  for (const [path, value] of [
    [`${entryPath}.url`, input.changes.url],
  ] as const) {
    if (value === undefined) continue
    const edited = await deps.configFiles.setField({
      ...(bytes === undefined ? {} : { bytes }),
      path,
      value,
    })
    bytes = edited.bytes
    fieldEdits.push({
      configPath: path,
      ...(edited.previousValue === undefined ? {} : { oldValue: edited.previousValue }),
      newValue: value,
    })
    changes.push({ op: 'set', path: configSegments(path), value })
  }

  if (bytes === undefined) throw new TypeError('the config file has no bytes to edit')

  return await publishConfigChange({
    action: input.action,
    subject: `edit target ${input.name}`,
    summaryLine: `edit target ${input.name}: ${fieldEdits.map((edit) =>
      `${edit.configPath} to ${String(edit.newValue)}`).join(', ')}`,
    fieldEdits,
    addsHook: false,
    candidate: candidateSet(set, [{ path: target.path, bytes }]),
  }, { kind: 'fields', changes }, set, deps)
}

/**
 * Declare a target's auth plugin in the call — references only, refused on the INPUT.
 *
 * WHAT IT WRITES, AND WHERE, IS A FACT ABOUT THIS PRODUCT'S CONFIGURATION SCHEMA RATHER THAN A
 * CHOICE. The committed configuration has exactly one place that declares an auth plugin and it is
 * the `plugins.auth` sequence (`AuthPluginDeclarationSchema`: `{ package }` or `{ path }`,
 * `.strict()`). It has NO place at all for an environment variable's name, which is why
 * `envVarName` is refused rather than written — see the `unsupported-reference` arm below.
 *
 * IT HAS NO PLACE FOR A STORED AUTH STATE'S BINDING EITHER. This op
 * once wrote `authStateName` to `use.authState`; `core`'s committed `UseSchema` is `.strict()` with
 * no such key (only a test's or a suite's own `use` has one), so whole-config validation answered
 * every such call `blocked / schema-fail`. The input field is deleted rather than written somewhere
 * the schema would also refuse.
 *
 * THE `target` IS RESOLVED, NEVER WRITTEN, and that is deliberate. Naming the target is what lets
 * the op refuse a declaration for a target nobody configured — a typed not-found with the configured
 * names, rather than a change that names nothing.
 */
export async function setConfigAuth(
  input: ConfigAuthSetInput & { readonly action: string },
  deps: ConstructConfigChangeDeps,
): Promise<ConfigChangeOutput> {
  const set = await deps.configFiles.read()
  const target = requireConfigFile(set)

  // D-11 FIRST, OVER EVERY SUPPLIED REFERENCE, BEFORE THE DOCUMENT IS TOUCHED. `target` is not in
  // this list because it is never written: a credential arriving there resolves against the registry
  // and produces `target-not-found`, which discloses nothing and says something true.
  const refusal = refuseNonReferences([
    ...(input.pluginPackage === undefined
      ? []
      : [{ field: 'pluginPackage', kind: 'plugin-package' as const, value: input.pluginPackage }]),
    ...(input.envVarName === undefined
      ? []
      : [{ field: 'envVarName', kind: 'env-var-name' as const, value: input.envVarName }]),
  ])
  if (refusal !== undefined) return refusal

  const entryPath = `${TARGETS_PATH}.${input.target}`
  const facts = await deps.configFiles.inspect({
    ...(target.bytes === undefined ? {} : { bytes: target.bytes }),
    paths: [entryPath, TARGETS_PATH, AUTH_PLUGINS_PATH],
  })
  if (!factsFor(facts, entryPath).present) {
    return {
      outcome: 'refused',
      reason: 'target-not-found',
      detail:
        `no target named ${input.target} is configured at ${TARGETS_PATH}, so there is nothing to `
        + 'bind an auth state to. Use config.target.create to add one first.',
      candidates: [...(factsFor(facts, TARGETS_PATH).keys ?? [])],
    }
  }

  // AFTER THE REFERENCE CHECK, DELIBERATELY. A value that is not shaped like a variable name is
  // answered as refs-only first, because that is the fact the person needs.
  if (input.envVarName !== undefined) {
    return {
      outcome: 'refused',
      reason: 'unsupported-reference',
      detail:
        'this configuration schema has no field that records an environment variable\'s name: an '
        + 'auth plugin declaration is a package or a path and nothing else. The plugin reads the '
        + 'variable from the environment it runs in, and no config change is needed to point at it.',
    }
  }

  let bytes = target.bytes
  const fieldEdits: CrossBoundaryFieldEdit[] = []
  const changes: ConfigChange[] = []

  if (input.pluginPackage !== undefined) {
    // APPENDED PAST THE END, AT A LENGTH THE DOCUMENT ITSELF REPORTED. Writing at a fixed index
    // would overwrite a declaration that is already there; writing the whole sequence back would
    // discard the ones this call did not mention.
    const declaration: ConfigStructuredValue = { package: input.pluginPackage }
    const existing = factsFor(facts, AUTH_PLUGINS_PATH)
    const at = existing.length ?? 0
    const appended = await deps.configFiles.setField({
      ...(bytes === undefined ? {} : { bytes }),
      path: existing.present ? `${AUTH_PLUGINS_PATH}.${at}` : AUTH_PLUGINS_PATH,
      value: existing.present ? declaration : [declaration],
    })
    bytes = appended.bytes
    fieldEdits.push(...flattenScalarEdits(`${AUTH_PLUGINS_PATH}.${at}`, declaration, undefined))
    // AN APPEND IN THE WRITE'S OWN TURN, so a declaration somebody added meanwhile is kept and this
    // one lands after it rather than over it.
    changes.push({ op: 'append', path: configSegments(AUTH_PLUGINS_PATH), value: declaration })
  }

  if (bytes === undefined) throw new TypeError('the config file has no bytes to edit')

  return await publishConfigChange({
    action: input.action,
    subject: `bind auth for target ${input.target}`,
    summaryLine: `bind auth for target ${input.target}: ${fieldEdits.map((edit) =>
      `${edit.configPath} to ${String(edit.newValue)}`).join(', ')}`,
    fieldEdits,
    addsHook: false,
    candidate: candidateSet(set, [{ path: target.path, bytes }]),
  }, { kind: 'fields', changes }, set, deps)
}

/**
 * Add a hook in the call — the one action that writes a file other than the config.
 *
 * A HOOK IS CODE THIS PROJECT WILL RUN, which is why `addsHook` is STATED here rather than inferred
 * from a path and why every hook addition is cross-boundary regardless of what it contains.
 * The flag raises the `hook-added` cross-boundary reason on the applied receipt. (2026-10-03: the
 * grant machinery that refused on it is deleted.)
 *
 * THE ID IS MINTED BY THE HOST, NEVER FORMATTED HERE. `core`'s `HookDefinitionSchema` refuses any id
 * `isCanonicalHookId` does not accept, and that mint lives in a package this layer may not import
 * and draws randomness this layer may not read. A hand-built `h_`-prefixed string would parse as a
 * string, reach a person's repository, and be refused at the next run rather than at the proposal.
 *
 * THE APPEND IS PAST THE END OF WHAT THE DOCUMENT REPORTS, and a project with no hooks file at all
 * gets one created — which is the whole-new-file case publication already handles, arriving before
 * 395-08's scaffold needs it.
 */
export async function addConfigHook(
  input: ConfigHookAddInput & { readonly action: string },
  deps: ConstructConfigChangeDeps,
): Promise<ConfigChangeOutput> {
  const set = await deps.configFiles.read()
  const hooksMember = set.files.find((file) => file.path === set.hooksFile)
  if (hooksMember === undefined) {
    throw new TypeError(
      `the config file set names ${JSON.stringify(set.hooksFile)} as its hooks file, but the set `
      + 'does not contain it — a set that cannot see its own hooks file cannot declare a hook',
    )
  }

  const facts = await deps.configFiles.inspect({
    ...(hooksMember.bytes === undefined ? {} : { bytes: hooksMember.bytes }),
    paths: [HOOKS_PATH],
  })
  const existing = factsFor(facts, HOOKS_PATH)
  const at = existing.length ?? 0

  const entry: ConfigStructuredValue = {
    id: deps.configFiles.mintHookId(),
    name: input.name,
    runtime: input.runtime,
    file: input.file,
    timeout: input.timeout ?? DEFAULT_HOOK_TIMEOUT,
    ...(input.network === undefined ? {} : { network: input.network }),
  }
  const written = await deps.configFiles.setField({
    ...(hooksMember.bytes === undefined ? {} : { bytes: hooksMember.bytes }),
    path: existing.present ? `${HOOKS_PATH}.${at}` : HOOKS_PATH,
    value: existing.present ? entry : [entry],
  })

  // THE HOOKS FILE IS PUBLISHED WHOLE, over the digest of the bytes it was built from. It is not
  // the config yaml, so the config transaction cannot merge it; a hooks file somebody edited since
  // this call read it refuses the write instead.
  return await publishConfigChange({
    action: input.action,
    subject: `add hook ${input.name}`,
    summaryLine: `add ${input.runtime} hook ${input.name} running ${input.file}`,
    fieldEdits: flattenScalarEdits(`${HOOKS_PATH}.${at}`, entry, undefined),
    // STATED, NOT INFERRED. This is the op that adds hooks; nothing has to guess.
    addsHook: true,
    candidate: candidateSet(set, [{ path: hooksMember.path, bytes: written.bytes }]),
  }, { kind: 'files' }, set, deps)
}

/**
 * Everything `config.project.scaffold` needs beyond what every other action needs.
 *
 * A SEPARATE TYPE: the scaffold is the only action that renders content it did not compute from
 * the committed file, so widening the shared bundle would make six ops bind a port none of them can
 * reach.
 */
export interface ConstructConfigScaffoldDeps extends ConstructConfigChangeDeps {
  readonly scaffoldContent: ConfigScaffoldContentPortLike
}

/**
 * Configure a project from zero, in ONE call.
 *
 * EVERY FILE IS PUBLISHED WHOLE, AND EVERY ONE IS CHECKED FIRST. The config, the hooks file and the
 * managed `.gitignore` block each carry the digest of the bytes this call read (or the fact that
 * the file was absent), and the direct writer checks all of them before it writes any. A file that
 * changes after that check stops the publication at that file: the answer names the files already
 * written, the one that refused and the ones never reached, and nothing is rolled back.
 *
 * THE GATE RUNS FIRST AND IT IS THE SECURITY PROPERTY. Nothing below is reached by a token
 * that is not a hostname, and the refusal names both continuations rather than a candidate. The
 * derivation the gate returns is the ONLY source of the target name and the base URL — this
 * function computes neither — so "the LLM never invents an origin" is a statement about which
 * function produced the bytes rather than about how the model was asked.
 *
 * A CONFIGURATION THIS SCAFFOLD WOULD OVERWRITE IS A REFUSAL — AND THAT IS DECLARED TARGETS, NEVER
 * A FILE'S EXISTENCE (395-12, narrowed · SC-5's entry point). The refusal protects a person's
 * configuration from being replaced wholesale, and what this op writes is the target registry. A
 * config file that declares NO targets has nothing here to overwrite, so it is MERGED: exactly
 * `registry.targets.<name>` is inserted into the person's own bytes and no other byte of that file
 * moves. The declared-target set arrives as a STRUCTURAL fact from the inspect port — names, never
 * values — for the reason this package parses no yaml at all.
 *
 * WHY THE OLD PREDICATE WAS A PINCER RATHER THAN A GUARD, recorded because the narrowing only reads
 * as safe against it. `resolveCliChatCapabilities` reads the chat model out of `registry.llms`,
 * which lives in the config file — so the only project that can reach this op through a chat turn
 * is a project that HAS a config file, which is precisely the project the file-existence predicate
 * refused. The two conditions closed on each other and CFGM-05's sentence could not complete for
 * any project at all (WINDOWS 132's two jaws, both reproduced live by 395-VERIFICATION). Under the
 * narrowing the serving class is every project that can chat: a model, no targets, one inserted
 * entry. A project with no model anywhere still cannot chat about anything, which is WINDOWS
 * 130/133's parked question about model resolution and not a config-mutation defect.
 *
 * `config.target.create` REMAINS THE OP for adding a target to a project that already declares one,
 * and the refusal still names it — now naming the targets it will not replace, so a person reads
 * WHICH configuration is standing in the way rather than merely that one is.
 *
 * IT IS ALWAYS CROSS-BOUNDARY, AND THAT IS COMPUTED RATHER THAN ASSERTED. The scaffold
 * writes a base URL where the committed configuration had none, so `computeCrossBoundary` sees an
 * edit whose old value is absent and whose new value is an origin — and it adds a hooks file and a
 * config file that did not exist. The flag is read off the classifier the same way every other
 * proposal's is; nothing here sets it by hand. 395-07's two-sided enforcement then makes a scaffold
 * unsatisfiable by any standing grant, from either side.
 *
 * `UnrenderableConfigDiffError` IS CAUGHT HERE AND NOWHERE ELSE, and the scope is the argument.
 * 395-02 minted that refusal for the case where two byte sequences decode identically and the diff
 * renders as a blank page; every other op composes bytes it authored from a file it just read, and
 * this is the one that folds a project's EXISTING `.gitignore` — arbitrary bytes, from a file this
 * product does not own — into a file it proposes. Answering it as a typed `refused` rather than
 * letting it escape as a fault is the difference between "this project's .gitignore is not text I
 * can show you a diff of" and a stack trace in a chat turn.
 */
export async function scaffoldConfigProject(
  input: ConfigProjectScaffoldInput & { readonly action: string },
  deps: ConstructConfigScaffoldDeps,
): Promise<ConfigChangeOutput> {
  const verdict = parseHostnameToken(input.domain)
  if (verdict.kind === 'not-a-hostname') {
    return { outcome: 'refused', reason: 'not-a-hostname', detail: HOSTNAME_GATE_REFUSAL_DETAIL }
  }

  // (1) CFGM-04: the re-read, exactly as every other action does it.
  const set = await deps.configFiles.read()
  const existingConfig = requireConfigFile(set)

  // THE PREDICATE, NARROWED. A config file with no `registry.targets` entries declares
  // nothing this op would replace, so its existence alone is not a refusal. `inspect` answers the
  // MAP's keys — names only, never values — which is the same structural read `config.target.create`
  // already takes to list the names its own refusal offers.
  const declaredTargets = existingConfig.bytes === undefined
    ? []
    : factsFor(
      await deps.configFiles.inspect({ bytes: existingConfig.bytes, paths: [TARGETS_PATH] }),
      TARGETS_PATH,
    ).keys ?? []
  if (declaredTargets.length > 0) {
    return {
      outcome: 'refused',
      reason: 'already-configured',
      detail:
        `this project already configures ${declaredTargets.join(', ')} in ${existingConfig.path}, `
        + 'and scaffolding writes a whole target registry — it would replace what is there. Use '
        + `config.target.create to add ${verdict.targetName} to the configuration you already have.`,
      candidates: [...declaredTargets],
    }
  }

  const gitignore = set.files.find((file) => file.path === CONFIG_SET_GITIGNORE)
  // THE ROUND TRIP IS CHECKED BEFORE THE DECODE IS USED. The block is composed as TEXT, so a
  // `.gitignore` carrying bytes utf-8 does not round-trip would come back with every one of them
  // replaced by U+FFFD — a proposal that silently rewrote a file it was only supposed to append to.
  // Refused rather than repaired: this product did not author those bytes.
  if (gitignore?.bytes !== undefined && !bytesEqual(utf8Encode(utf8Decode(gitignore.bytes)), gitignore.bytes)) {
    return {
      outcome: 'refused',
      reason: 'unrenderable-diff',
      detail:
        `${gitignore.path} holds bytes that are not valid UTF-8, so appending the managed block to `
        + 'it would rewrite parts of the file you did not ask to change. Nothing has been written.',
    }
  }

  // WHETHER THIS SCAFFOLD ADDS A HOOKS FILE IS A FACT ABOUT THE SET, not a constant. From zero it
  // always does; merging into a project that already has one, it must not — and `addsHook` is
  // STATED by the op, so it has to stop being stated when no hook is added or the classifier
  // would flag `hook-added` for a file nobody touched.
  const hooksMember = set.files.find((file) => file.path === set.hooksFile)
  const addsHook = hooksMember?.bytes === undefined

  const rendered = await deps.scaffoldContent.render({
    targetName: verdict.targetName,
    baseUrl: verdict.baseUrl,
    ...(gitignore?.bytes === undefined ? {} : { existingGitignore: gitignore.bytes }),
    // MERGE MODE, AND ONLY WHEN THERE ARE BYTES TO MERGE INTO. Absent here is the from-zero road,
    // whose rendered bytes are byte-identical to what 395-08 shipped and what the goldens pin.
    ...(existingConfig.bytes === undefined
      ? {}
      : {
        existingConfig: {
          path: existingConfig.path,
          bytes: existingConfig.bytes,
          hooksPath: set.hooksFile,
          hooksPresent: !addsHook,
        },
      }),
  })

  try {
    return await publishConfigChange({
      action: input.action,
      subject: `scaffold ${verdict.targetName}`,
      summaryLine: `configure this project for ${verdict.baseUrl} as target ${verdict.targetName}`,
      // THE DERIVED VALUES, AS THE EDITS THEY ARE. The classifier compares each against what the
      // committed configuration held — nothing, because there is no committed configuration — which
      // is what makes `new-origin` a computed verdict here rather than a constant this op asserts.
      fieldEdits: [
        { configPath: `${TARGETS_PATH}.${verdict.targetName}.platform`, newValue: 'web' },
        { configPath: `${TARGETS_PATH}.${verdict.targetName}.url`, newValue: verdict.baseUrl },
      ],
      // The scaffolded hooks file declares one hook, which is code this project would then run.
      // Stated by the op, as D-02 requires, and true exactly when the file did not exist a moment
      // ago — see `addsHook`'s derivation above.
      addsHook,
      candidate: candidateSet(set, [...rendered]),
    }, { kind: 'files' }, set, deps)
  } catch (error) {
    if (!(error instanceof UnrenderableConfigDiffError)) throw error
    return {
      outcome: 'refused',
      reason: 'unrenderable-diff',
      detail:
        `the bytes for ${error.paths.join(', ')} differ from what is on disk, but the diff of them `
        + 'renders as nothing a person could read. Nothing has been written.',
    }
  }
}

/**
 * What a hook's timeout is when the caller does not say.
 *
 * PINNED, WITH A RETUNE NOTE. `HookDefinitionSchema` makes `timeout` REQUIRED — there is
 * no schema default to inherit — so an op whose DTO marks it optional must supply one, and the
 * alternative to a pinned value is refusing every hook whose duration the caller did not think
 * about. `30s` is what `demo/init/hooks.yaml` writes. RETUNE: owned by whoever owns the hooks
 * vocabulary; a person who wants a different one writes it in the action, and a person who disagrees
 * with the default edits their hooks file, which is one reviewable diff away either way.
 */
const DEFAULT_HOOK_TIMEOUT = '30s'

/**
 * D-11's refusal, fired on the INPUT and before anything is mutated.
 *
 * SCHEMA VALIDATION OF A REFERENCE FIELD, NOT SECRET DETECTION.
 * `isLegalConfigReference` states what a reference IS and refuses the complement, so the rule names
 * nothing it refuses: no detector, no key-name rule and no credential shape.
 *
 * THE DETAIL DOES NOT QUOTE THE VALUE. The field is named, the law is named, and where a secret
 * belongs is named.
 */
function refuseNonReferences(
  entries: readonly { field: string; kind: ConfigReferenceKind; value: string }[],
): ConfigChangeOutput | undefined {
  for (const entry of entries) {
    if (isLegalConfigReference(entry.kind, entry.value)) continue
    return {
      outcome: 'refused',
      reason: 'refs-only',
      detail:
        `the value supplied for ${entry.field} is not shaped like a ${entry.kind}. `
        + REFS_ONLY_LAW,
    }
  }

  return undefined
}

/** One sentence, spelled once, so five refusals cannot state the law four different ways. */
const REFS_ONLY_LAW =
  'This configuration records REFERENCES only — the name of an auth state, of a plugin package, of '
  + 'an environment variable — and never a credential, which is what keeps the committed '
  + 'configuration safe to read. Put the secret in '
  + 'the secrets file the configuration names at workspace.secretsFile and pass its NAME here.'

/** What the blocked report says, before it is answered as a refusal. */
interface BlockedReport {
  readonly blockedReason: ConfigBlockedReason
  readonly detail: string
  readonly paths: readonly string[]
  readonly validationIssues?: readonly string[]
}

/** A candidate that passed validation, with everything publication needs. */
interface CheckedCandidate {
  readonly rendered: ConfigDiffChanged
  readonly files: readonly (ConfigChangeFile & { readonly bytes: Uint8Array })[]
  readonly crossBoundary: boolean
  readonly crossBoundaryReasons: readonly CrossBoundaryReason[]
}

type CandidateCheck =
  | { readonly kind: 'no-change' }
  | { readonly kind: 'blocked'; readonly report: BlockedReport }
  | { readonly kind: 'ready'; readonly checked: CheckedCandidate }

/**
 * Steps 3 to 5, for every action: render, validate, classify.
 *
 * WHAT ARRIVES IS A CANDIDATE SET, NOT A FILE. `renderConfigDiff` is handed exactly the members
 * whose bytes differ, so a change's `files` list is a statement about what changed rather than
 * about which files were considered — and the digests recorded per file are the ones publication
 * re-checks. Step 6 is the caller's: the six config operations publish.
 */
async function checkConfigCandidate(
  plan: ConfigMutationPlan,
  set: ConfigFileSet,
  deps: { readonly configValidate: ConfigValidatePortLike },
): Promise<CandidateCheck> {
  const committed = new Map(set.files.map((file) => [file.path, file]))
  const diffInput: ConfigDiffFileInput[] = []
  for (const member of plan.candidate) {
    if (member.bytes === undefined) continue
    const before = committed.get(member.path)?.bytes
    if (before !== undefined && bytesEqual(before, member.bytes)) continue
    diffInput.push({
      path: member.path,
      ...(before === undefined ? {} : { oldBytes: before }),
      newBytes: member.bytes,
    })
  }
  if (diffInput.length === 0) return { kind: 'no-change' }

  // (3) THE ONE PRIMITIVE. Publication re-checks the digests it records here.
  const rendered = renderConfigDiff(diffInput)

  // THE PRIMITIVE IS THE AUTHORITY ON WHETHER ANYTHING CHANGED, and this narrowing is where
  // that authority is taken. The byte comparison above answers the same question earlier and more
  // cheaply — which is why it stays: it lets a set of a value the config already holds skip the
  // whole rest of the pipeline — but the answer that reaches a person comes from the same function
  // that renders the diff, so the two halves cannot disagree about what "no change" means.
  if (rendered.outcome === 'unchanged') return { kind: 'no-change' }

  const digestsByPath = new Map(rendered.perFileDigests.map((digest) => [digest.path, digest]))

  // (4) CFGM-01: the WHOLE candidate SET. The validator's own words are answered as they are; each
  // door masks the declared values in what it shows.
  const validation = await deps.configValidate.validate({
    configFile: set.configFile,
    hooksFile: set.hooksFile,
    files: plan.candidate,
  })
  if (!validation.ok) {
    // THE REPORT NAMES THE FILE THE ISSUE IS ABOUT, unioned with the files this change
    // diffed. Both halves are kept: the diffed paths say what was being changed, the implicated
    // ones say where to look.
    const implicated = validation.issues.map((issue) => issue.path)
    return {
      kind: 'blocked',
      report: {
        blockedReason: 'schema-fail',
        detail: 'the resulting configuration is not valid',
        paths: [...new Set([...implicated, ...diffInput.map((file) => file.path)])],
        // Non-empty by contract; a validator that refused without saying why would leave a person
        // with nothing to act on, so an empty list is turned into the one honest sentence available.
        validationIssues: validation.issues.length > 0
          ? validation.issues.map((issue) => `${issue.path}: ${issue.message}`)
          : ['the configuration was refused by whole-config validation, which reported no detail'],
      },
    }
  }

  const files = rendered.changes.map((change) => {
    const digests = digestsByPath.get(change.path)
    const bytes = plan.candidate.find((member) => member.path === change.path)?.bytes
    if (digests === undefined || bytes === undefined) {
      throw new TypeError('the diff primitive rendered a file the candidate set does not contain')
    }
    return {
      path: change.path,
      changeKind: change.changeKind,
      ...(digests.oldDigest === undefined ? {} : { baseDigest: digests.oldDigest }),
      newContentBase64: base64Encode(bytes),
      bytes,
    }
  })

  // (5) D-02, PER VALUE. The classifier compares the value each edit wrote against the one it
  // replaced, and reads the pinned file set from the PORT'S OWN enumeration rather than a second
  // list — `set.files` is what `enumerateConfigFileSet` answered for this workspace, so the
  // out-of-set rule and the writer's scope cannot disagree about which files are config.
  const classified = computeCrossBoundary({
    fieldEdits: plan.fieldEdits,
    addsHook: plan.addsHook,
    filesTouched: files.map((file) => file.path),
    pinnedFileSet: set.files.map((file) => file.path),
  })

  return {
    kind: 'ready',
    checked: {
      rendered,
      files,
      crossBoundary: classified.crossBoundary,
      crossBoundaryReasons: [...classified.reasons],
    },
  }
}

/**
 * Step 6 for the six config operations: publish in the call.
 *
 * A BLOCKED CHANGE IS ANSWERED AND NOTHING IS KEPT. The report carries no diff and no content, and
 * nothing reaches a store or the writer. A clean change goes to the direct writer: field changes
 * through the config transaction, whole files over their digests. The answer is what the writer
 * reports — the files it wrote, a refusal that wrote nothing, or the exact point a multi-file
 * publication stopped at.
 */
async function publishConfigChange(
  plan: ConfigMutationPlan,
  publication: ConfigPublication,
  set: ConfigFileSet,
  deps: ConstructConfigChangeDeps,
): Promise<ConfigChangeOutput> {
  const check = await checkConfigCandidate(plan, set, deps)
  if (check.kind === 'no-change') return { outcome: 'no-change', path: plan.subject }
  if (check.kind === 'blocked') return blockedAnswer(plan, check.report)

  const { checked } = check
  const applied = (files: readonly string[]): ConfigChangeOutput => ({
    outcome: 'applied',
    summaryLine: plan.summaryLine,
    files: [...files],
    fields: [...new Set(plan.fieldEdits.map((edit) => edit.configPath))],
    crossBoundary: checked.crossBoundary,
    crossBoundaryReasons: [...checked.crossBoundaryReasons],
    shownDiff: utf8Decode(checked.rendered.diffBytes),
  })

  if (publication.kind === 'fields') {
    // FIELD CHANGES REACH ONLY THE CONFIG FILE. A candidate that changed any other member cannot be
    // expressed as config-field operations, and publishing half of it would be a silent drop.
    const stray = checked.files.find((file) => file.path !== set.configFile)
    if (stray !== undefined) {
      throw new TypeError(
        `${plan.action} changed ${stray.path}, which a config field change cannot write`,
      )
    }
    const outcome = await deps.configWrite.applyFields({ changes: publication.changes })
    return outcome.kind === 'applied' ? applied([outcome.file]) : fieldWriteRefusal(outcome)
  }

  const outcome = await deps.configWrite.publishFiles({
    files: checked.files.map((file) => ({
      path: file.path,
      ...(file.baseDigest === undefined ? {} : { baseDigest: file.baseDigest }),
      bytes: file.bytes,
    })),
  })
  switch (outcome.kind) {
    case 'published':
      return applied(outcome.written)
    case 'refused':
      return fileWriteRefusal(outcome)
    case 'interrupted':
      return interruptedAnswer(plan, outcome)
  }
}

/** The blocked report as the direct answer: the report, never the change, and no record. */
function blockedAnswer(plan: ConfigMutationPlan, report: BlockedReport): ConfigChangeOutput {
  return {
    outcome: 'blocked',
    summaryLine: configBlockedSummaryLine(plan.subject, report.detail),
    blockedReason: report.blockedReason,
    paths: [...report.paths],
    ...(report.validationIssues === undefined
      ? {}
      : { validationIssues: [...report.validationIssues] }),
  }
}

/** Why the config transaction refused, in words that name no value. */
const FIELD_WRITE_REFUSAL_WORDS: Readonly<Record<
  Exclude<Extract<ConfigFieldWriteOutcome, { kind: 'refused' }>['error'], 'field_changed'>,
  string
>> = {
  invalid_write_input: 'the change set is malformed',
  file_invalid: 'the file is not readable as YAML',
  path_not_found: 'a path the change names no longer resolves',
  validation_failed: 'the configuration it would produce is not valid',
  path_not_writable: 'a path the change names cannot be written',
  marker_written_back:
    'a value or path the change names holds [secret:<name>], the way a declared secret is shown, '
    + 'so it was not written; edit the config file directly instead, without copying the marker',
}

function fieldWriteRefusal(
  outcome: Extract<ConfigFieldWriteOutcome, { kind: 'refused' }>,
): ConfigChangeOutput {
  if (outcome.error === 'field_changed') {
    const field = (outcome.path ?? [])
      .map((segment) => (typeof segment === 'object' ? segment.name : String(segment)))
      .join('.')
    return {
      outcome: 'refused',
      reason: 'field-changed',
      detail:
        `${field === '' ? 'a field this change depends on' : field} changed in ${outcome.file} after `
        + 'this call read it, so nothing was written. Read the configuration again and ask again.',
    }
  }
  const at = outcome.issues === undefined || outcome.issues.length === 0
    ? ''
    : ` (at ${outcome.issues.map((issue) => issue.path.join('.')).join(', ')})`
  return {
    outcome: 'refused',
    reason: 'write-refused',
    detail:
      `${outcome.file} refused this change as it now stands: ${FIELD_WRITE_REFUSAL_WORDS[outcome.error]}`
      + `${at}, so nothing was written.`,
  }
}

function fileWriteRefusal(
  outcome: Extract<ConfigFilePublishOutcome, { kind: 'refused' }>,
): ConfigChangeOutput {
  const file = outcome.path ?? 'a file of this change'
  if (outcome.reason === 'file-changed') {
    return {
      outcome: 'refused',
      reason: 'file-changed',
      detail:
        `${file} changed after this call read it, so nothing was written. Read the configuration `
        + 'again and ask again.',
    }
  }
  // 441 GAP3-D5: the fields arm's marker_written_back answer, for a whole file.
  if (outcome.reason === 'marker_written_back') {
    return {
      outcome: 'refused',
      reason: 'write-refused',
      detail:
        `${file} refused this change as it now stands: `
        + `${FIELD_WRITE_REFUSAL_WORDS.marker_written_back}, so nothing was written.`,
    }
  }
  const words = {
    'no-files': 'there was no file to write',
    'outside-workspace': `${file} is outside the workspace`,
    'duplicate-path': `${file} is named twice`,
  }[outcome.reason]
  return {
    outcome: 'refused',
    reason: 'write-refused',
    detail: `${words}, so nothing was written.`,
  }
}

function interruptedAnswer(
  plan: ConfigMutationPlan,
  outcome: Extract<ConfigFilePublishOutcome, { kind: 'interrupted' }>,
): ConfigChangeOutput {
  const written = outcome.written.length === 0 ? 'nothing' : outcome.written.join(', ')
  const unwritten = outcome.unwritten.length === 0 ? 'no other file' : outcome.unwritten.join(', ')
  const stopped = outcome.failed.reason === 'file-changed'
    ? 'changed after this call read it'
    : 'could not be written'
  return {
    outcome: 'interrupted',
    summaryLine: plan.summaryLine,
    written: [...outcome.written],
    failed: { path: outcome.failed.path, reason: outcome.failed.reason },
    unwritten: [...outcome.unwritten],
    detail:
      `wrote ${written}, then stopped: ${outcome.failed.path} ${stopped}, and ${unwritten} was not `
      + 'reached. Nothing was rolled back; the written files hold the new bytes.',
  }
}

/** The config yaml, or the one refusal a set that cannot see its own config file deserves. */
function requireConfigFile(set: ConfigFileSet): ConfigFileBytes {
  const target = set.files.find((file) => file.path === set.configFile)
  if (target === undefined) {
    throw new TypeError(
      `the config file set names ${JSON.stringify(set.configFile)} as its config file, but the set `
      + `does not contain it — a set that cannot see its own config file cannot be edited`,
    )
  }
  return target
}

/** The pinned set with the given members' bytes replaced — every other member carried through. */
function candidateSet(
  set: ConfigFileSet,
  writes: readonly { path: string; bytes: Uint8Array }[],
): readonly ConfigFileBytes[] {
  const written = new Map(writes.map((write) => [write.path, write.bytes]))
  const merged = set.files.map((file) => {
    const bytes = written.get(file.path)
    return bytes === undefined ? file : { path: file.path, bytes }
  })
  // A write to a path the set does not enumerate stays in the candidate rather than being dropped:
  // the classifier's `out-of-set-path` rule exists to FLAG that case, and a member silently removed
  // here would be a change nobody could flag because nobody could see it.
  for (const write of writes) {
    if (merged.some((file) => file.path === write.path)) continue
    merged.push({ path: write.path, bytes: write.bytes })
  }
  return merged
}

/**
 * Every scalar leaf a structured write puts into the document, as per-value classifier edits.
 *
 * THE CLASSIFIER'S RULES ARE ABOUT VALUES, so a structured write has to be taken apart before it can
 * be classified: an origin comparison needs the URL string, not the map that contains it, and a
 * secret-adjacency test on the map's root path answers a different question than one on each leaf.
 * Flattening here rather than in each op is what stops four ops from having four ideas about which
 * of their values are worth classifying.
 */
function flattenScalarEdits(
  basePath: string,
  value: ConfigStructuredValue,
  oldValue: ConfigFieldValue | undefined,
): CrossBoundaryFieldEdit[] {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return [{
      configPath: basePath,
      ...(oldValue === undefined ? {} : { oldValue }),
      newValue: value,
    }]
  }
  if (Array.isArray(value)) {
    return (value as readonly ConfigStructuredValue[]).flatMap((item, index) =>
      flattenScalarEdits(`${basePath}.${index}`, item, undefined))
  }
  return Object.entries(value as { readonly [key: string]: ConfigStructuredValue })
    .flatMap(([key, item]) => flattenScalarEdits(`${basePath}.${key}`, item, undefined))
}

/**
 * A dotted config path as the config transaction's segments, split exactly as the yaml edit above
 * splits it, so the construction and the publication address the same field.
 */
function configSegments(path: string): string[] {
  return path.split('.')
}

/** One path's facts out of the port's answer, by NAME — never by the index a caller assumed. */
function factsFor(
  facts: readonly { path: string; present: boolean; keys?: readonly string[]; length?: number }[],
  path: string,
): { present: boolean; keys?: readonly string[]; length?: number } {
  return facts.find((fact) => fact.path === path) ?? { present: false }
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false
  for (let index = 0; index < left.length; index++) {
    if (left[index] !== right[index]) return false
  }
  return true
}
