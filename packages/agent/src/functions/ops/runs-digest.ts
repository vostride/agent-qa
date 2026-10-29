// `runs.digest` — ONE run, one digest, composed live.
//
// PROP-04's complaint is a product complaint: an approval UX that fires forty times per nightly
// run is worse than one that fires once. The answer is not a throttle, a debounce or a batching
// window — every one of those is a timing knob with a wrong setting. The answer is a
// PROJECTION KEYED BY `runId`. A projection keyed by a run cannot fire per event, so "exactly
// one digest per run" is a property of the shape and not a rule anybody enforces.
//
// NOTHING IS PERSISTED HERE. The digest composes from four already-shipped read paths — the
// analysis op, the chain-state op, the run's own mark ledger (432-09, which
// replaced the proposals inbox of 391 plan 03) and the quarantine ledger — every time
// somebody asks. So there is nothing to drift,
// nothing to migrate, no second copy of a run's truth to reconcile, and the frozen counts-only
// notification row is left exactly as it was.
//
// THE TWO SIBLING OPS ARE INVOKED, NOT REIMPLEMENTED. `analysisGetSpec.invoke` and
// `runsPostProcessingSpec.invoke` are called with THIS call's deps, so the verdict sentences in
// a digest are the same bytes `analysis.get` serves and the chips are the same five words
// `runs.postprocessing` serves. That is 389 D-05/D-10 and 388 D-14 honoured by CALLING them
// rather than by a comment promising not to diverge. The specs are module-internal — nothing
// outside this package can reach them — so this is composition inside the layer, not a
// dispatch path around `invokeFunction`: every EXTERNAL caller still arrives through
// the pipeline, and this op declares its own read-only descriptor. 2026-10-01: the
// read scope it also declared is gone; no op declares one now.
//
// REFS AND COUNTS ONLY. No delta content, no forget-receipt tombstones, no
// rationale prose, no masked bytes. A mark change is its mark id, its fix and the record ids or
// workspace path it changed. Nothing awaits a decision: no proposal store is read.

import {
  POST_PROCESSING_SKIP_REASON_WORDS,
  RunDigestSchema,
  RunsDigestInputSchema,
} from '@vostride/agent-qa-schema'
import type {
  PostProcessingStatus,
  QuarantineEntryState,
  RunDigest,
  RunDigestMarkChange,
  RunsDigestInput,
} from '@vostride/agent-qa-schema'

import { renderAnalysisClusterBlock } from '../../analysis/render-cluster-block.js'
import type { ClauseVerdict, FunctionDeps, FunctionSpec } from '../spec.js'
import { analysisGetSpec } from './analysis-get.js'
import { refuseMissingHandoff } from './runs-get.js'
import {
  projectPostProcessingChips,
  projectPostProcessingSkipped,
  runsPostProcessingSpec,
} from './runs-post-processing.js'

/**
 * Lowercase dot taxonomy: the `runs` domain, one noun.
 *
 * `runs.` rather than a new `digest.` domain, because what this returns is a fact ABOUT A RUN —
 * the same reason `runs.postprocessing` is not `postprocessing.get`. The exported constant is
 * what the CLI's `digest` verb, the tail's fetch pointer, 392's chat and M5 all name; the
 * literal appears here once, and the parity suite picks the id up from the registry.
 */
export const RUNS_DIGEST_FUNCTION_ID = 'runs.digest'

/** The line separator 388 pinned for the exit summary, reused so one story reads as one. */
const DIGEST_SEPARATOR = ' · '

/**
 * The fixes this run's marks applied, read from the run's own ledger through the read-only feedback
 * port. ABSENT where this host binds no feedback reads or the ledger cannot be read, so an
 * empty list is only ever a measurement.
 */
async function markChangesFor(deps: FunctionDeps, runId: RunsDigestInput['runId']): Promise<RunDigestMarkChange[] | undefined> {
  const read = await deps.feedbackReads?.history(runId)
  if (read === undefined || read.kind !== 'history') return undefined
  return read.entries.flatMap(({ receipt }) => receipt.disposition.kind === 'applied'
    ? [{ markId: receipt.markId, ordinal: receipt.ordinal, fix: receipt.disposition.fix, change: receipt.disposition.change }]
    : [])
}

