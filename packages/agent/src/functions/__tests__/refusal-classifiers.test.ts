// Typed refusals return rather than throw, so each refusal arm must fold to `refused`.

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import {
  FORGET_RECEIPT_SCHEMA_VERSION,
  AuthoringDraftWriteOutputSchema,
  ConfigChangeOutputSchema,
  KnowledgeChangeOutputSchema,
  NO_RUNS_FAN_OUT_BOUND,
  buildFanOutReport,
  computeFanOutBound,
  renderFanOutReport,
} from '@vostride/agent-qa-schema'
import type {
  AuthoringDraftWriteOutput,
  ConfigChangeOutput,
  KnowledgeChangeOutput,
} from '@vostride/agent-qa-schema'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { foldFunctionResult } from '../classify.js'
import { authoringDraftWriteSpec } from '../ops/authoring-draft-write.js'
import { configAuthSetSpec } from '../ops/config-auth-set.js'
import { configFieldSetSpec } from '../ops/config-field-set.js'
import { configHookAddSpec } from '../ops/config-hook-add.js'
import { configProjectScaffoldSpec } from '../ops/config-project-scaffold.js'
import { configTargetCreateSpec } from '../ops/config-target-create.js'
import { configTargetEditSpec } from '../ops/config-target-edit.js'
import { knowledgeAcceptSpec } from '../ops/knowledge-accept-propose.js'
import { knowledgeForgetSpec } from '../ops/knowledge-forget-propose.js'
import { knowledgeRejectSpec } from '../ops/knowledge-reject-propose.js'
import { createRegistryFromSpecs } from '../registry.js'
import type { FunctionRegistry } from '../registry.js'
import type { FunctionDeps, FunctionSpec } from '../spec.js'
import { classifyBodies, executableSource, scanFile, scanText } from './op-source-scan.js'

// ---- fixtures, produced through the contracts ---------------------------------------------------

// The config ops answer what they wrote; blocked and refused arms carry no record reference.

const directBlockedBySchema: ConfigChangeOutput = ConfigChangeOutputSchema.parse({
  outcome: 'blocked',
  summaryLine: 'set use.authState — blocked: the resulting configuration is invalid',
  blockedReason: 'schema-fail',
  paths: ['agent-qa.config.yaml'],
  validationIssues: ['agent-qa.config.yaml: use: Unrecognized key: "authState"'],
})

const directRefusedOutright: ConfigChangeOutput = ConfigChangeOutputSchema.parse({
  outcome: 'refused',
  reason: 'target-not-found',
  detail: 'no target named "staging" is configured',
  candidates: ['local', 'ci'],
})

const applied: ConfigChangeOutput = ConfigChangeOutputSchema.parse({
  outcome: 'applied',
  summaryLine: 'set use.buildTag to probe-build-tag-v1',
  files: ['agent-qa.config.yaml'],
  fields: ['use.buildTag'],
  crossBoundary: false,
  crossBoundaryReasons: [],
  shownDiff: '--- a/agent-qa.config.yaml\n+++ b/agent-qa.config.yaml\n',
})

const interrupted: ConfigChangeOutput = ConfigChangeOutputSchema.parse({
  outcome: 'interrupted',
  summaryLine: 'configure this project for https://booking.com as target booking-com',
  written: ['.gitignore'],
  failed: { path: 'agent-qa.config.yaml', reason: 'file-changed' },
  unwritten: ['hooks.yaml'],
  detail: 'wrote .gitignore, then stopped: agent-qa.config.yaml changed after this call read it',
})

const directNoChange: ConfigChangeOutput = ConfigChangeOutputSchema.parse({
  outcome: 'no-change',
  path: 'use.buildTag',
})

/** The three-run happy fan-out, built rather than typed — `renderFanOutReport`'s own input. */
const happyFanOut = buildFanOutReport({
  previewed: computeFanOutBound({ initialN: 3, probeK: 3, finalN: 3 }),
  runs: [{ runId: 'r_gate-0', purpose: 'gate', completedAt: 1 }],
})

const DUPLICATE_REF = 'tests/checkout.spec.ts::adds a product to the cart'

