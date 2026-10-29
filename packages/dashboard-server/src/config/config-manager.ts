import { createHash, randomUUID } from 'node:crypto'
import { chmod, lstat, readFile, realpath, writeFile, mkdir, rename, rm, stat } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import {
  Document,
  isMap,
  isNode,
  isScalar,
  isSeq,
  parseDocument,
  visit,
  type Node,
} from 'yaml'
import { AgentQaConfigSchema } from '@vostride/agent-qa-core'
import {
  CONFIG_NAMED_ARRAYS,
  CONFIG_REVISION_ABSENT,
  MARKER_WRITTEN_BACK_SENTENCE,
  maskPayloadTree,
  type ConfigChange,
  type ConfigPathSegment,
  type ConfigWriteIssue,
  type ConfigWriteRefusal,
  type MaskFn,
} from '@vostride/agent-qa-schema'

export type ApplyChangesOutcome =
  | { kind: 'ok'; revision: string; baseRevision: string; priors?: ConfigPriors }
  | {
    kind: 'refused'
    error: Exclude<ConfigWriteRefusal, 'write_failed'>
    issues?: ConfigWriteIssue[]
    /** The field an `expect` found changed. */
    path?: ConfigPathSegment[]
  }

type FieldState = { present: false } | { present: true; value: unknown }

// The nodes are the file's own, so a restore brings back real secrets and comments.
export type ConfigPrior =
  | { kind: 'entry'; array: ConfigPathSegment[]; name: string; index: number; node: Node }
  | { kind: 'path'; path: ConfigPathSegment[]; before: Node | null | undefined; after: FieldState }

export type ConfigPriors = readonly ConfigPrior[]

/** A whole-document replacement, checked against the bytes the caller read. */
export type ReplaceDocumentOutcome =
  | { kind: 'ok'; revision: string; baseRevision: string }
  | { kind: 'refused'; error: 'file_changed'; revision: string }
  | { kind: 'refused'; error: 'marker_written_back'; message: string }

export type RestorePriorsOutcome =
  | { kind: 'ok'; revision: string }
  | { kind: 'refused'; error: 'undo_conflict' | 'file_invalid' }

export type ConfigReadOutcome =
  | { kind: 'ok'; config: Record<string, unknown>; raw: string; revision: string }
  | { kind: 'absent' }
  | { kind: 'file_invalid'; message: string; revision: string }

/** One line of the config file, as the declared mask shows it. */
export interface ConfigFileLine {
  n: number
  text: string
}

export type MaskedConfigOutcome =
  | {
    kind: 'ok'
    config: Record<string, unknown>
    revision: string
    lines: ConfigFileLine[]
    fileIssues: ConfigWriteIssue[]
  }
  | { kind: 'file_invalid'; message: string; revision: string }

// Kept on `globalThis` so a second module copy joins the same per-path queue; not cross-process.
const CONFIG_WRITE_QUEUES = Symbol.for('agent-qa.config-write-queues')

function configWriteQueues(): Map<string, Promise<void>> {
  const holder = globalThis as { [CONFIG_WRITE_QUEUES]?: Map<string, Promise<void>> }
  holder[CONFIG_WRITE_QUEUES] ??= new Map()
  return holder[CONFIG_WRITE_QUEUES]
}

// The file itself when it exists, so a symlink and a directory alias share its queue; otherwise
// its real directory, so a file created by the first writer keeps the key the second one used.
function configWriteQueueKey(configPath: string): string {
  const absolute = resolve(configPath)
  try {
    return realpathSync(absolute)
  } catch {
    try {
      return join(realpathSync(dirname(absolute)), basename(absolute))
    } catch {
      return absolute
    }
  }
}

/** Run `work` in this path's turn. The queue moves on however `work` settles. */
export function serializeConfigWrite<T>(configPath: string, work: () => Promise<T>): Promise<T> {
  const queues = configWriteQueues()
  const key = configWriteQueueKey(configPath)
  const next = (queues.get(key) ?? Promise.resolve()).then(work)
  const tail = next.then(() => undefined, () => undefined)
  queues.set(key, tail)
  void tail.then(() => {
    if (queues.get(key) === tail) queues.delete(key)
  })
  return next
}