/** One line per applied change: refs and counts, never record content. */
function markChangeLine(row: RunDigestMarkChange): string {
  const { change } = row
  const what = change.kind === 'test-file'
    ? `wrote ${change.filePath}`
    : `${change.recordIds.length} record${change.recordIds.length === 1 ? '' : 's'} changed`
  return `  ${row.markId}  ${row.fix}: ${what}`
}

/** The durable identity legs, joined — never `testId`, which is per-run. */
function quarantineRef(entry: QuarantineEntryState): string {
  return `${entry.product}/${entry.filePath}::${entry.testName}`
}

/**
 * The rendered bytes every surface prints, composed ONCE here.
 *
 * A surface that laid these out for itself would be composing a second story about one run, and
 * the failure mode is not cosmetic: the tail's block, the CLI verb's output and 392's chat
 * would each be free to omit the section that happened to be empty on the day they were
 * written. Sections that have nothing to say still print their zero, because "no changes
 * applied" is a fact a person needs and an absent line is indistinguishable from a bug.
 */
function renderDigestLines(digest: Omit<RunDigest, 'lines'>): string[] {
  const lines: string[] = [`digest — ${digest.runId}`]

  // The analysis section, through the ONE block renderer. Empty for a run with no failures,
  // which prints nothing at all rather than a header saying there is nothing.
  const clusterBlock = renderAnalysisClusterBlock({
    runId: digest.runId,
    verdicts: [],
    sentences: [],
    clusters: digest.verdictClusters,
  })
  if (clusterBlock !== '') lines.push(clusterBlock)

  // a skipped run has no chain to report on, so the two chip words would read
  // `pending` forever. The fact replaces them in the CLI exit line's words; the outcome clause
  // keeps its own behaviour.
  const skipped = digest.chain.skipped
  const skippedWord = skipped === undefined
    ? undefined
    : POST_PROCESSING_SKIP_REASON_WORDS[skipped.reason]
  lines.push(`chain — ${[
    ...(skippedWord === undefined
      ? [`analysis: ${digest.chain.analysis}`, `curation: ${digest.chain.curation}`]
      : [`analysis: skipped (${skippedWord})`, `curation: skipped (${skippedWord})`]),
    ...(digest.chain.outcome === undefined ? [] : [`chain ${digest.chain.outcome}`]),
  ].join(DIGEST_SEPARATOR)}`)

  // An absent list and an empty one are not the same statement: "no changes applied" is a
  // measurement over a ledger that was read, and an unread ledger is said as such.
  const changes = digest.markChanges
  if (changes === undefined) {
    lines.push('marks — ledger not read here')
  } else if (changes.length === 0) {
    lines.push('marks — no changes applied')
  } else {
    lines.push(`marks — ${changes.length} change${changes.length === 1 ? '' : 's'} applied:`)
    for (const row of changes) lines.push(markChangeLine(row))
  }

  lines.push(`candidates — ${digest.candidates.curated} curated${DIGEST_SEPARATOR}${
    digest.candidates.deprecated} deprecated`)

  lines.push(`quarantine — ${digest.quarantine.quarantined} quarantined${DIGEST_SEPARATOR}${
    digest.quarantine.expired} expired${
    digest.quarantine.refs.length === 0 ? '' : `: ${digest.quarantine.refs.join(', ')}`}`)

  return lines
}