const authoringRefused: AuthoringDraftWriteOutput = AuthoringDraftWriteOutputSchema.parse({
  outcome: 'refused',
  refusal: {
    filePath: 'tests/checkout.spec.ts',
    testName: 'adds a product to the cart',
    matchedRef: DUPLICATE_REF,
    score: 0.91,
    threshold: 0.8,
    sharedTokens: 5,
    comparedTests: 42,
    continuations: ['extend-that-test', 'name-the-differing-assertion'],
  },
  fanOut: buildFanOutReport({
    previewed: computeFanOutBound({ initialN: 3, probeK: 3, finalN: 3 }),
    runs: [],
  }),
})

// A drafted invocation carries its written-test receipt, so the fixture names the file.
const authoringDrafted: AuthoringDraftWriteOutput = AuthoringDraftWriteOutputSchema.parse({
  outcome: 'drafted',
  draftRef: {
    filePath: 'tests/authored/two-factor-auth.spec.ts',
    testId: 'draft_0001',
    testName: 'signs in with a one-time code',
    contentDigest: 'sha256:2f0c',
  },
  fanOut: happyFanOut,
  written: {
    file: { kind: 'written', filePath: 'tests/authored/two-factor-auth.yaml', contentDigest: 'sha256:2f0c' },
    disposition: 'keep-eligible',
    gates: { executesDefinitive: true, stableVerdict: true, addsValue: true, falsifiableAssertion: true },
  },
})

// ---- the config-mutation family: six ops, one union ---------------------------------------------

// Spelled as the specs themselves, so an op that drops its classifier fails here, not quietly.
const CONFIG_CHANGE_OPS: readonly FunctionSpec<never, ConfigChangeOutput>[] = [
  configAuthSetSpec,
  configFieldSetSpec,
  configHookAddSpec,
  configProjectScaffoldSpec,
  configTargetCreateSpec,
  configTargetEditSpec,
] as unknown as readonly FunctionSpec<never, ConfigChangeOutput>[]

describe('the config-mutation family folds its own refusal arms', () => {
  it('declares a classifier on every one of the six ops sharing the union', () => {
    // Non-vacuity: a spec with no classifier would report `executed` over a refusal.
    expect(CONFIG_CHANGE_OPS.length).toBe(6)
    for (const spec of CONFIG_CHANGE_OPS) {
      expect(spec.classify, `${spec.id} declares no classifier`).toBeTypeOf('function')
    }
  })

  it('folds the validation block to refused, and says which road it came in by', () => {
    for (const spec of CONFIG_CHANGE_OPS) {
      expect(spec.classify?.(directBlockedBySchema as never), spec.id)
        .toEqual({ status: 'refused', outcome: 'schema-fail' })
    }
  })

  it('folds the outright refusal to refused with the refusal’s own reason', () => {
    for (const spec of CONFIG_CHANGE_OPS) {
      expect(spec.classify?.(directRefusedOutright as never), spec.id)
        .toEqual({ status: 'refused', outcome: 'target-not-found' })
    }
  })

  it('folds an applied change to executed, naming the files it wrote', () => {
    for (const spec of CONFIG_CHANGE_OPS) {
      expect(spec.classify?.(applied as never), spec.id)
        .toEqual({ status: 'executed', outcome: 'applied: agent-qa.config.yaml' })
    }
  })

  it('folds an interrupted publication to failed, never executed', () => {
    for (const spec of CONFIG_CHANGE_OPS) {
      expect(spec.classify?.(interrupted as never), spec.id)
        .toEqual({ status: 'failed', outcome: 'interrupted at agent-qa.config.yaml: file-changed' })
    }
  })

  it('folds no-change to executed — nothing failed and nothing was declined', () => {
    for (const spec of CONFIG_CHANGE_OPS) {
      const verdict = spec.classify?.(directNoChange as never)
      expect(verdict?.status, spec.id).toBe('executed')
      expect(verdict?.outcome, spec.id).toContain('use.buildTag')
    }
  })
})

// ---- the knowledge changes: applied, absent or refused ---------------------------

const KNOWLEDGE_CHANGE_OPS: readonly FunctionSpec<never, KnowledgeChangeOutput>[] = [
  knowledgeAcceptSpec,
  knowledgeRejectSpec,
  knowledgeForgetSpec,
] as unknown as readonly FunctionSpec<never, KnowledgeChangeOutput>[]

const OPERATION_ID = '2c4e6a8b-0d1f-4a3b-8c5d-7e9f1a2b3c4d'