function isMissingFile(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | undefined)?.code === 'ENOENT'
}

export class ConfigFileInvalidError extends Error {
  constructor(message: string) {
    super(`The config file does not parse: ${message}`)
    this.name = 'ConfigFileInvalidError'
  }
}

// A missing file reads as empty; a file that does not parse is an error, not a partial recovery.
export async function readConfigValues(manager: ConfigManager): Promise<Record<string, unknown>> {
  const read = await manager.readWithRevision()
  if (read.kind === 'ok') return read.config
  if (read.kind === 'absent') return {}
  throw new ConfigFileInvalidError(read.message)
}

export class ConfigManager {
  constructor(private configPath: string, readonly mask: MaskFn) {}

  // A whole document may keep a marker the file already holds, as often, but never add one.
  static addsShownMarker(current: Uint8Array | undefined, next: Uint8Array): boolean {
    const held = shownMarkerCounts(current)
    for (const [marker, count] of shownMarkerCounts(next)) {
      if (count > (held.get(marker) ?? 0)) return true
    }
    return false
  }

  // A half-edited file is named, never served as the partial config yaml recovers.
  async readWithRevision(): Promise<ConfigReadOutcome> {
    const read = await this.readParsed()
    if (read.kind !== 'ok') return read
    return { kind: 'ok', config: read.config, raw: read.raw, revision: read.revision }
  }

  // The payload and the file view pass through the declared mask and nothing else.
  async readMasked(): Promise<MaskedConfigOutcome> {
    const read = await this.readParsed()
    if (read.kind === 'absent') {
      return { kind: 'ok', config: {}, revision: CONFIG_REVISION_ABSENT, lines: [], fileIssues: [] }
    }
    if (read.kind === 'file_invalid') return { ...read, message: this.maskSummary(read.message) }
    const masked = maskDocument(read.doc, this.mask)
    const config = (masked.toJSON() as Record<string, unknown> | null) ?? {}
    const parsed = AgentQaConfigSchema.safeParse(normalizeForValidation(read.config))
    const fileIssues = parsed.success
      ? []
      : parsed.error.issues.map((issue) => maskedIssue(issue, this.mask))
    const lines = fileLines(this.mask(read.raw))
    return { kind: 'ok', config, revision: read.revision, lines, fileIssues }
  }

  // A file that does not parse can leave the declared secrets unreadable; its message is then withheld.
  private maskSummary(message: string): string {
    try {
      return this.mask(message)
    } catch {
      return 'The config file is not valid YAML.'
    }
  }

  private async readParsed(): Promise<
    | { kind: 'ok'; doc: Document; config: Record<string, unknown>; raw: string; revision: string }
    | { kind: 'absent' }
    | { kind: 'file_invalid'; message: string; revision: string }
  > {
    let bytes: Buffer
    try {
      bytes = await readFile(this.configPath)
    } catch (err: unknown) {
      if (isMissingFile(err)) return { kind: 'absent' }
      throw err
    }
    const revision = createHash('sha256').update(bytes).digest('hex')
    const raw = bytes.toString('utf-8')
    const doc = parseDocument(raw)
    if (doc.errors.length > 0) {
      return { kind: 'file_invalid', message: parseErrorSummary(doc), revision }
    }
    return {
      kind: 'ok',
      doc,
      config: (doc.toJSON() as Record<string, unknown> | null) ?? {},
      raw,
      revision,
    }
  }

  // One transaction per request, serialised so overlapping autosaves never drop each other's field.
  async applyChanges(
    changes: readonly ConfigChange[],
    options: { capturePriors?: boolean } = {},
  ): Promise<ApplyChangesOutcome> {
    const marked = changeWithShownMarker(changes)
    if (marked !== undefined) {
      return {
        kind: 'refused',
        error: 'marker_written_back',
        issues: [{
          path: marked.path.map((segment) => (typeof segment === 'object' ? segment.name : segment)),
          message: MARKER_WRITTEN_BACK_SENTENCE,
        }],
      }
    }
    return this.serialized(() => this.applyChangesOnce(changes, options.capturePriors === true))
  }

