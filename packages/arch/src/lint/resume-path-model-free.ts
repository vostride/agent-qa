// Walks the recovery entry's whole import closure, so a helper beside it cannot reach a model.

import { relative } from 'node:path'

import { classifySpecifier, extractSpecifiers, sourceFilesFor } from './extract-specifiers.js'
import type { SpecifierHit } from './extract-specifiers.js'

/** The package the pinned entries live in, and therefore the package whose sources are walked. */
export const RESUME_PATH_PACKAGE_DIR = 'packages/agent-local'

// A self-reference through `exports` is a sibling import; a test pins this name to the manifest.
export const RESUME_PATH_SELF_PACKAGE_NAME = '@vostride/agent-qa-agent-local'

/**
 * The recovery/resume composition entries, by exact repo-relative path.
 *
 * One today. A file list rather than a directory prefix on purpose: the claim is about the entry a
 * host calls to resume work somebody else abandoned, and a prefix would quietly cover — or quietly
 * stop covering — whatever else moved into the same directory.
 */
export const RESUME_PATH_ENTRY_FILES = [
  // The model-free recovery entry every resuming host composes.
  'packages/agent-local/src/composition/compose-job-recovery.ts',
] as const

/**
 * The packages no file in a resume path's closure may name, each with the reason it is listed.
 *
 * A rationale per entry, so a reader who disagrees knows exactly which capability the entry is
 * about rather than having to infer it from a package name.
 */
export const RESUME_PATH_FORBIDDEN_PACKAGES: Readonly<Record<string, string>> = {
  '@vostride/agent-qa-model': 'the first-party model registry, the one place a provider handle is constructed',
  ai: 'the provider substrate: a path that can name it can build a model without naming any provider',
}

/** Every provider SDK, as a prefix — the set is open and naming its members would date this file. */
export const RESUME_PATH_FORBIDDEN_PACKAGE_PREFIX = '@ai-sdk/'

const FORBIDDEN_PREFIX_RATIONALE =
  'a provider SDK, which is a model constructor under a vendor name'

/** The rationale this rule reports for a specifier, or undefined when the specifier is fine. */
export function resumePathForbiddenRationale(specifier: string): string | undefined {
  const classified = classifySpecifier(specifier)
  if (classified.kind !== 'internal' && classified.kind !== 'external') return undefined
  if (classified.pkgName.startsWith(RESUME_PATH_FORBIDDEN_PACKAGE_PREFIX)) {
    return FORBIDDEN_PREFIX_RATIONALE
  }
  return RESUME_PATH_FORBIDDEN_PACKAGES[classified.pkgName]
}

export interface ResumePathModule {
  /** Repo-relative, forward slashes. */
  readonly file: string
  readonly specifiers: readonly SpecifierHit[]
}

function normalizeRepoPath(file: string): string {
  return file.replaceAll('\\', '/')
}

/**
 * Where a relative specifier could land, most specific first.
 *
 * Resolution is done against the scanned set rather than against the filesystem: the rule's input
 * is the set of files it was handed, so a specifier that resolves to a real file nobody scanned is
 * a hole and has to be reported as one, not silently resolved behind the rule's back.
 */
export function resumePathRelativeCandidates(fromFile: string, specifier: string): string[] {
  const segments = [...normalizeRepoPath(fromFile).split('/').slice(0, -1), ...specifier.split('/')]
  const stack: string[] = []
  for (const segment of segments) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      stack.pop()
      continue
    }
    stack.push(segment)
  }
  const joined = stack.join('/')
  const stem = joined.replace(/\.js$/, '')
  return [joined, `${stem}.ts`, `${stem}.tsx`, `${stem}/index.ts`]
}

/**
 * Where a self-package specifier could land, most specific first.
 *
 * `@vostride/agent-qa-agent-local` is the barrel; a subpath is the same file the equivalent
 * relative specifier would have named, so the candidate list is built the same way and resolved
 * against the scanned set for the same reason.
 */