describe('the three knowledge changes fold their own answer', () => {
  it('an applied change is executed, a typed absence is executed, and a writer refusal is refused', () => {
    for (const spec of KNOWLEDGE_CHANGE_OPS) {
      const verb = spec.id.split('.')[1] as 'accept' | 'reject' | 'forget'
      const applied = KnowledgeChangeOutputSchema.parse({
        outcome: 'applied', verb, operationId: OPERATION_ID, recordIds: ['rec-1', 'rec-2'],
        ...(verb === 'forget'
          ? {
            forgetReceipt: {
              schemaVersion: FORGET_RECEIPT_SCHEMA_VERSION, proposalId: 'prop_alpha-bravo', tombstonedRecords: [],
              projectionsScrubbed: ['fts'], resultingBundleStatus: 'forgotten', forgottenAt: 1,
            },
          }
          : {}),
      })
      const absent = KnowledgeChangeOutputSchema.parse({
        outcome: 'target-not-found', verb, operationId: OPERATION_ID,
        target: { grain: 'record', recordId: 'rec-missing' },
      })
      const refused = KnowledgeChangeOutputSchema.parse({
        outcome: 'refused', verb, operationId: OPERATION_ID, reason: 'policy-materialize-refused',
      })
      expect(spec.classify?.(applied as never), spec.id)
        .toEqual({ status: 'executed', outcome: `${verb} applied: 2 record(s) changed` })
      expect(spec.classify?.(absent as never), spec.id)
        .toEqual({ status: 'executed', outcome: 'target-not-found: nothing was changed' })
      expect(spec.classify?.(refused as never), spec.id)
        .toEqual({ status: 'refused', outcome: 'policy-materialize-refused: nothing was changed' })
      // The receipt carries no proposal: nothing on it names an id a person must decide on.
      expect(spec.classify?.(applied as never)?.outcome, spec.id).not.toMatch(/prop_|propos/)
    }
  })
})

// ---- authoring.draft.write folds its refusal arm -----------------------------------------------

describe('authoring.draft.write folds its dedup refusal', () => {
  it('reports refused, and names the test the intent duplicates', () => {
    // The refusal's reference makes it actionable: the fold refuses and links.
    const verdict = authoringDraftWriteSpec.classify?.(authoringRefused)
    expect(verdict?.status).toBe('refused')
    expect(verdict?.outcome).toContain(`duplicate-of:${DUPLICATE_REF}`)
    // The fan-out report is required on every arm, so "nobody counted" never reads "nothing ran".
    expect(verdict?.outcome).toContain(renderFanOutReport(authoringRefused.fanOut))
  })

  it('reports executed for an authored draft, naming the draft a person can open', () => {
    const verdict = authoringDraftWriteSpec.classify?.(authoringDrafted)
    expect(verdict?.status).toBe('executed')
    expect(verdict?.outcome).toContain('signs in with a one-time code')
    expect(verdict?.outcome).toContain(renderFanOutReport(happyFanOut))
  })
})

// A stated-value refusal is its own line, ahead of the duplicate one.

const noRunsFanOut = buildFanOutReport({ previewed: NO_RUNS_FAN_OUT_BOUND, runs: [] })

const authoringCompileRefused: AuthoringDraftWriteOutput = AuthoringDraftWriteOutputSchema.parse({
  outcome: 'refused',
  draftRef: {
    filePath: 'tests/authored/kitchen.spec.ts',
    testId: 'draft_0002',
    testName: 'filters the catalogue by category',
    contentDigest: 'sha256:9a1e',
  },
  statedValueRefusal: { stage: 'compile', missingValues: ['Kitchen Appliances', '$49.99'] },
  fanOut: noRunsFanOut,
})

const authoringKeepRefused: AuthoringDraftWriteOutput = AuthoringDraftWriteOutputSchema.parse({
  outcome: 'refused',
  draftRef: {
    filePath: 'tests/authored/kitchen.spec.ts',
    testId: 'draft_0003',
    testName: 'filters the catalogue by category',
    contentDigest: 'sha256:7b3c',
  },
  statedValueRefusal: { stage: 'keep', missingValues: ['Kitchen Appliances'] },
  fanOut: happyFanOut,
})