  // An Undo restores newest first; a field written after the change is never overwritten.
  async restorePriors(priors: ConfigPriors): Promise<RestorePriorsOutcome> {
    return this.serialized(() => this.restorePriorsOnce(priors))
  }

  // A generated whole-file change publishes only over the bytes it is built from, re-read in turn.
  async replaceDocument(expectedRevision: string, content: Uint8Array): Promise<ReplaceDocumentOutcome> {
    return this.serialized(async () => {
      let current: Buffer | undefined
      try {
        current = await readFile(this.configPath)
      } catch (err: unknown) {
        if (!isMissingFile(err)) throw err
      }
      const revision = current === undefined
        ? CONFIG_REVISION_ABSENT
        : createHash('sha256').update(current).digest('hex')
      if (revision !== expectedRevision) return { kind: 'refused', error: 'file_changed', revision }
      if (ConfigManager.addsShownMarker(current, content)) {
        return { kind: 'refused', error: 'marker_written_back', message: MARKER_WRITTEN_BACK_SENTENCE }
      }
      await this.writeAtomic(content)
      return { kind: 'ok', revision: createHash('sha256').update(content).digest('hex'), baseRevision: revision }
    })
  }

  private serialized<T>(work: () => Promise<T>): Promise<T> {
    return serializeConfigWrite(this.configPath, work)
  }

  private async restorePriorsOnce(priors: ConfigPriors): Promise<RestorePriorsOutcome> {
    let doc: Document
    try {
      doc = parseDocument(await readFile(this.configPath, 'utf-8'))
    } catch (err: unknown) {
      if (isMissingFile(err)) return { kind: 'refused', error: 'undo_conflict' }
      throw err
    }
    if (doc.errors.length > 0) return { kind: 'refused', error: 'file_invalid' }
    let next: string
    try {
      for (const prior of [...priors].reverse()) {
        if (!restorePrior(doc, prior)) return { kind: 'refused', error: 'undo_conflict' }
      }
      const parsed = AgentQaConfigSchema.safeParse(normalizeForValidation(doc.toJSON()))
      if (!parsed.success) return { kind: 'refused', error: 'undo_conflict' }
      next = doc.toString()
    } catch {
      // A restored node that no longer fits the file (an alias whose anchor is gone) is not restorable.
      return { kind: 'refused', error: 'undo_conflict' }
    }
    await this.writeAtomic(next)
    return { kind: 'ok', revision: revisionOf(next) }
  }