export const runsDigestSpec: FunctionSpec<RunsDigestInput, RunDigest> = {
  id: RUNS_DIGEST_FUNCTION_ID,
  summary: "Compose one run's digest: verdicts, chain, the changes its marks applied, counts.",
  resultKind: 'unary',
  input: RunsDigestInputSchema,
  output: RunDigestSchema,
  risk: { name: `fn:${RUNS_DIGEST_FUNCTION_ID}`, recognized: true, readOnly: true },
  /**
   * REFS AND COUNTS, which is this op's own law rather than a house style.
   *
   * The digest's `lines` are its rendered territory and they travel on `results[]`, which D-04
   * prints in full. A receipt line reaching into them would put a run's story inside the map — the
   * exact thing D-18 pinned this op's whole shape around.
   */
  classify(output): ClauseVerdict {
    return {
      status: 'executed',
      outcome: `digest for ${output.runId} — `
        + (output.markChanges === undefined ? 'mark ledger not read'
          : `${output.markChanges.length} mark change(s) applied`),
    }
  },
  async invoke(input, deps: FunctionDeps) {
    const runId = String(input.runId)
    // A digest NAMES a run, so a run this host has never recorded is a refusal rather than a
    // page of zeros — and the check is here, against the REQUIRED runs port, so the refusal is
    // the same on a host with no analysis reader as on one that has it. Delegating it to the
    // analysis composition below would have made a correctness property depend on an optional
    // dep's presence.
    const document = await deps.runs.get(input.runId)
    if (document === undefined) return refuseMissingHandoff(input.runId, deps)

    // Each section is composed only where its dep is present. Explicit presence checks rather
    // than a try/catch around the invocations: swallowing would also swallow a real failure
    // inside a bound path, and "the analysis reader threw" is not the same fact as "this host
    // has no analysis reader".
    const analysis = deps.analysis === undefined
      ? undefined
      : await analysisGetSpec.invoke({ runId: input.runId }, deps)
    const status: PostProcessingStatus | undefined = deps.postProcessing === undefined
      ? undefined
      : await runsPostProcessingSpec.invoke({ runId: input.runId }, deps)
    const quarantine: readonly QuarantineEntryState[] = deps.quarantine === undefined
      ? []
      : await deps.quarantine.list()

    const markChanges = await markChangesFor(deps, input.runId)

    const curation = status?.notification?.stages.curation
    // ONE FOLD, ONE PRODUCER (law 6). On the bound path the fact is minted once, by the fold
    // inside `runs.postprocessing`, and the digest publishes what that read carried rather than
    // deriving it again — an ordinary run's status carries no skipped key, so a `??` fallback
    // here would re-derive on every ordinary run. The unbound arm is the one composition where no
    // fold ran: there the digest answers from the handoff it already loaded for its own refusal,
    // never from an empty chain, which is also what an in-flight run's chain looks like.
    const skipped = status === undefined
      ? projectPostProcessingSkipped(document)
      : status.skipped

    const sections: Omit<RunDigest, 'lines'> = {
      runId,
      // VERBATIM — the same cluster views, carrying the same already-composed representative
      // sentences the one renderer produced inside `analysis.get`.
      verdictClusters: analysis?.clusters ?? [],
      chain: {
        // `undefined` answers exactly as an empty chain does: nothing was enqueued for this
        // run, which is what a host with no queue database can honestly say (388's own note).
        ...projectPostProcessingChips(undefined),
        ...(status === undefined ? {} : status.chips),
        ...(status?.notification === undefined
          ? {}
          : { outcome: status.notification.outcome }),
        ...(skipped === undefined ? {} : { skipped }),
      },
      ...(markChanges === undefined ? {} : { markChanges }),
      candidates: {
        // Absent counts read as zero HERE and only here: the row omits them when curation never
        // committed a bundle, and a digest section is a place a person reads a
        // number rather than a place a distinction between "none" and "not yet" survives — the
        // chain chips one line up already carry that distinction.
        curated: curation?.curated ?? 0,
        deprecated: curation?.deprecated ?? 0,
      },
      quarantine: {
        quarantined: quarantine.filter((entry) => entry.state === 'quarantined').length,
        expired: quarantine.filter((entry) => entry.state === 'expired').length,
        // `released` entries are deliberately absent from both the counts and the refs: a
        // released test is one somebody already dealt with, and listing it every run would be
        // the graveyard 390 legislated against, one surface later.
        refs: quarantine
          .filter((entry) => entry.state === 'quarantined')
          .map(quarantineRef),
      },
    }

    return { ...sections, lines: renderDigestLines(sections) }
  },
}
