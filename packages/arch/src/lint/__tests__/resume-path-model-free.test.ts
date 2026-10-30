import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  RESUME_PATH_ENTRY_FILES,
  RESUME_PATH_FORBIDDEN_PACKAGES,
  RESUME_PATH_FORBIDDEN_PACKAGE_PREFIX,
  RESUME_PATH_PACKAGE_DIR,
  RESUME_PATH_SELF_PACKAGE_NAME,
  findResumePathModelFreeOffenders,
  resumePathClosureOf,
  resumePathForbiddenRationale,
  resumePathModules,
  resumePathRelativeCandidates,
} from '../resume-path-model-free.js'
import type { ResumePathModule } from '../resume-path-model-free.js'
import type { SpecifierHit } from '../extract-specifiers.js'

const testDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(testDir, '..', '..', '..', '..', '..')

const ENTRY = RESUME_PATH_ENTRY_FILES[0]
const STORE = 'packages/agent-local/src/store/sqlite-job-store.ts'
const HELPER = 'packages/agent-local/src/composition/recovery-helper.ts'
// Assembled from parts rather than spelled. A rule about model imports whose own test file names
// the model package would be read by the workspace scan that walks this package's sources — plan
// 05's "the scan found itself" lesson, one level up, and the reason `validate:arch` stays honest
// about `packages/arch`'s own dependency set.
const MODEL_PACKAGE = ['@vostride/agent', 'qa', 'model'].join('-')

function hit(specifier: string, file: string, line = 1): SpecifierHit {
  return { specifier, file, line }
}

function module_(file: string, specifiers: readonly SpecifierHit[]): ResumePathModule {
  return { file, specifiers }
}

/** The real shape: the entry imports two store modules, which import a third. */
function cleanModules(): ResumePathModule[] {
  return [
    module_(ENTRY, [
      hit('node:path', ENTRY, 1),
      hit('@vostride/agent-qa-agent', ENTRY, 2),
      hit('../store/sqlite-job-store.js', ENTRY, 3),
      hit('../store/job-checkpoint-store.js', ENTRY, 4),
    ]),
    module_(STORE, [
      hit('node:sqlite', STORE, 1),
      hit('@vostride/agent-qa-schema', STORE, 2),
      hit('./store-errors.js', STORE, 3),
    ]),
    module_('packages/agent-local/src/store/job-checkpoint-store.ts', [hit('node:fs', 'x', 1)]),
    module_('packages/agent-local/src/store/store-errors.ts', [
      hit('@vostride/agent-qa-agent', 'packages/agent-local/src/store/store-errors.ts', 1),
    ]),
    // Present in the package but NOT reachable from the entry, so the rule must leave it alone.
    module_('packages/agent-local/src/composition/run-composition.ts', [
      hit(MODEL_PACKAGE, 'packages/agent-local/src/composition/run-composition.ts', 9),
    ]),
  ]
}

describe('resume-path-model-free scope', () => {
  it('pins entries that exist on disk, inside the package it walks', () => {
    expect(RESUME_PATH_ENTRY_FILES.length).toBeGreaterThan(0)
    for (const entry of RESUME_PATH_ENTRY_FILES) {
      expect(existsSync(join(repoRoot, entry))).toBe(true)
      expect(entry.startsWith(`${RESUME_PATH_PACKAGE_DIR}/`)).toBe(true)
    }
  })

  it('carries a non-empty rationale for every forbidden package', () => {
    const entries = Object.entries(RESUME_PATH_FORBIDDEN_PACKAGES)
    expect(entries.length).toBeGreaterThan(0)
    for (const [, rationale] of entries) expect(rationale.trim()).not.toEqual('')
  })

  it('classifies the forbidden set by whole package, prefix included, and nothing else', () => {
    expect(resumePathForbiddenRationale(MODEL_PACKAGE)).toBeDefined()
    expect(resumePathForbiddenRationale(`${MODEL_PACKAGE}/registry`)).toBeDefined()
    expect(resumePathForbiddenRationale('ai')).toBeDefined()
    expect(resumePathForbiddenRationale(`${RESUME_PATH_FORBIDDEN_PACKAGE_PREFIX}anthropic`)).toBe(
      resumePathForbiddenRationale(`${RESUME_PATH_FORBIDDEN_PACKAGE_PREFIX}openai`),
    )
    // A longer package name must not answer for a shorter one, and vice versa.
    expect(resumePathForbiddenRationale(`${MODEL_PACKAGE}-local`)).toBeUndefined()
    expect(resumePathForbiddenRationale('@vostride/agent-qa-agent')).toBeUndefined()
    expect(resumePathForbiddenRationale('@vostride/agent-qa-schema')).toBeUndefined()
    expect(resumePathForbiddenRationale('node:path')).toBeUndefined()
    expect(resumePathForbiddenRationale('./store-errors.js')).toBeUndefined()
    // `ai` is a two-letter name; a specifier that merely contains it is not it.
    expect(resumePathForbiddenRationale('airtable')).toBeUndefined()
    expect(resumePathForbiddenRationale('@vostride/agent-qa-ai-helper')).toBeUndefined()
  })

  it('resolves a relative specifier the way the package writes them', () => {
    expect(resumePathRelativeCandidates(ENTRY, '../store/sqlite-job-store.js')).toContain(STORE)
    expect(resumePathRelativeCandidates(ENTRY, './recovery-helper.js')).toContain(HELPER)
    expect(resumePathRelativeCandidates(ENTRY, './nested/index.js')).toContain(
      'packages/agent-local/src/composition/nested/index.ts',
    )
  })
})