  private async applyChangesOnce(
    changes: readonly ConfigChange[],
    capturePriors: boolean,
  ): Promise<ApplyChangesOutcome> {
    let doc: Document
    // The revision of the bytes this write merges onto, so a page can spot an absorbed outside edit
    let baseRevision: string
    try {
      const bytes = await readFile(this.configPath)
      baseRevision = createHash('sha256').update(bytes).digest('hex')
      doc = parseDocument(bytes.toString('utf-8'))
    } catch (err: unknown) {
      if (!isMissingFile(err)) throw err
      // A missing file starts empty and goes through `setIn`, so no dotted top-level key is made.
      baseRevision = CONFIG_REVISION_ABSENT
      doc = new Document()
    }
    // yaml recovers a partial tree from a broken file and refuses to stringify it: never rewrite one.
    if (doc.errors.length > 0) return { kind: 'refused', error: 'file_invalid' }
    // Every expect is checked against the file as read, before anything applies.
    const expects = changes.filter((change) => change.op === 'expect')
    for (const change of expects) {
      if (!expectHolds(doc, change.path, change.value ?? null, this.mask)) {
        return { kind: 'refused', error: 'field_changed', path: [...change.path] }
      }
    }
    let writesBrowserHeadless = false
    const priors: ConfigPrior[] = []
    for (const change of changes) {
      if (change.op === 'expect') continue
      if (change.op === 'move') {
        const moved = moveField(doc, change.from, change.path, capturePriors)
        if (moved.kind === 'refused') return moved
        priors.push(...moved.priors)
        continue
      }
      const path = resolvePath(doc, change.path)
      if (path === undefined) return { kind: 'refused', error: 'path_not_found' }
      const entry = capturePriors ? namedEntryPrior(doc, change, path) : undefined
      const before = capturePriors && entry === undefined ? nodeAt(doc, path) : undefined
      let legacyPrior: ConfigPrior | undefined
      try {
        if (change.op === 'set') {
          doc.setIn(path, doc.createNode(change.value))
          writesBrowserHeadless ||= setsLeaf(path, change.value, BROWSER_HEADLESS_PATH)
        } else if (change.op === 'set-if-absent') {
          // Required-sibling completion is decided by the file at this point of the transaction.
          if (doc.hasIn(path)) continue
          if (samePath(path, BROWSER_HEADLESS_PATH) && doc.hasIn(LEGACY_HEADLESS_PATH)) {
            // The owner's root use.headless is the value completion keeps, under its new key.
            const legacy = nodeAt(doc, LEGACY_HEADLESS_PATH)
            doc.setIn(path, legacy === undefined || legacy === null ? null : legacy)
            if (capturePriors) {
              legacyPrior = { kind: 'path', path: [...LEGACY_HEADLESS_PATH], before: legacy, after: { present: false } }
            }
            doc.deleteIn(LEGACY_HEADLESS_PATH)
          } else {
            doc.setIn(path, doc.createNode(change.value))
          }
        } else if (change.op === 'unset') {
          unsetAndPrune(doc, path)
        } else if (!appendTo(doc, path, change.value)) {
          return { kind: 'refused', error: 'path_not_found' }
        }
      } catch {
        // yaml throws when a path walks through a scalar: the field the change names is not there.
        return { kind: 'refused', error: 'path_not_found' }
      }
      if (entry !== undefined) priors.push(entry)
      else if (capturePriors) {
        priors.push({ kind: 'path', path: [...change.path], before, after: fieldState(doc, path) })
      }
      if (legacyPrior !== undefined) priors.push(legacyPrior)
    }
    // The browser-scoped key replaces a root use.headless in the same write.
    if (writesBrowserHeadless && doc.hasIn(LEGACY_HEADLESS_PATH)) {
      const before = capturePriors ? nodeAt(doc, LEGACY_HEADLESS_PATH) : undefined
      doc.deleteIn(LEGACY_HEADLESS_PATH)
      if (capturePriors) {
        priors.push({ kind: 'path', path: [...LEGACY_HEADLESS_PATH], before, after: { present: false } })
      }
    }

    const parsed = AgentQaConfigSchema.safeParse(normalizeForValidation(doc.toJSON()))
    if (!parsed.success) {
      return {
        kind: 'refused',
        error: 'validation_failed',
        issues: parsed.error.issues.map((issue) => maskedIssue(issue, this.mask)),
      }
    }

    const next = doc.toString()
    await this.writeAtomic(next)
    return capturePriors
      ? { kind: 'ok', revision: revisionOf(next), baseRevision, priors }
      : { kind: 'ok', revision: revisionOf(next), baseRevision }
  }

  // The temp file sits beside the real one and is chmodded, as the umask filters `writeFile` modes.
  private async writeAtomic(content: string | Uint8Array): Promise<void> {
    const target = await this.writeTarget()
    const directory = dirname(target)
    const tempPath = join(directory, `.${basename(target)}.${process.pid}.${randomUUID()}.tmp`)
    const mode = await stat(target).then(
      (stats) => stats.mode & 0o777,
      (err: unknown) => {
        if (isMissingFile(err)) return undefined
        throw err
      },
    )
    await mkdir(directory, { recursive: true })
    try {
      await writeFile(tempPath, content, mode === undefined ? undefined : { mode })
      if (mode !== undefined) await chmod(tempPath, mode)
      await rename(tempPath, target)
    } catch (error) {
      await rm(tempPath, { force: true }).catch(() => undefined)
      throw error
    }
  }