describe('the draft-write refusal fold names its stage', () => {
  it('a stated-value refusal folds to refused, naming its stage and values, never a duplicate', () => {
    const verdict = authoringDraftWriteSpec.classify?.(authoringCompileRefused)
    expect(verdict?.status).toBe('refused')
    expect(verdict?.outcome.startsWith('stated-values-missing:compile "Kitchen Appliances"')).toBe(
      true,
    )
    expect(verdict?.outcome).toContain('"Kitchen Appliances", "$49.99"')
    expect(verdict?.outcome).toContain(renderFanOutReport(noRunsFanOut))
    expect(verdict?.outcome).not.toContain('duplicate')
  })

  it('a keep refusal names the keep stage', () => {
    const verdict = authoringDraftWriteSpec.classify?.(authoringKeepRefused)
    expect(verdict?.status).toBe('refused')
    expect(verdict?.outcome.startsWith('stated-values-missing:keep "Kitchen Appliances"')).toBe(
      true,
    )
    expect(verdict?.outcome).toContain(renderFanOutReport(happyFanOut))
    expect(verdict?.outcome).not.toContain('duplicate')
  })
})

// A result nobody can read is `failed`, never `executed`.

describe('the fail-closed wrapper, driven', () => {
  /** A registry over the real specs, so the fold under test is the one the composition root runs. */
  const registry = createRegistryFromSpecs(
    [configFieldSetSpec as FunctionSpec],
    {
      // The four required reader ports, never reached: the fold runs on the RETURN path and this
      // registry is only ever asked to look a spec up by id.
      deps: {} as unknown as FunctionDeps,
    },
  )

  it('reports failed/unclassifiable-result for a result the declared fold cannot read', () => {
    // A HAND-MUTATED RESULT, which is the shape a wire, a cache or a doctored record can produce:
    // the discriminant is a word the union does not have, so the op's own exhaustive switch falls
    // off the end and answers nothing. `executed` is the one thing that must not come back.
    const folded = foldFunctionResult(registry, configFieldSetSpec.id, { outcome: 'who-knows' })

    expect(folded.verdict).toEqual({ status: 'failed', outcome: 'unclassifiable-result' })
  })

  it('reports failed/unclassifiable-result when the classifier THROWS', () => {
    // The second fail-closed branch: `null` has no `outcome` to switch on at all.
    const folded = foldFunctionResult(registry, configFieldSetSpec.id, null)

    expect(folded.verdict.status).toBe('failed')
    expect(folded.verdict.status).not.toBe('executed')
  })

  it('still reports the real verdict for a result it CAN read — the guard is not a blanket', () => {
    // The discrimination control. Without it the two cells above would pass against a wrapper that
    // answered `unclassifiable-result` for everything.
    expect(foldFunctionResult(registry, configFieldSetSpec.id, directBlockedBySchema).verdict)
      .toEqual({ status: 'refused', outcome: 'schema-fail' })
  })
})

// Synthetic specs reach the branches a shipped op's total classifier never can.
describe('the fail-closed branches a shipped op cannot reach', () => {
  const SYNTHETIC_ID = 'synthetic.fold-probe'

  /** A registry over one hand-built spec, so each cell chooses what the classifier answers. */
  function registryAnswering(classify: unknown): FunctionRegistry {
    return createRegistryFromSpecs(
      [{
        id: SYNTHETIC_ID,
        summary: 'A probe spec whose fold answers whatever the cell hands it.',
        requiredScopes: ['read'],
        resultKind: 'unary',
        input: z.object({}).strict(),
        output: z.object({}).strict(),
        risk: { name: `fn:${SYNTHETIC_ID}`, recognized: true, readOnly: true },
        // The cast is the subject. A spec whose `classify` is absent or answers a non-verdict is
        // exactly what `tsc` cannot see and what the census catches only at the registry — so the
        // probe reproduces the shape rather than describing it.
        ...(classify === undefined ? {} : { classify }),
        invoke: () => Promise.resolve({}),
      } as unknown as FunctionSpec],
      {
        deps: {} as unknown as FunctionDeps,
      },
    )
  }

  it('reports failed/unclassifiable-result for an op that declares NO fold at all', () => {
    // `classify` is required, so an absent one means a cast slipped past `tsc` and the census.
    const folded = foldFunctionResult(registryAnswering(undefined), SYNTHETIC_ID, { ok: true })

    expect(folded.verdict).toEqual({ status: 'failed', outcome: 'unclassifiable-result' })
  })

  it('reports failed/unclassifiable-result for a WELL-FORMED answer that is not a verdict', () => {
    // A status no surface can render would reach the receipt, the session log and the goldens.
    const folded = foldFunctionResult(
      registryAnswering(() => ({ status: 'sideways', outcome: 'the fold invented a fourth word' })),
      SYNTHETIC_ID,
      { ok: true },
    )

    expect(folded.verdict).toEqual({ status: 'failed', outcome: 'unclassifiable-result' })
  })

  it('reports failed/unclassifiable-result when the OUTCOME is not a string', () => {
    // The other half of the same check, and it is not a restatement: the status word is legal here,
    // so a guard that only screened `status` would let this through and a receipt would carry a
    // number where every surface renders a sentence.
    const folded = foldFunctionResult(
      registryAnswering(() => ({ status: 'executed', outcome: 42 })),
      SYNTHETIC_ID,
      { ok: true },
    )

    expect(folded.verdict).toEqual({ status: 'failed', outcome: 'unclassifiable-result' })
  })

  it('reports failed/unclassifiable-result for an op the registry does not hold', () => {
    // The `spec === undefined` arm — unreachable in a composed host, because the op dispatched a
    // moment ago through this same registry, and answered fail-closed anyway.
    const folded = foldFunctionResult(registryAnswering(undefined), 'synthetic.not-registered', {})

    expect(folded.verdict).toEqual({ status: 'failed', outcome: 'unclassifiable-result' })
  })

  it('control: a probe answering a REAL verdict is reported verbatim', () => {
    // The discrimination control for all four. Without it every cell above would pass against a
    // wrapper that answered `unclassifiable-result` unconditionally — which is the same wrapper
    // that would also destroy every real verdict in the product.
    const folded = foldFunctionResult(
      registryAnswering(() => ({ status: 'refused', outcome: 'the probe declined' })),
      SYNTHETIC_ID,
      { ok: true },
    )

    expect(folded.verdict).toEqual({ status: 'refused', outcome: 'the probe declined' })
  })
})