describe('resume-path-model-free — the NEGATIVE control (it must accept the real shape)', () => {
  it('accepts the entry and its whole closure when nothing forbidden is named', () => {
    expect(findResumePathModelFreeOffenders(cleanModules())).toEqual([])
  })

  it('walks past the entry into the modules it imports', () => {
    const closure = resumePathClosureOf(cleanModules())
    expect(closure.files).toEqual([
      ENTRY,
      'packages/agent-local/src/store/job-checkpoint-store.ts',
      'packages/agent-local/src/store/sqlite-job-store.ts',
      'packages/agent-local/src/store/store-errors.ts',
    ])
    expect(closure.missingEntries).toEqual([])
    expect(closure.unresolved).toEqual([])
  })

  it('leaves a file the entry cannot reach alone, however it imports', () => {
    // The sibling run composition legitimately names the model package under the carve-out. This
    // rule is about the resume path, not about the package, and conflating the two would make it
    // unsatisfiable the moment a composition root does its job.
    const closure = resumePathClosureOf(cleanModules())
    expect(closure.files).not.toContain('packages/agent-local/src/composition/run-composition.ts')
  })
})

describe('resume-path-model-free — the POSITIVE control (it must be able to fail)', () => {
  it('rejects a model import in the entry itself, naming file, line and the reason', () => {
    const modules = cleanModules()
    modules[0] = module_(ENTRY, [...modules[0]!.specifiers, hit(MODEL_PACKAGE, ENTRY, 27)])

    const offenders = findResumePathModelFreeOffenders(modules)
    expect(offenders).toHaveLength(1)
    expect(offenders[0]).toContain(`${ENTRY}:27`)
    expect(offenders[0]).toContain(MODEL_PACKAGE)
    expect(offenders[0]).toContain(RESUME_PATH_FORBIDDEN_PACKAGES[MODEL_PACKAGE]!)
    // The message says why, not only what, for a reader deciding whether the import is fine.
    expect(offenders[0]).toContain('resume')
    expect(offenders[0]).toContain('STRUCTURALLY incapable of re-invoking the model')
  })

  // THE REASON THE CLOSURE IS WALKED. A one-line helper beside the entry is what a well-meaning
  // refactor produces, and a single-file rule reports nothing about it.
  it('rejects a model import reached THROUGH a helper the entry imports', () => {
    const modules = cleanModules()
    modules[0] = module_(ENTRY, [...modules[0]!.specifiers, hit('./recovery-helper.js', ENTRY, 5)])
    modules.push(module_(HELPER, [hit(MODEL_PACKAGE, HELPER, 3)]))

    const offenders = findResumePathModelFreeOffenders(modules)
    expect(offenders).toHaveLength(1)
    expect(offenders[0]).toContain(`${HELPER}:3`)
    expect(offenders[0]).toContain(`reached from ${ENTRY}`)
  })

  it('rejects the provider substrate and every provider SDK, not only the first-party registry', () => {
    for (const specifier of ['ai', `${RESUME_PATH_FORBIDDEN_PACKAGE_PREFIX}openai`]) {
      const modules = cleanModules()
      modules[1] = module_(STORE, [...modules[1]!.specifiers, hit(specifier, STORE, 40)])
      expect(findResumePathModelFreeOffenders(modules)).toHaveLength(1)
    }
  })

  it('counts a type-only import, because the extractor is type-blind by design', () => {
    const modules = cleanModules()
    // `import type { X } from '<model>'` produces exactly this hit; the rule sees specifiers, and a
    // package named as a type is still a declared edge of the file.
    modules[0] = module_(ENTRY, [...modules[0]!.specifiers, hit(MODEL_PACKAGE, ENTRY, 12)])
    expect(findResumePathModelFreeOffenders(modules)).toHaveLength(1)
  })
})