  // A symlinked config keeps its link: the file it points at is the one replaced.
  private async writeTarget(): Promise<string> {
    const isLink = await lstat(this.configPath).then(
      (stats) => stats.isSymbolicLink(),
      (err: unknown) => {
        if (isMissingFile(err)) return false
        throw err
      },
    )
    return isLink ? await realpath(this.configPath) : this.configPath
  }
}

// A read shows a declared secret as `[secret:<name>]`; writing that text would clobber the value.
const SHOWN_MARKER = /\[secret:\w+\]/

export function holdsShownMarker(value: unknown): boolean {
  if (typeof value === 'string') return SHOWN_MARKER.test(value)
  if (Array.isArray(value)) return value.some(holdsShownMarker)
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).some(
      ([key, entry]) => SHOWN_MARKER.test(key) || holdsShownMarker(entry),
    )
  }
  return false
}

function shownMarkerCounts(bytes: Uint8Array | undefined): Map<string, number> {
  const counts = new Map<string, number>()
  if (bytes === undefined) return counts
  for (const [marker] of Buffer.from(bytes).toString('utf-8').matchAll(/\[secret:\w+\]/g)) {
    counts.set(marker, (counts.get(marker) ?? 0) + 1)
  }
  return counts
}

function pathHoldsShownMarker(path: readonly ConfigPathSegment[]): boolean {
  return path.some((segment) => (typeof segment === 'object'
    ? SHOWN_MARKER.test(segment.name)
    : typeof segment === 'string' && SHOWN_MARKER.test(segment)))
}

// An expect writes nothing, so only the ops that write are checked.
function changeWithShownMarker(changes: readonly ConfigChange[]): ConfigChange | undefined {
  return changes.find((change) => {
    if (change.op === 'expect') return false
    if (pathHoldsShownMarker(change.path)) return true
    if (change.op === 'move') return pathHoldsShownMarker(change.from)
    return change.op !== 'unset' && holdsShownMarker(change.value)
  })
}

// A key segment is config text, so it passes the declared mask with the message.
function maskedIssue(
  issue: { path: readonly PropertyKey[]; message: string },
  mask: MaskFn,
): ConfigWriteIssue {
  return {
    path: issue.path.map((key) => (typeof key === 'number' ? key : mask(String(key)))),
    message: mask(issue.message),
  }
}

type ResolvedPath = (string | number)[]

const NAMED_ARRAY_PATHS: readonly (readonly string[])[] = CONFIG_NAMED_ARRAYS.map((named) => named.split('.'))
const BROWSER_HEADLESS_PATH = ['use', 'browser', 'headless']
const LEGACY_HEADLESS_PATH = ['use', 'headless']

function samePath(a: readonly (string | number)[], b: readonly (string | number)[]): boolean {
  return a.length === b.length && a.every((segment, i) => segment === b[i])
}

// A { name } segment is resolved to the index its entry has in the file now, and only inside the
// named arrays, so an outside reorder can never redirect a change to another entry.
function resolvePath(doc: Document, path: readonly ConfigPathSegment[]): ResolvedPath | undefined {
  const resolved: ResolvedPath = []
  for (const segment of path) {
    if (typeof segment !== 'object') {
      resolved.push(segment)
      continue
    }
    if (!NAMED_ARRAY_PATHS.some((named) => samePath(named, resolved))) return undefined
    const seq = doc.getIn(resolved, true)
    if (!isSeq(seq)) return undefined
    const index = seq.items.findIndex((item) => isMap(item) && item.get('name') === segment.name)
    if (index < 0) return undefined
    resolved.push(index)
  }
  return resolved
}