// A classifier reads its union's discriminant, never a value's content.
describe('no classifier pattern-matches a value', () => {
  const VALUE_SNIFFING = [
    '.includes(',
    '.startsWith(',
    '.endsWith(',
    '.indexOf(',
    '.match(',
    '.search(',
    '.toLowerCase(',
    '.toUpperCase(',
    'RegExp',
  ] as const

  const CLASSIFIER_SOURCES = [
    'src/functions/ops/config-propose-verdict.ts',
    'src/functions/ops/authoring-draft-write.ts',
  ] as const

  it.each(CLASSIFIER_SOURCES)('%s inspects no value content', (relative) => {
    const scan = scanFile(new URL(`../../../${relative}`, import.meta.url).pathname, VALUE_SNIFFING)

    // Non-vacuity: the file was read and had executable text to scan. A path typo would otherwise
    // make this cell pass forever over an empty string.
    expect(scan.statements.length).toBeGreaterThan(10)
    expect(scan.hits).toEqual([])
  })

  // The same claim, over every fold in the directory.

  /** The ops directory, read from disk — never a list of file names somebody maintains. */
  const OPS_DIR = new URL('../ops/', import.meta.url).pathname

  /** Files that DECLARE a spec, which is the population the claim is about. */
  function specFiles(): readonly string[] {
    return readdirSync(OPS_DIR)
      .filter((name) => name.endsWith('.ts'))
      .filter((name) => {
        const text = readFileSync(join(OPS_DIR, name), 'utf8')
        return text.includes(': FunctionSpec<') || text.includes(': FunctionStreamSpec<')
      })
      .sort()
  }

  it('every spec file either declares a fold or points at the shared one — no third answer', () => {
    // THE DISCOVERY PREDICATE IS THE WHOLE RISK, so it is derived and two-sided. The population is
    // "files declaring a spec", read off the directory; the claim is that each one accounts for its
    // fold in one of exactly two ways. A file that did neither would be a spec whose classifier
    // lives somewhere this scan never looks — which is the shape of a census that is green because
    // it cannot see the thing it is counting.
    //
    // THE SHARED-FOLD ARM IS NOT AN ESCAPE HATCH: `config-propose-verdict.ts` is itself in the
    // hand-named list above AND its own body is scanned by the cell below, because it declares
    // `classify` for the seven ops that point at it.
    const unaccounted = specFiles().filter((name) => {
      const text = readFileSync(join(OPS_DIR, name), 'utf8')
      // The knowledge changes' shared fold is a second shared module, scanned whole like config's.
      return classifyBodies(text).length === 0 && !text.includes('config-propose-verdict.js')
        && !text.includes('knowledge-change-verdict.js')
    })

    expect(
      unaccounted,
      'these files declare a capability whose result fold is neither written here nor delegated to '
        + 'the shared config-propose fold — the scan below cannot see it, so it is unchecked',
    ).toEqual([])

    // …and the population is not empty, which every line above would pass on.
    expect(specFiles().length, 'no spec files were discovered — this cell ranges nothing')
      .toBeGreaterThan(30)
  })

  it('no fold in the ops directory inspects value CONTENT — every body, brace-matched', () => {
    // Scans fold bodies, not files: a whole-file scan flags a helper's file-extension check.
    const offenders: string[] = []
    let bodiesScanned = 0

    // OVER EVERY FILE IN THE DIRECTORY, not just the spec-declaring ones, so a future shared fold
    // module written as a spec member is inside this scan on the day it lands rather than on the
    // day somebody remembers.
    for (const name of readdirSync(OPS_DIR).filter((entry) => entry.endsWith('.ts'))) {
      for (const body of classifyBodies(readFileSync(join(OPS_DIR, name), 'utf8'))) {
        bodiesScanned += 1
        for (const hit of scanText(body, VALUE_SNIFFING).hits) offenders.push(`${name} :: ${hit}`)
      }
    }

    expect(
      offenders,
      'a fold that sniffs its payload\'s content is chat-side value matching, '
        + 'moved one file over and wearing the declaration\'s clothes',
    ).toEqual([])

    // An exact count, so an extractor that drops a fold or finds none fails here.
    expect(bodiesScanned, 'no classify bodies were extracted — this scan ranges nothing').toBe(35)
  })

  it('control: the body extractor and the scan both FIRE on a fold that sniffs', () => {
    // A scanner nobody has seen fire is a comment, and an extractor nobody has seen return the
    // right thing is a scanner over an empty string. Both halves are driven with synthetic source:
    // one fold that reads a discriminant and one that reads content, in a file shaped like an op.
    const planted = [
      'export const probeSpec: FunctionSpec<never, never> = {',
      '  classify(output): ClauseVerdict {',
      "    if (output.message.toLowerCase().includes('denied')) return REFUSED",
      '    return EXECUTED',
      '  },',
      '}',
    ].join('\n')

    const bodies = classifyBodies(planted)
    expect(bodies.length, 'the extractor found no body in source that plainly has one').toBe(1)
    expect(
      scanText(bodies[0] ?? '', VALUE_SNIFFING).hits.length,
      'the scan did not flag a fold that lowercases its payload and searches it for a word',
    ).toBeGreaterThan(0)

    // And the inverse: a fold that reads its own discriminant is NOT flagged. A scan that fired on
    // everything would certify as little as one that fired on nothing.
    const clean = classifyBodies([
      'export const cleanSpec: FunctionSpec<never, never> = {',
      '  classify(output): ClauseVerdict {',
      "    return output.kind === 'found' ? FOUND : ABSENT",
      '  },',
      '}',
    ].join('\n'))
    expect(clean.length).toBe(1)
    expect(scanText(clean[0] ?? '', VALUE_SNIFFING).hits).toEqual([])
  })

  it('folds on a DISCRIMINANT — the switch, spelled', () => {
    // The inverse control for the scan above: a fold that read nothing at all would also have no
    // hits. This says what it DOES read.
    const source = executableSource(
      readFileSync(
        new URL('../../../src/functions/ops/config-propose-verdict.ts', import.meta.url).pathname,
        'utf8',
      ),
    )

    expect(source).toContain('switch (output.outcome)')
  })
})

// The knowledge change ops share one fold, so no door can report differently.
describe('the three knowledge changes fold through one function', () => {
  it('the shared fold inspects no value content and switches on the outcome', () => {
    const path = new URL('../../../src/functions/ops/knowledge-change-verdict.ts', import.meta.url).pathname
    const scan = scanFile(path, ['.includes(', '.startsWith(', '.endsWith(', '.indexOf(', '.match(',
      '.search(', '.toLowerCase(', '.toUpperCase(', 'RegExp'])
    expect(scan.statements.length).toBeGreaterThan(3)
    expect(scan.hits).toEqual([])
    expect(executableSource(readFileSync(path, 'utf8'))).toContain('switch (output.outcome)')
  })

  it('every knowledge change spec declares the shared fold itself', async () => {
    const shared = (await import('../ops/knowledge-change-verdict.js')).classifyKnowledgeChangeOutput
    expect(shared).toBeTypeOf('function')
    for (const spec of KNOWLEDGE_CHANGE_OPS) expect(spec.classify, spec.id).toBe(shared)
  })
})