describe('resume-path-model-free — the ANTI-VACUITY controls (it must not pass on nothing)', () => {
  it('reports a pinned entry the scanned set does not contain', () => {
    const modules = cleanModules().filter((module) => module.file !== ENTRY)
    const offenders = findResumePathModelFreeOffenders(modules)
    expect(offenders).toHaveLength(1)
    expect(offenders[0]).toContain('is not in the scanned set')
    expect(offenders[0]).toContain(ENTRY)
  })

  it('reports an entry whose closure is the entry alone', () => {
    const offenders = findResumePathModelFreeOffenders([module_(ENTRY, [hit('node:path', ENTRY)])])
    expect(offenders).toHaveLength(1)
    expect(offenders[0]).toContain('its import closure is the entry alone')
  })

  it('reports a relative import the walk cannot follow rather than skipping it', () => {
    const modules = cleanModules()
    modules[0] = module_(ENTRY, [...modules[0]!.specifiers, hit('./not-scanned.js', ENTRY, 7)])
    const offenders = findResumePathModelFreeOffenders(modules)
    expect(offenders).toHaveLength(1)
    expect(offenders[0]).toContain(`${ENTRY}:7`)
    expect(offenders[0]).toContain('could not be followed')
  })

  it('scoped to an entry that does not exist, it fails LOUDLY rather than passing', () => {
    const offenders = findResumePathModelFreeOffenders(cleanModules(), [
      'packages/agent-local/src/composition/compose-job-recovery-renamed.ts',
    ])
    expect(offenders).toHaveLength(1)
    expect(offenders[0]).toContain('is not in the scanned set')
  })
})

