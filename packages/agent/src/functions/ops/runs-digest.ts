// Composed live from the sibling ops each call, so nothing is persisted and nothing can drift.

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

// Under `runs.` because it returns a fact about a run.
export const RUNS_DIGEST_FUNCTION_ID = 'runs.digest'

/** The exit summary's line separator, reused so one story reads as one. */
const DIGEST_SEPARATOR = ' · '

// Absent where no feedback reads are bound, so an empty list is always a measurement.
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

// The durable identity legs, joined; never `testId`, which is per-run.
function quarantineRef(entry: QuarantineEntryState): string {
  return `${entry.product}/${entry.filePath}::${entry.testName}`
}

// Composed once here, and empty sections still print their zero rather than vanish.
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

  // A skipped run has no chain, so the fact replaces chip words that would read `pending` forever.
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
  // Refs and counts only; the digest's lines travel on `results[]`.
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
      // Verbatim cluster views, with the representative sentences `analysis.get` composed.
      verdictClusters: analysis?.clusters ?? [],
      chain: {
        // `undefined` answers as an empty chain: nothing was enqueued for this run.
        ...projectPostProcessingChips(undefined),
        ...(status === undefined ? {} : status.chips),
        ...(status?.notification === undefined
          ? {}
          : { outcome: status.notification.outcome }),
        ...(skipped === undefined ? {} : { skipped }),
      },
      ...(markChanges === undefined ? {} : { markChanges }),
      candidates: {
        // Absent counts read as zero only here; the chain chips carry none versus not yet.
        curated: curation?.curated ?? 0,
        deprecated: curation?.deprecated ?? 0,
      },
      quarantine: {
        quarantined: quarantine.filter((entry) => entry.state === 'quarantined').length,
        expired: quarantine.filter((entry) => entry.state === 'expired').length,
        // Released entries stay out of counts and refs; somebody already dealt with them.
        refs: quarantine
          .filter((entry) => entry.state === 'quarantined')
          .map(quarantineRef),
      },
    }

    return { ...sections, lines: renderDigestLines(sections) }
  },
}
