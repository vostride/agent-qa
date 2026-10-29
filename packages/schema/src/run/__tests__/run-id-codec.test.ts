// THE run-id codec, and the census that makes "one codec" a claim about the boundary.
//
// WHY A CENSUS AND NOT A CELL PER SITE. `packages/schema/src` is not one door onto a run's
// identity; before this plan it declared FOUR bare `z.string().transform(asRunId)` codecs, and
// hardening the one a report names is the one-sided hardening this phase has shipped repeatedly.
// The claim worth making is a COMPLETE-SET claim — every declaration in this package either IS the
// shared hardened codec or carries a recorded verdict — and a claim of that shape can only be
// discharged by enumerating.
//
// THREE PREDICATES, DELIBERATELY DIFFERENT IN SHAPE, because a census is only as complete as its
// discovery rule and a self-check only ever sees narrowings that reach the members it names:
//
//   P1  SYMBOL-shaped. Every declaration that turns a string into a branded `RunId` — i.e. every
//       use of `asRunId` in a codec position. Complete-set: exactly one file, `run/run-id.ts`.
//   P2  KEY-shaped. Every `runId:` / `runRef:` field declared with a zod value, keyed on the
//       PROPERTY rather than on the symbol — so a future codec spelled without `asRunId`
//       (`z.string().transform(v => v as RunId)`) is still seen. Partitioned per FILE against a
//       written verdict table.
//   P3  RUNTIME-shaped. The surfaces P1/P2 name are asserted to hold the SAME OBJECT, and to
//       REFUSE a path-shaped id when actually parsed. Text cannot fake this one, and it is the
//       only predicate that measures behaviour rather than source.
//
// P2 exists because P1 alone is a grep for a name. P1 exists because P2 alone is a grep for a key
// and would miss a codec assigned to a differently-named field. P3 exists because both are text.

import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { AnalysisGetInputSchema } from '../../functions/analysis-get'
import { RunSummarySchema, RunsStartInputSchema } from '../../functions/runs'
import { jobSchema } from '../../job/job'
import { RunsDigestInputSchema } from '../../notification/run-digest'
import { runIdSchema } from '../run-id'

/** `packages/schema/src/run/__tests__` → two levels up is the package's whole shipped source. */
const SCHEMA_SRC = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
}

/** Every shipped `.ts` file in this package, `__tests__` and generated declarations excluded. */
function shippedSourceFiles(root: string): string[] {
  const found: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === '__tests__' || entry.name === 'node_modules') continue
        walk(path)
        continue
      }
      if (!entry.name.endsWith('.ts') || entry.name.endsWith('.d.ts')) continue
      found.push(path)
    }
  }
  walk(root)
  return found
}

/** P1 — a declaration that BRANDS a string as a `RunId`. */
const BRANDING_DECLARATION_RE = /\.(?:transform|pipe)\s*\(\s*asRunId\s*\)|as\s+RunId\b/g