// A package with an `exports` map can import itself by name, which resolves to a sibling file.
describe('resume-path-model-free — the SELF-PACKAGE edge class', () => {
  const SELF_HELPER = `${RESUME_PATH_SELF_PACKAGE_NAME}/composition/recovery-helper.js`
  const BARREL = 'packages/agent-local/src/index.ts'
  const RUN_COMPOSITION = 'packages/agent-local/src/composition/run-composition.ts'

  it('pins the self-package name to the manifest of the package it walks', () => {
    // Read from disk, not restated: a second literal would be a second thing to keep in step, and
    // the failure mode of it drifting is the rule going quiet rather than going red.
    const manifest = JSON.parse(
      readFileSync(join(repoRoot, RESUME_PATH_PACKAGE_DIR, 'package.json'), 'utf8'),
    ) as { name: string }
    expect(RESUME_PATH_SELF_PACKAGE_NAME).toBe(manifest.name)
  })

  // A helper reached only through a self-package specifier, naming the model registry.
  it('rejects a model import in a helper reached only by a self-package specifier', () => {
    const modules = cleanModules()
    modules[0] = module_(ENTRY, [...modules[0]!.specifiers, hit(SELF_HELPER, ENTRY, 6)])
    modules.push(module_(HELPER, [hit(MODEL_PACKAGE, HELPER, 3)]))

    const offenders = findResumePathModelFreeOffenders(modules)
    expect(offenders).toHaveLength(1)
    expect(offenders[0]).toContain(`${HELPER}:3`)
    expect(offenders[0]).toContain(MODEL_PACKAGE)
    expect(offenders[0]).toContain(`reached from ${ENTRY}`)
    expect(resumePathClosureOf(modules).files).toContain(HELPER)
  })

  // The barrel re-exports the run composition, which names the model package under the carve-out.
  it('follows a BARE self-package specifier into the barrel and onward', () => {
    const modules = cleanModules()
    modules[0] = module_(ENTRY, [
      ...modules[0]!.specifiers,
      hit(RESUME_PATH_SELF_PACKAGE_NAME, ENTRY, 8),
    ])
    modules.push(module_(BARREL, [hit('./composition/run-composition.js', BARREL, 1)]))

    const offenders = findResumePathModelFreeOffenders(modules)
    expect(offenders).toHaveLength(1)
    expect(offenders[0]).toContain(`${RUN_COMPOSITION}:9`)
    expect(offenders[0]).toContain(MODEL_PACKAGE)
    expect(offenders[0]).toContain(`reached from ${ENTRY}`)
  })

  // FAIL-CLOSED, the symmetric case to the unfollowable relative import above. An edge the walk
  // cannot resolve is a part of the resume path the rule did not read, and reporting it is the
  // only answer that does not convert "unproven" into "proven".
  it('reports a self-package edge it cannot resolve rather than skipping it', () => {
    const modules = cleanModules()
    modules[0] = module_(ENTRY, [
      ...modules[0]!.specifiers,
      hit(`${RESUME_PATH_SELF_PACKAGE_NAME}/composition/not-scanned.js`, ENTRY, 11),
    ])

    const offenders = findResumePathModelFreeOffenders(modules)
    expect(offenders).toHaveLength(1)
    expect(offenders[0]).toContain(`${ENTRY}:11`)
    expect(offenders[0]).toContain('could not be followed')
    // The message says why this edge class is examined at all, per the pin-doubles-as-
    // documentation convention: a reader who trips it will otherwise conclude the rule has
    // confused a package boundary for a sibling import and "fix" it by skipping the edge again.
    expect(offenders[0]).toContain('exports map')
    expect(offenders[0]).toContain(RESUME_PATH_SELF_PACKAGE_NAME)
  })

  // The BOUND. Another package's specifier is still layer 1's business, not this rule's, and a
  // walk that started following those would report the whole workspace and mean nothing.
  it('still leaves a specifier naming a DIFFERENT package to layer 1', () => {
    const modules = cleanModules()
    modules[0] = module_(ENTRY, [
      ...modules[0]!.specifiers,
      hit('@vostride/agent-qa-knowledge-local/composition/x.js', ENTRY, 13),
    ])

    expect(findResumePathModelFreeOffenders(modules)).toEqual([])
  })
})

describe('resume-path-model-free against the real package', () => {
  // The whole rule, against the repo, with the scanned set asserted non-empty in three separate
  // ways: the package has sources, the entry is among them, and the closure reaches past it.
  it('scans real files, reaches a real closure, and reports no offender', () => {
    const modules = resumePathModules(RESUME_PATH_PACKAGE_DIR, repoRoot)
    expect(modules.length).toBeGreaterThan(0)
    expect(modules.map((module) => module.file)).toContain(ENTRY)

    const closure = resumePathClosureOf(modules)
    expect(closure.missingEntries).toEqual([])
    expect(closure.unresolved).toEqual([])
    expect(closure.files).toContain(ENTRY)
    expect(closure.files).toContain('packages/agent-local/src/store/sqlite-job-store.ts')
    expect(closure.files).toContain('packages/agent-local/src/store/job-checkpoint-store.ts')
    expect(closure.files.length).toBeGreaterThan(1)

    expect(findResumePathModelFreeOffenders(modules)).toEqual([])
  })

  // The measurement behind "this rule is not the composition carve-out in another hat": the
  // package really does name the model package, just never anywhere the resume path can reach.
  it('the package DOES name a forbidden specifier — outside the resume closure', () => {
    const modules = resumePathModules(RESUME_PATH_PACKAGE_DIR, repoRoot)
    const closure = new Set(resumePathClosureOf(modules).files)
    const namedOutside = modules
      .filter((module) => !closure.has(module.file))
      .flatMap((module) =>
        module.specifiers
          .filter((specifier) => resumePathForbiddenRationale(specifier.specifier) !== undefined)
          .map((specifier) => `${module.file}:${specifier.line} ${specifier.specifier}`),
      )
    expect(namedOutside.length).toBeGreaterThan(0)
  })
})
