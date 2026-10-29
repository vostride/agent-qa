// Steps run in order: re-read, mutate, render, validate the whole file set, classify, publish.

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

// The files, the validator and the direct writer that publishes the change in the call.
export interface ConstructConfigChangeDeps {
  readonly configFiles: ConfigFilesPortLike
  readonly configValidate: ConfigValidatePortLike
  readonly configWrite: ConfigWritePortLike
}

// `fields` merges onto the file in its own write turn, keeping an outside edit to another field.
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
  // Flattened to leaves, so a structured write is classified on every value inside it.
  readonly fieldEdits: readonly CrossBoundaryFieldEdit[]
  // Whether this proposal adds a hook, stated by the op and never inferred from a path.
  readonly addsHook: boolean
  /** The pinned set with this change applied — every member, changed or not. */
  readonly candidate: readonly ConfigFileBytes[]
}

// Refs and values in one clause, never the diff.
export function configFieldSetSummaryLine(path: string, value: ConfigFieldValue): string {
  return `set ${path} to ${typeof value === 'string' ? value : String(value)}`
}

// Takes a subject, not a path, because most blocked ops do not address a config path.
export function configBlockedSummaryLine(subject: string, detail: string): string {
  return `${subject} — blocked: ${detail}`
}

// Answers a typed result; `no-change` sets a value the config already holds and writes nothing.
export async function changeConfigField(
  input: ConstructConfigFieldSetInput,
  deps: ConstructConfigChangeDeps,
): Promise<ConfigChangeOutput> {
  // (1) Re-read now: everything below is about these bytes and no others.
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
    // Stated, not inferred: a field set adds no hook; `config.hook.add` states its own.
    addsHook: false,
    candidate: candidateSet(set, [{ path: target.path, bytes: edit.bytes }]),
  }, {
    kind: 'fields',
    changes: [{ op: 'set', path: configSegments(input.path), value: input.value }],
  }, set, deps)
}

// A create is never an upsert: `setIn` at an occupied path replaces it and drops its comments.
export async function createConfigTarget(
  input: ConfigTargetCreateInput & { readonly action: string },
  deps: ConstructConfigChangeDeps,
): Promise<ConfigChangeOutput> {
  const set = await deps.configFiles.read()
  const target = requireConfigFile(set)
  const entryPath = `${TARGETS_PATH}.${input.name}`

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

  // One structured block, so the diff reads as one addition; an undeclared class stays undeclared.
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

// The refusal lists configured names, because an unknown target is usually a near miss.
export async function editConfigTarget(
  input: ConfigTargetEditInput & { readonly action: string },
  deps: ConstructConfigChangeDeps,
): Promise<ConfigChangeOutput> {
  const set = await deps.configFiles.read()
  const target = requireConfigFile(set)
  const entryPath = `${TARGETS_PATH}.${input.name}`

  // A url is the only change, and it is not a reference.
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

// Writes only `plugins.auth`, the one place the config declares an auth plugin; `target` resolves.
export async function setConfigAuth(
  input: ConfigAuthSetInput & { readonly action: string },
  deps: ConstructConfigChangeDeps,
): Promise<ConfigChangeOutput> {
  const set = await deps.configFiles.read()
  const target = requireConfigFile(set)

  // References are checked first, before the document is touched; `target` resolves, never writes.
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

// The hook id is minted by the host, because `HookDefinitionSchema` refuses a hand-built one.
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
    // Stated, not inferred: this op adds hooks.
    addsHook: true,
    candidate: candidateSet(set, [{ path: hooksMember.path, bytes: written.bytes }]),
  }, { kind: 'files' }, set, deps)
}

// A separate type: only the scaffold renders content it did not compute from the committed file.
export interface ConstructConfigScaffoldDeps extends ConstructConfigChangeDeps {
  readonly scaffoldContent: ConfigScaffoldContentPortLike
}

// Refuses only when targets are declared; a config file with none is merged into, not replaced.
export async function scaffoldConfigProject(
  input: ConfigProjectScaffoldInput & { readonly action: string },
  deps: ConstructConfigScaffoldDeps,
): Promise<ConfigChangeOutput> {
  const verdict = parseHostnameToken(input.domain)
  if (verdict.kind === 'not-a-hostname') {
    return { outcome: 'refused', reason: 'not-a-hostname', detail: HOSTNAME_GATE_REFUSAL_DETAIL }
  }

  // (1) The re-read, as every other action does it.
  const set = await deps.configFiles.read()
  const existingConfig = requireConfigFile(set)

  // A config file with no `registry.targets` entries declares nothing this op would replace.
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

  // A hooks file is added only from zero, so `addsHook` must be false when merging into one.
  const hooksMember = set.files.find((file) => file.path === set.hooksFile)
  const addsHook = hooksMember?.bytes === undefined

  const rendered = await deps.scaffoldContent.render({
    targetName: verdict.targetName,
    baseUrl: verdict.baseUrl,
    ...(gitignore?.bytes === undefined ? {} : { existingGitignore: gitignore.bytes }),
    // Merge mode only when there are bytes to merge into; goldens pin the from-zero output.
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
      // True exactly when the hooks file did not exist; see `addsHook`'s derivation above.
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

// `HookDefinitionSchema` requires `timeout`, so an omitted one takes this default.
const DEFAULT_HOOK_TIMEOUT = '30s'

// Schema validation of a reference field, not secret detection; the detail never quotes the value.
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

// Handed only the members whose bytes differ, so `files` says what changed.
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

  // (3) Publication re-checks the digests recorded here.
  const rendered = renderConfigDiff(diffInput)

  // The renderer decides whether anything changed, so the diff and `no-change` cannot disagree.
  if (rendered.outcome === 'unchanged') return { kind: 'no-change' }

  const digestsByPath = new Map(rendered.perFileDigests.map((digest) => [digest.path, digest]))

  // (4) The whole candidate set; each door masks declared values in what it shows.
  const validation = await deps.configValidate.validate({
    configFile: set.configFile,
    hooksFile: set.hooksFile,
    files: plan.candidate,
  })
  if (!validation.ok) {
    // The report names the file the issue is about, unioned with the files this change diffed.
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

  // (5) Per value, over the port's own file-set enumeration, so classifier and writer agree.
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

// A blocked change is answered with nothing kept; a clean one goes to the direct writer.
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
  // The fields arm's `marker_written_back` answer, for a whole file.
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