/** P2 — a run-identifying field declared with a zod value. */
const RUN_ID_FIELD_RE = /\brun(?:Id|Ref|Ids|Refs)\s*:\s*(runIdSchema|z\.[A-Za-z0-9_.()' ,-]*)/g

/**
 * Files that MUST be in the scanned set, named here rather than read off the scan.
 *
 * The 399/400 scar: a discovery predicate pinned to its own output is green at rest, and a walker
 * rooted at a wrong-but-EXISTING directory returns a plausible set and reports every file clean.
 * These are the files the claim is ABOUT — the four that declared a bare codec before this plan,
 * the file the shared one now lives in, and the sanitizer it derives its rule from.
 */
const REQUIRED_CENSUS_MEMBERS = [
  join('run', 'run-id.ts'),
  join('functions', 'runs.ts'),
  join('functions', 'analysis-get.ts'),
  join('job', 'job.ts'),
  join('notification', 'run-digest.ts'),
  join('ids', 'slug.ts'),
  join('knowledge', 'gate-receipt.ts'),
] as const

/**
 * THE VERDICT TABLE — every file declaring a run-identifying field, and what its fields are.
 *
 * `hardened` counts fields carrying the shared codec; `plainString` counts fields declared as a
 * bare `z.string()`. A `plainString` field is NOT a run-id codec: it produces `string`, its
 * interface says `string`, and nothing brands it. Each one's verdict is recorded because "there
 * are ten hardened sites" says nothing about the fourteen that are not, and the fourteen are where
 * a reader would otherwise have to take a count on trust.
 *
 * Keyed on FILE rather than on line so an edit above a declaration cannot rot the table, and
 * counted rather than listed so a SECOND field added to an already-listed file still reds.
 */
const RUN_ID_FIELD_VERDICTS: Readonly<
  Record<string, { hardened: number; plainString: number; verdict: string }>
> = {
  'functions/runs.ts': {
    hardened: 12,
    plainString: 7,
    verdict:
      '2026-09-14 (423-29 D-04) adds the TWELFTH: `RunsEvidenceInput.runId` scopes the recorded-row and blob reads through the same exact-path codec. '
      + 'hardened here — `RunsStartInput.runId` is the caller-supplied id the run executes under and '
      + 'becomes `runs/<slugBranch(runId)>/`. 2026-08-25 (403-01 D-03) adds the EIGHTH: '
      + '`RunsLiveUrlInput.runId` is caller-supplied over HTTP, is looked up in the live-session '
      + 'registry, and is INTERPOLATED INTO THE MINTED URL and into the signed claims — so an id '
      + 'that could be rewritten on the way through would be an id a viewer could be pointed at. '
      + '2026-08-27 (405-01 D-03) adds the NINTH: `RunsDetailInput.runId` arrives as an untrusted '
      + 'path segment of `GET /api/runs/:id/detail` and is the id the dashboard projection is read '
      + 'under — the read resolves it against rows it enumerates rather than a path join, and the '
      + 'codec is what makes an id the path layer would REWRITE a refusal instead (T-405-01). '
      + '2026-08-27 (405-05 D-12/D-13) adds the TENTH: `RunsArtifactInput.runId` arrives as an '
      + 'untrusted path segment of `GET /api/runs/:runId/artifacts/:sha` on both doors and is the '
      + 'run the evidence store is scoped to — the codec refuses the ids `slugBranch` would '
      + 'REWRITE, so a rewritten id can never address another run\'s blobs (T-405-14). Its `sha` '
      + 'is NOT a run-identifying field and carries its own 64-lowercase-hex regex instead. '
      + '2026-08-29 (407-01 D-05) adds the ELEVENTH: `RunsKnowledgeInput.runId` arrives as an '
      + 'untrusted path segment of `GET /api/runs/:id/knowledge` and is the run whose handoff is '
      + 'read — the runs port resolves it against the runs it enumerates rather than a path join, '
      + 'and the codec is what makes an id the path layer would REWRITE a refusal before any '
      + 'dispatch happens (T-407-01). '
      + 'The seven plain fields are ACKNOWLEDGEMENT/EVENT/PROJECTION/RESULT '
      + 'projections (`RunStartAcknowledgement`, the bus envelope, `PostProcessingStatus`, '
      + '405-01\'s `RunDetailProjection.runId`, 405-05\'s `RunsArtifactResult.runId` and both '
      + 'arms of 407-01\'s `RunKnowledgeProjection` — the `evidence-incomplete` arm echoes the id '
      + 'for a run whose handoff is GONE, so hardening it would refuse to name the very run a '
      + 'reader is asking about) whose interfaces declare `string`: each echoes an id a run '
      + 'already recorded, and none is an input.',
  },
  'functions/analysis-get.ts': {
    hardened: 1,
    plainString: 1,
    verdict:
      'hardened here — `AnalysisGetInput.runId` is caller-supplied and reaches a real path join '
      + '(`join(agentQaRoot, RUNS_SUBDIR, slugBranch(runId), ANALYSIS_FILE)`). Traversal at that '
      + 'join was, and still is, neutered by `slugBranch`; the codec makes the id refuse to be '
      + 'REWRITTEN there rather than adding a second guard. The plain field is the output row.',
  },
  'functions/runs-overview.ts': {
    hardened: 1,
    plainString: 4,
    verdict:
      'hardened here — 2026-09-28 (431 D-06) `RunsOverviewInput.runId` is caller-supplied and is '
      + 'the run whose handoff and projection rows are read; the runs port resolves it against the '
      + 'runs it enumerates. The four plain fields are OUTPUT echoes of a completed run the read '
      + 'already resolved: `RunOverviewProjection.runId` and the `runId` of the artifact, evidence '
      + 'and brief addresses it hands back. Each is re-validated by the branded input codec of '
      + 'the op that takes it, so none is an input here.',
  },
  'functions/authoring.ts': {
    hardened: 0,
    plainString: 1,
    verdict:
      'reaches no path join — 2026-09-02 (411-01 D-06) lifts `AuthoringStop.runId` to the stop '
      + "payload's top level so a NULL failure point still names the run it read. It echoes the "
      + 'LAST gate run on a receipt the loop itself just executed: an OUTPUT arm of '
      + '`authoring.draft.write`, named by no caller and resolved against nothing on disk.',
  },
  'job/job.ts': {
    hardened: 1,
    plainString: 0,
    verdict:
      'hardened here — `job.runRef` is read BACK through this schema from the durable job store, '
      + 'and the analyze-run chain resolves it against `runs/<slugBranch(runRef)>/handoff.json`. '
      + 'A row is a stored value, so the codec is what refuses a poisoned one on the way out.',
  },
  'notification/run-digest.ts': {
    hardened: 1,
    plainString: 1,
    verdict:
      'hardened here — `RunsDigestInput.runId` is caller-supplied and `runs.digest` reads that '
      + "run's own record. The plain field is a rendered digest ROW.",
  },
  'job/analyze-run-payload.ts': {
    hardened: 0,
    plainString: 1,
    verdict:
      "already slugged at the join, and NOT caller-supplied — the payload is minted by the run's "
      + 'own post-run tail from the id it just ran under. Widening the branded codec into it would '
      + 'change a published payload type for a field no caller can name.',
  },
  'authoring/draft-receipt.ts': {
    hardened: 0,
    plainString: 3,
    verdict:
      'reaches no path join — a gate-run reference rendered on a receipt, plus TWO `runRefs` '
      + 'arrays. THE ARRAYS ARE WHY P2 EXISTS: the symbol-shaped predicate and a `runId:`-only '
      + 'grep both see one field in this file, and there are three. Nothing here is an input.',
  },
  'authoring/proposal-arms.ts': {
    hardened: 0,
    plainString: 1,
    verdict:
      'reaches no path join, and is NOT caller-supplied — `RunEvidenceRef.runId` is a COORDINATE '
      + 'into a run\'s own durable records, built by the router from the run it just read. The '
      + 'second row this file counted here was the retired arm\'s failure point, which left with '
      + 'the Issue-slot cleanup (411); the surviving field is the same kind of output echo.',
  },
  'authoring/fan-out.ts': {
    hardened: 0,
    plainString: 1,
    verdict: 'reaches no path join — run attribution on a fan-out row.',
  },
  'knowledge/bundle-files.ts': {
    hardened: 0,
    plainString: 1,
    verdict:
      "already slugged at the join — an evidence row's provenance, written under the bundle's own "
      + 'content-addressed directory.',
  },
  'knowledge/gate-receipt.ts': {
    hardened: 0,
    plainString: 1,
    verdict:
      'reaches no path join — the mark receipt carries the historical run reference of a mark. '
      + 'It records attribution in bundle evidence and is returned as a string by the read '
      + 'operation; it neither brands a RunId nor addresses run files. The strict receipt '
      + 'contract requires a nonempty reference without rewriting historical ids.',
  },
  'functions/feedback.ts': {
    hardened: 14,
    plainString: 0,
    verdict:
      'The mark address, input, outcome and trace fields, the marks-history input and its four '
      + 'result arms, and the mark preview\'s prospective and already-marked arms reuse '
      + 'runIdSchema.in, the canonical path validator before its type-only branding '
      + 'transform. Mark DTOs preserve the same bytes and rejection predicate while '
      + 'supporting output JSON-schema projection; no second path rule is declared. '
      + 'The preview\'s four refusal arms are runs.mark\'s own objects, not new fields.',
  },
  'knowledge/change.ts': {
    hardened: 0,
    plainString: 1,
    verdict:
      '2026-09-08 (419-01): MarkProposalStamp.runId is persisted attribution on a '
      + 'knowledge proposal, not an unchecked path segment or a run-execution input. '
      + 'The mark input and plan address have already crossed the canonical codec; '
      + 'the stamp preserves the originating run reference as evidence. '
      + '2026-10-01 (432-17): the stamp moved to knowledge/change.ts as MarkChangeStamp with '
      + 'the direct change contracts, and proposal/envelope.ts (optional run attribution on a '
      + 'proposal envelope) is deleted with the inbox.',
  },
  'knowledge/review-verbs.ts': {
    hardened: 0,
    // 2 -> 1. The change ops' input carries no run attribution; what remains
    // is `BriefWhyInput.runId`, the address of the run a why-question is about.
    plainString: 1,
    verdict: "reaches no path join — the run a brief-why question addresses, read through the runs port.",
  },
}

describe('the SYMBOL-shaped predicate, and its own self-check first', () => {
  const seen = (source: string): boolean => {
    BRANDING_DECLARATION_RE.lastIndex = 0
    return BRANDING_DECLARATION_RE.test(stripComments(source))
  }

  it('sees every spelling that brands a string as a RunId, and no prose', () => {
    expect(seen('const s = z.string().transform(asRunId)')).toBe(true)
    expect(seen('  runId: z.string().transform(asRunId),')).toBe(true)
    expect(seen('const s = z.string().pipe(asRunId)')).toBe(true)
    expect(seen('const s = z.string().transform((v) => v as RunId)')).toBe(true)
    // Prose must not be seen, or the census reports its own explanations forever.
    expect(seen('// the codec used to be z.string().transform(asRunId)')).toBe(false)
    expect(seen('/* runId: z.string().transform(asRunId) */\nconst x = 1')).toBe(false)
    // …and the stripper must not eat code (the protocol-relative-URL trap).
    expect(stripComments("const u = 'https://example.com' // trailing")).toContain('https://example.com')
  })

  it('ranges the files the claim is about — the discovery self-check', () => {
    const scanned = shippedSourceFiles(SCHEMA_SRC).map((path) => relative(SCHEMA_SRC, path))
    expect(scanned.length).toBeGreaterThan(80)
    for (const member of REQUIRED_CENSUS_MEMBERS) {
      expect(scanned, `the census is not ranging ${member}`).toContain(member)
    }
    for (const path of scanned) expect(path.startsWith(`..${sep}`)).toBe(false)
  })

  it('every branding declaration in the package lives in run/run-id.ts', () => {
    const declaring = shippedSourceFiles(SCHEMA_SRC).flatMap((path) => {
      const source = stripComments(readFileSync(path, 'utf8'))
      BRANDING_DECLARATION_RE.lastIndex = 0
      return (source.match(BRANDING_DECLARATION_RE) ?? []).map(() =>
        relative(SCHEMA_SRC, path).replaceAll(sep, '/'),
      )
    })
    expect(new Set(declaring)).toEqual(new Set(['run/run-id.ts']))
    // Non-vacuity in the other direction: the branding really is still there to be found.
    expect(declaring.length).toBeGreaterThan(0)
  })
})

describe('the KEY-shaped predicate: every run-identifying field carries a verdict', () => {
  it('sees a field declared without `asRunId` at all — the case the symbol-shaped predicate cannot', () => {
    const probe = (source: string): boolean => {
      RUN_ID_FIELD_RE.lastIndex = 0
      return RUN_ID_FIELD_RE.test(source)
    }
    expect(probe('  runId: z.string().transform((v) => v as Something),')).toBe(true)
    expect(probe('  runId: runIdSchema,')).toBe(true)
    expect(probe('  runRef: runIdSchema.optional(),')).toBe(true)
    // A TypeScript interface field is not a codec declaration and must not be counted.
    expect(probe('  runId: RunId')).toBe(false)
  })

  it('the per-file partition matches the recorded verdict table, exactly', () => {
    const observed: Record<string, { hardened: number; plainString: number }> = {}
    for (const path of shippedSourceFiles(SCHEMA_SRC)) {
      const source = stripComments(readFileSync(path, 'utf8'))
      for (const match of source.matchAll(RUN_ID_FIELD_RE)) {
        const key = relative(SCHEMA_SRC, path).replaceAll(sep, '/')
        observed[key] ??= { hardened: 0, plainString: 0 }
        if (match[1] === 'runIdSchema') observed[key]!.hardened += 1
        else observed[key]!.plainString += 1
      }
    }

    const expected = Object.fromEntries(
      Object.entries(RUN_ID_FIELD_VERDICTS).map(([file, row]) => [
        file,
        { hardened: row.hardened, plainString: row.plainString },
      ]),
    )
    expect(observed).toEqual(expected)
    for (const row of Object.values(RUN_ID_FIELD_VERDICTS)) {
      expect(row.verdict.trim()).not.toEqual('')
    }
  })
})

describe('the RUNTIME-shaped predicate: the same object, and it refuses', () => {
  it('every hardened surface holds the SAME codec instance', () => {
    expect(RunsStartInputSchema.shape.runId.unwrap()).toBe(runIdSchema)
    expect(RunSummarySchema.shape.runId).toBe(runIdSchema)
    expect(AnalysisGetInputSchema.shape.runId).toBe(runIdSchema)
    expect(jobSchema.shape.runRef.unwrap()).toBe(runIdSchema)
    expect(RunsDigestInputSchema.shape.runId).toBe(runIdSchema)
  })

  it.each([
    ['a parent-directory traversal', '../../escape'],
    ['a forward separator', 'runs/other'],
    ['a backslash separator', 'runs\\other'],
    ['a NUL byte', 'r_ok\u0000'],
    ['a bare control character', 'r_ok\u001b'],
    ['a DEL character', 'r_ok\u007f'],
    ['the empty string', ''],
    ['a leading dot, which would be a hidden directory', '.hidden'],
    ['a space, which the path layer would rewrite', 'r_a b'],
  ])('REFUSES %s at every hardened door', (_name, value) => {
    expect(RunsStartInputSchema.safeParse({ runId: value }).success).toBe(false)
    expect(AnalysisGetInputSchema.safeParse({ runId: value }).success).toBe(false)
    expect(RunsDigestInputSchema.safeParse({ runId: value }).success).toBe(false)
  })

  it('ACCEPTS a canonical id and the legacy shapes already on disk — the control', () => {
    for (const value of [
      'r_wander-wear-sweet-poke-life-christ-offset-owl-child-until',
      'run-abc',
      'run_validate_analysis',
      'r_a.b',
    ]) {
      expect(RunsStartInputSchema.safeParse({ runId: value }).success, value).toBe(true)
      expect(AnalysisGetInputSchema.safeParse({ runId: value }).success, value).toBe(true)
    }
  })

  it('the refusal is a DECISION about the id, and names what it wants', () => {
    const refusal = AnalysisGetInputSchema.safeParse({ runId: '../../escape' })
    expect(refusal.success).toBe(false)
    expect(refusal.error!.issues[0]!.message).toContain("run's own directory")
  })
})