export function resumePathSelfPackageCandidates(specifier: string): string[] {
  const subpath = specifier.slice(RESUME_PATH_SELF_PACKAGE_NAME.length).replace(/^\//, '')
  if (subpath === '') return [`${RESUME_PATH_PACKAGE_DIR}/src/index.ts`]
  const joined = `${RESUME_PATH_PACKAGE_DIR}/src/${subpath}`
  const stem = joined.replace(/\.js$/, '')
  return [joined, `${stem}.ts`, `${stem}.tsx`, `${stem}/index.ts`]
}

/** Which edge class an unfollowable specifier belonged to, so its report can say why it counts. */
export type ResumePathUnresolvedEdge = 'relative' | 'self-package'

export interface ResumePathClosure {
  /** Every file reachable from the entries by an in-package import, including the entries. */
  readonly files: readonly string[]
  /** Which entry each file was first reached from, for the offender messages. */
  readonly reachedFrom: ReadonlyMap<string, string>
  /** Pinned entries the scanned set does not contain. */
  readonly missingEntries: readonly string[]
  /** In-package specifiers the walk could not resolve inside the scanned set. */
  readonly unresolved: readonly {
    readonly from: string
    readonly hit: SpecifierHit
    readonly edge: ResumePathUnresolvedEdge
  }[]
}

/**
 * How the walk treats one specifier: follow it into the package, or leave it to another rule.
 *
 * Exactly two classes are followed, and the second is why this function exists as a named step
 * rather than a condition inside the loop. A specifier naming ANOTHER package is a boundary
 * crossing, which is layer 1's subject and not this rule's — a walk that followed those would
 * report the whole workspace and mean nothing. A specifier naming THIS package is not a boundary
 * crossing at all: `exports` makes it resolve to a sibling file, so it is a real edge of the
 * resume path, and there is no third answer available. Following it or reporting it are the only
 * options, because skipping it is what let a model import hide behind an import style.
 */
function resumePathWalkCandidates(
  fromFile: string,
  specifier: string,
): { readonly edge: ResumePathUnresolvedEdge; readonly candidates: string[] } | undefined {
  const classified = classifySpecifier(specifier)
  if (classified.kind === 'relative') {
    return { edge: 'relative', candidates: resumePathRelativeCandidates(fromFile, specifier) }
  }
  if (classified.kind === 'internal' && classified.pkgName === RESUME_PATH_SELF_PACKAGE_NAME) {
    return { edge: 'self-package', candidates: resumePathSelfPackageCandidates(specifier) }
  }
  return undefined
}

export function resumePathClosureOf(
  modules: readonly ResumePathModule[],
  entries: readonly string[] = RESUME_PATH_ENTRY_FILES,
): ResumePathClosure {
  const byFile = new Map(modules.map((module) => [normalizeRepoPath(module.file), module]))
  const files: string[] = []
  const reachedFrom = new Map<string, string>()
  const missingEntries: string[] = []
  const unresolved: { from: string; hit: SpecifierHit; edge: ResumePathUnresolvedEdge }[] = []

  for (const rawEntry of entries) {
    const entry = normalizeRepoPath(rawEntry)
    if (!byFile.has(entry)) {
      missingEntries.push(entry)
      continue
    }
    const pending = [entry]
    while (pending.length > 0) {
      const file = pending.shift()!
      if (reachedFrom.has(file)) continue
      reachedFrom.set(file, entry)
      files.push(file)
      for (const hit of byFile.get(file)!.specifiers) {
        const walk = resumePathWalkCandidates(file, hit.specifier)
        if (walk === undefined) continue
        const resolved = walk.candidates.find((candidate) => byFile.has(candidate))
        if (resolved === undefined) {
          unresolved.push({ from: file, hit, edge: walk.edge })
          continue
        }
        if (!reachedFrom.has(resolved)) pending.push(resolved)
      }
    }
  }

  return { files: files.sort(), reachedFrom, missingEntries, unresolved }
}

/**
 * The rule. Four ways to fail, and three of them are about the rule itself being able to fail.
 */
export function findResumePathModelFreeOffenders(
  modules: readonly ResumePathModule[],
  entries: readonly string[] = RESUME_PATH_ENTRY_FILES,
): string[] {
  const offenders: string[] = []
  const closure = resumePathClosureOf(modules, entries)
  const byFile = new Map(modules.map((module) => [normalizeRepoPath(module.file), module]))

  // ANTI-VACUITY 1: a pin that names a file nobody scanned checks nothing at all.
  for (const entry of closure.missingEntries) {
    offenders.push(
      `resume-path-model-free: ${entry} ⇏ the pinned resume entry is not in the scanned set` +
        ` (it moved, was renamed, or its package left ${RESUME_PATH_PACKAGE_DIR} — repoint the pin,` +
        ' because a rule whose subject does not exist passes forever and reads like proof)',
    )
  }

  // ANTI-VACUITY 2: a closure that is the entry alone means the walk is not walking. The resume
  // entry composes a store out of sibling modules, so its closure is never one file.
  for (const rawEntry of entries) {
    const entry = normalizeRepoPath(rawEntry)
    if (!byFile.has(entry)) continue
    const reached = closure.files.filter((file) => closure.reachedFrom.get(file) === entry)
    if (reached.length > 1) continue
    offenders.push(
      `resume-path-model-free: ${entry} ⇏ its import closure is the entry alone` +
        ' (the entry composes a durable store out of sibling modules, so a closure of one means the' +
        ' walk stopped following relative imports — and a one-file check is defeated by a one-line' +
        ' helper module beside the entry, which is exactly the shape this rule exists to catch)',
    )
  }

  // ANTI-VACUITY 3: an unfollowable in-package import is an unexamined branch of the closure.
  for (const { from, hit, edge } of closure.unresolved) {
    offenders.push(
      `resume-path-model-free: ${from}:${hit.line} ⇏ ${hit.specifier} could not be followed` +
        ` inside ${RESUME_PATH_PACKAGE_DIR} (an unresolved edge is a part of the resume path this` +
        ' rule did not read, so it is reported rather than skipped)' +
        (edge === 'self-package'
          ? ` — and this one names ${RESUME_PATH_SELF_PACKAGE_NAME}, the package being walked.` +
            ' A self-reference resolves through the package\'s own exports map to a sibling file,' +
            ' so it is an ordinary runtime edge of the resume path rather than the boundary' +
            ' crossing layer 1 owns. Leaving it unexamined is precisely the "one-line helper' +
            ' module beside the entry" defeat this rule exists to close, wearing a package name'
          : ''),
    )
  }

  // Type-only imports count: a package named as a type is still a dependency of this file.
  for (const file of closure.files) {
    for (const hit of byFile.get(file)!.specifiers) {
      const rationale = resumePathForbiddenRationale(hit.specifier)
      if (rationale === undefined) continue
      offenders.push(
        `resume-path-model-free: ${file}:${hit.line} ⇏ ${hit.specifier} (${rationale};` +
          ` reached from ${closure.reachedFrom.get(file) ?? file})` +
          ' — the resume entry and everything it imports stay model-free so crash recovery is' +
          ' STRUCTURALLY incapable of re-invoking the model: a resumed job re-reads its recorded' +
          ' checkpoint and control never reaches the author callback, and the capability a' +
          ' legitimately re-authoring resume needs arrives already built from the host as an' +
          ' ordinary argument. An import here would put a construction path back on the resume' +
          ' side, which is the one thing this rule exists to make unrepresentable',
      )
    }
  }

  return offenders
}

/** Every source file of a package, with its specifiers, repo-relative — the rule's real input. */
export function resumePathModules(packageDir: string, repoRoot: string): ResumePathModule[] {
  return sourceFilesFor(packageDir, repoRoot).map((absFile) => ({
    file: normalizeRepoPath(relative(repoRoot, absFile)),
    specifiers: extractSpecifiers(absFile).map((hit) => ({
      ...hit,
      file: normalizeRepoPath(relative(repoRoot, hit.file)),
    })),
  }))
}