// Deleting a leaf leaves `parent: {}`, which a section schema can reject, so every ancestor map the
// delete empties goes too. A sequence entry is never pruned: that would shift its siblings.
function unsetAndPrune(doc: Document, path: ResolvedPath): void {
  if (!doc.hasIn(path)) return
  doc.deleteIn(path)
  for (let depth = path.length - 1; depth >= 1; depth--) {
    const ancestor = path.slice(0, depth)
    if (typeof ancestor[depth - 1] !== 'string') return
    const node = doc.getIn(ancestor, true)
    if (!isMap(node) || node.items.length > 0) return
    doc.deleteIn(ancestor)
  }
}

// A rename re-keys the file's own node, which lands before `from` is pruned.
function moveField(
  doc: Document,
  from: readonly ConfigPathSegment[],
  to: readonly ConfigPathSegment[],
  capturePriors: boolean,
): { kind: 'ok'; priors: ConfigPrior[] } | { kind: 'refused'; error: 'path_not_found' | 'path_not_writable' } {
  const fromPath = resolvePath(doc, from)
  const toPath = resolvePath(doc, to)
  if (fromPath === undefined || toPath === undefined) return { kind: 'refused', error: 'path_not_found' }
  const node = nodeAt(doc, fromPath)
  if (node === undefined) return { kind: 'refused', error: 'path_not_found' }
  if (samePath(fromPath, toPath)) return { kind: 'ok', priors: [] }
  if (isPrefix(fromPath, toPath) || isPrefix(toPath, fromPath)) {
    return { kind: 'refused', error: 'path_not_writable' }
  }
  const before = capturePriors ? nodeAt(doc, toPath) : undefined
  try {
    doc.setIn(toPath, node)
  } catch {
    return { kind: 'refused', error: 'path_not_found' }
  }
  unsetAndPrune(doc, fromPath)
  if (!capturePriors) return { kind: 'ok', priors: [] }
  return {
    kind: 'ok',
    priors: [
      { kind: 'path', path: [...from], before: node === null ? null : node.clone() as Node, after: { present: false } },
      { kind: 'path', path: [...to], before, after: fieldState(doc, toPath) },
    ],
  }
}

function isPrefix(prefix: ResolvedPath, path: ResolvedPath): boolean {
  return prefix.length < path.length && samePath(prefix, path.slice(0, prefix.length))
}

// An unset of one named-array entry is recorded as the entry itself, so Undo re-inserts it by
// name at its index instead of comparing the whole list.
function namedEntryPrior(doc: Document, change: ConfigChange, path: ResolvedPath): ConfigPrior | undefined {
  const last = change.path[change.path.length - 1]
  if (change.op !== 'unset' || typeof last !== 'object') return undefined
  const index = path[path.length - 1]
  const node = doc.getIn(path, true)
  if (typeof index !== 'number' || !isNode(node)) return undefined
  return { kind: 'entry', array: change.path.slice(0, -1), name: last.name, index, node: node.clone() as Node }
}

// undefined: the field is absent. null: the key is there with no value.
function nodeAt(doc: Document, path: ResolvedPath): Node | null | undefined {
  if (!doc.hasIn(path)) return undefined
  const node = doc.getIn(path, true)
  if (isNode(node)) return node.clone() as Node
  return node === undefined || node === null ? null : doc.createNode(node)
}

function fieldState(doc: Document, path: ResolvedPath): FieldState {
  if (!doc.hasIn(path)) return { present: false }
  const node = doc.getIn(path, true)
  return { present: true, value: isNode(node) ? node.toJS(doc) : node ?? null }
}

// What an expect compares against: the field's value as the file holds it, null when absent. A
// selector naming no entry, or a path through a scalar, reads as absent.
function expectedFieldValue(doc: Document, path: readonly ConfigPathSegment[]): unknown {
  const resolved = resolvePath(doc, path)
  if (resolved === undefined) return null
  const state = fieldState(doc, resolved)
  return state.present ? state.value : null
}

// The page builds an expect from the masked read, so it also holds against the masked field.
function expectHolds(
  doc: Document,
  path: readonly ConfigPathSegment[],
  offered: unknown,
  mask: MaskFn,
): boolean {
  const held = expectedFieldValue(doc, path)
  if (isDeepStrictEqual(held, offered)) return true
  try {
    return isDeepStrictEqual(maskPayloadTree(held, mask), offered)
  } catch {
    return false
  }
}

function restorePrior(doc: Document, prior: ConfigPrior): boolean {
  if (prior.kind === 'entry') {
    const arrayPath = resolvePath(doc, prior.array)
    if (arrayPath === undefined) return false
    const seq = doc.getIn(arrayPath, true)
    if (seq === undefined || seq === null || (isScalar(seq) && seq.value === null)) {
      doc.setIn(arrayPath, doc.createNode([]))
      return restorePrior(doc, prior)
    }
    if (!isSeq(seq)) return false
    if (seq.items.some((item) => isMap(item) && item.get('name') === prior.name)) return false
    seq.items.splice(Math.min(prior.index, seq.items.length), 0, prior.node.clone())
    return true
  }
  const path = resolvePath(doc, prior.path)
  if (path === undefined) return false
  if (!isDeepStrictEqual(fieldState(doc, path), prior.after)) return false
  if (prior.before === undefined) unsetAndPrune(doc, path)
  else doc.setIn(path, prior.before === null ? null : prior.before.clone())
  return true
}

function appendTo(doc: Document, path: ResolvedPath, value: unknown): boolean {
  const existing = doc.getIn(path, true)
  if (existing === undefined || existing === null || (isScalar(existing) && existing.value === null)) {
    doc.setIn(path, doc.createNode([value]))
    return true
  }
  if (!isSeq(existing)) return false
  existing.add(doc.createNode(value))
  return true
}

function setsLeaf(path: ResolvedPath, value: unknown, leaf: readonly string[]): boolean {
  if (path.length > leaf.length || !samePath(path, leaf.slice(0, path.length))) return false
  let cursor = value
  for (const key of leaf.slice(path.length)) {
    if (typeof cursor !== 'object' || cursor === null || Array.isArray(cursor)) return false
    cursor = (cursor as Record<string, unknown>)[key]
  }
  return cursor !== undefined
}

// The first line only: yaml's message goes on to quote the offending source line, which can be a
// secret the page must not be served.
function parseErrorSummary(doc: Document): string {
  const first = doc.errors[0]?.message ?? 'The config file is not valid YAML.'
  return first.split('\n')[0]!.replace(/:\s*$/, '')
}

// Every scalar, key or value, is replaced by what the mask shows for it. An alias reads its masked anchor.
function maskDocument(doc: Document, mask: MaskFn): Document {
  const masked = doc.clone()
  visit(masked, {
    Scalar(_key, node) {
      if (node.value === null || node.value === undefined) return
      const text = String(node.value)
      const shown = mask(text)
      if (shown !== text) node.value = shown
    },
  })
  return masked
}

function fileLines(text: string): ConfigFileLine[] {
  const texts = text.split('\n')
  if (texts.length > 0 && texts[texts.length - 1] === '') texts.pop()
  return texts.map((lineText, i) => ({ n: i + 1, text: lineText }))
}

function revisionOf(content: string): string {
  return createHash('sha256').update(content, 'utf-8').digest('hex')
}

// Mirrors cli/src/config.ts normalizeConfigForValidation: a root use.headless is read by the CLI
// and dropped before validation, so it must not fail a dashboard write either.
function normalizeForValidation(config: unknown): unknown {
  if (typeof config !== 'object' || config === null || Array.isArray(config)) return config
  const normalized = { ...(config as Record<string, unknown>) }
  const use = normalized.use
  if (typeof use === 'object' && use !== null && !Array.isArray(use)) {
    const rest = { ...(use as Record<string, unknown>) }
    delete rest.headless
    normalized.use = rest
  }
  return normalized
}
