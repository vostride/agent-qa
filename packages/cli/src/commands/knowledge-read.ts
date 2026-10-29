// Thin clients over `invokeFunction`; the build tag resolves through the shared composition edge.

import { dirname, resolve } from 'node:path'

import { invokeFunction } from '@vostride/agent-qa-agent'
import { resolveBuildTag } from '@vostride/agent-qa-agent-local'
import {
  guardJsonText,
  printRunText,
  reserveStdoutForData,
} from '@vostride/agent-qa-core/run-text-output'
import {
  guardInspectRecordView,
  guardRecordChange,
  InspectFilterSchema,
  KnowledgeGatesListResultSchema,
  maskPayloadTree,
} from '@vostride/agent-qa-schema'
import type {
  BriefWhyResult,
  GateReceipt,
  InspectFilter,
  InspectRecordView,
  KnowledgeBundleSummary,
  KnowledgeGatesListResult,
  KnowledgeRecordShowResult,
  KnowledgeRecordsDiffOutput,
  KnowledgeRecordsInspectOutput,
  MaskFn,
  RecordChange,
} from '@vostride/agent-qa-schema'
import { Command, InvalidArgumentError } from 'commander'
import pc from 'picocolors'
import { z } from 'zod'

import {
  createDeclaredSecretMask,
  DeclaredSecretsUnavailableError,
  type DeclaredSecretMask,
} from '../composition/declared-secrets.js'
import {
  CLI_FUNCTION_CALLER,
  composeCliLocalAgent,
} from '../composition/local-agent-host.js'

interface InspectOptions {
  product?: string
  scope?: string
  kind?: string
  status?: string
  anchor?: string
  record?: string
  asOfBuild?: string
  unresolved?: boolean
  json?: boolean
}

interface DiffOptions {
  product?: string
  json?: boolean
}

interface BundlesOptions {
  json?: boolean
}

interface BriefWhyOptions {
  step: number
  test?: string
  record?: string
  json?: boolean
}

/**
 * The capability the `bundles` verb is a client of. The id is all this file knows: what
 * enumerates the store, how trust is folded, and which package reads the disk are the
 * function layer's business, reached only through `invokeFunction`.
 */
const KNOWLEDGE_BUNDLES_LIST_ID = 'knowledge.bundles.list'

/** The record-level read verbs `inspect` and `diff` are clients of. */
const KNOWLEDGE_RECORDS_INSPECT_ID = 'knowledge.records.inspect'
const KNOWLEDGE_RECORDS_DIFF_ID = 'knowledge.records.diff'
const KNOWLEDGE_GATES_LIST_ID = 'knowledge.gates.list'
const KNOWLEDGE_RECORD_SHOW_ID = 'knowledge.record.show'
const KNOWLEDGE_BRIEF_WHY_ID = 'knowledge.brief.why'

type KnowledgeReadErrorCode =
  | 'invalid-filter'
  | 'invalid-ref'
  | 'missing-product'
  | 'unknown-build-tag'

class KnowledgeReadCommandError extends Error {
  constructor(
    readonly code: KnowledgeReadErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'KnowledgeReadCommandError'
  }
}

const CHANGE_ORDER: readonly RecordChange['change'][] = [
  'added',
  'confirmed',
  'superseded',
  'deprecated',
  'promoted',
  'purged',
]

// Keep the operator boundary fail-closed even when a workspace is running against stale built
// schema output. The shared contract carries the same enum and non-negative ordinal constraints.
const CliInspectFilterSchema = InspectFilterSchema.extend({
  status: z.enum(['active', 'candidate', 'superseded', 'deprecated']).optional(),
  asOfBuild: z.number().int().nonnegative().optional(),
})

function globalOptions(command: Command): { config?: string } {
  return command.parent?.parent?.opts<{ config?: string }>() ?? {}
}

/**
 * Everything the function-layer composition root needs, derived from the one global flag.
 *
 * Deliberately path-only and synchronous: a thin client resolves WHERE the project is and
 * nothing else. Config resolution, the knowledge root, and every host read happen inside
 * the composition's injected ports, which is why this verb needs no data package.
 */
function functionLayerInput(command: Command): { agentQaRoot: string; configPath: string } {
  const configPath = resolve(globalOptions(command).config ?? 'agent-qa.config.yaml')
  return { agentQaRoot: resolve(dirname(configPath), '.agent-qa'), configPath }
}

/** The composition input with the invocation's declared mask, refusing at start without one. */
function declaredReadInput(
  command: Command,
): { agentQaRoot: string; configPath: string; declaredSecrets: DeclaredSecretMask } {
  const composition = functionLayerInput(command)
  const declaredSecrets = createDeclaredSecretMask(composition.configPath)
  declaredSecrets.redactor()
  return { ...composition, declaredSecrets }
}

function validationMessage(issues: readonly { path: PropertyKey[]; message: string }[]): string {
  return issues
    .map((issue) => {
      const path = issue.path.map(String).join('.')
      return path.length === 0 ? issue.message : `${path}: ${issue.message}`
    })
    .join('; ')
}

function inspectFilter(options: InspectOptions): InspectFilter {
  const result = CliInspectFilterSchema.safeParse({
    ...(options.product === undefined ? {} : { product: options.product }),
    ...(options.scope === undefined ? {} : { scope: options.scope }),
    ...(options.kind === undefined ? {} : { kind: options.kind }),
    ...(options.status === undefined ? {} : { status: options.status }),
    ...(options.anchor === undefined ? {} : { anchor: options.anchor }),
    ...(options.record === undefined ? {} : { recordId: options.record }),
    ...(options.asOfBuild === undefined ? {} : { asOfBuild: Number(options.asOfBuild) }),
    ...(options.unresolved === true ? { unresolvedOnly: true } : {}),
  })
  if (!result.success) {
    throw new KnowledgeReadCommandError(
      'invalid-filter',
      validationMessage(result.error.issues),
    )
  }
  return result.data
}

function resolvedDiffOrdinal(
  ref: string,
  product: string | undefined,
  runtimeRoot: string,
): number {
  if (/^-?\d+$/u.test(ref)) {
    const ordinal = Number(ref)
    if (!Number.isSafeInteger(ordinal) || ordinal < 0) {
      throw new KnowledgeReadCommandError(
        'invalid-ref',
        `Build ordinal must be a non-negative safe integer: ${ref}`,
      )
    }
    return ordinal
  }

  if (product === undefined || product.trim().length === 0) {
    throw new KnowledgeReadCommandError(
      'missing-product',
      'A build tag reference requires --product <p>.',
    )
  }

  const ordinal = resolveBuildTag({
    root: runtimeRoot,
    product,
    tag: ref,
  })
  if (ordinal === undefined) {
    throw new KnowledgeReadCommandError(
      'unknown-build-tag',
      `Unknown build tag "${ref}" for product "${product}".`,
    )
  }
  return ordinal
}

// Everything printed is masked and never restored; JSON is masked by key and leaf first.
function emitJson(mask: MaskFn, value: unknown): void {
  console.log(guardJsonText(JSON.stringify(maskPayloadTree(value, mask), null, 2)))
}

function emitHuman(mask: MaskFn, text: string): void {
  printRunText(mask(text))
}

function reserveStdoutForJson(options: { json?: boolean }): (() => void) | undefined {
  return options.json === true ? reserveStdoutForData() : undefined
}

function formatInspectRecord(record: InspectRecordView): string {
  const evidenceTokens = record.evidenceTokens.length === 0
    ? 'none'
    : record.evidenceTokens.join(', ')
  const lines = [
    pc.bold(record.recordId),
    `  counts: confirmations=${record.confirmations} contradictions=${record.contradictions}`,
    `  evidence tokens: ${evidenceTokens}`,
    `  product: ${record.product}`,
    `  scope: ${record.scope}`,
    `  kind: ${record.kind}`,
    `  status: ${record.status}`,
    `  validity: ${record.openedAtOrdinal}..${record.closedAtOrdinal ?? 'open'}`,
    `  last event ordinal: ${record.lastEventOrdinal}`,
    `  anchors: ${record.anchors.length === 0 ? 'none' : record.anchors.join(', ')}`,
  ]

  if (record.trustNarrative !== undefined && record.trustNarrative !== null) {
    lines.push(
      pc.dim('  ┌ advisory (LLM narrative)'),
      ...record.trustNarrative
        .split('\n')
        .map((line) => pc.dim(`  │ ${line}`)),
      pc.dim('  └ end advisory'),
    )
  }

  return lines.join('\n')
}

function renderInspect(records: readonly InspectRecordView[]): string {
  if (records.length === 0) {
    return pc.dim('No knowledge records matched the filter.')
  }
  return [
    pc.bold(`Knowledge records (${records.length})`),
    '',
    ...records.flatMap((record, index) => (
      index === records.length - 1
        ? [formatInspectRecord(record)]
        : [formatInspectRecord(record), '']
    )),
  ].join('\n')
}

function renderChange(change: RecordChange): string {
  return [
    `  ${change.recordId}`,
    `@${change.atOrdinal}`,
    ...(change.byRecordId === undefined ? [] : [`by ${change.byRecordId}`]),
    ...(change.evidenceToken === undefined ? [] : [`evidence ${change.evidenceToken}`]),
  ].join('  ')
}

function renderDiff(changes: readonly RecordChange[], ordinal: number): string {
  if (changes.length === 0) {
    return pc.dim(`No knowledge changes after build ordinal ${ordinal}.`)
  }

  const lines = [pc.bold(`Knowledge changes after build ordinal ${ordinal}`)]
  for (const kind of CHANGE_ORDER) {
    const group = changes.filter((change) => change.change === kind)
    if (group.length === 0) continue
    lines.push('', pc.bold(`${kind} (${group.length})`), ...group.map(renderChange))
  }
  return lines.join('\n')
}

function formatBundleSummary(row: KnowledgeBundleSummary): string {
  const kind = row.subtype === undefined ? row.kind : `${row.kind} / ${row.subtype}`
  return [
    pc.bold(row.bundleId),
    `  product: ${row.product}`,
    `  kind: ${kind}`,
    `  scope: ${row.scope.tier}:${row.scope.key}`,
    `  status: ${row.status}`,
    `  trust: ${row.trust.toFixed(3)}${row.evidenceIncomplete ? pc.dim(' (evidence incomplete)') : ''}`,
    `  counters: confirmed=${row.counters.confirmed} contradicted=${row.counters.contradicted}`
      + ` helpful=${row.counters.helpful} harmful=${row.counters.harmful}`,
    `  validity: ${row.openedAtOrdinal}..${row.closedAtOrdinal ?? 'open'}`,
    `  last confirmed: ${row.lastConfirmedOrdinal}`,
    `  dir: ${row.dir}`,
    `  summary: ${row.summary}`,
  ].join('\n')
}

/**
 * Rows are rendered in the order the capability returned them. The op owns the total order
 * (product, then bundle id) so every surface listing the same store agrees — sorting again
 * here would be a second, surface-local ordering nobody else shares.
 */
function renderBundles(rows: readonly KnowledgeBundleSummary[]): string {
  if (rows.length === 0) {
    return pc.dim('No committed knowledge bundles.')
  }
  return [
    pc.bold(`Knowledge bundles (${rows.length})`),
    '',
    ...rows.flatMap((row, index) => (
      index === rows.length - 1
        ? [formatBundleSummary(row)]
        : [formatBundleSummary(row), '']
    )),
  ].join('\n')
}

function renderGates(dto: KnowledgeGatesListResult): string {
  if (dto.kind === 'not-found') return `record ${dto.recordId}: not found`
  const live = dto.live.verdict === 'promote'
    ? `promote via ${dto.live.promotionPath}` : `held: ${dto.live.reason}`
  if (dto.lines.length === 0) {
    return dto.live.verdict === 'promote'
      ? `no gate receipts; would promote via ${dto.live.promotionPath}`
      : `no gate receipts; ${live}`
  }
  const short = (digest: string) => digest.slice(0, 12)
  const describe = (receipt: GateReceipt) => receipt.policyApproval !== undefined
    ? `approval proposal ${receipt.policyApproval.proposalId} @${receipt.producedAtOrdinal}`
    : `mark ${receipt.mark} @${receipt.producedAtOrdinal}`
  const standingMark = dto.standing.find(receipt => receipt.policyApproval === undefined)
  const standingApproval = dto.standing.find(receipt => receipt.policyApproval !== undefined)
  return [
    ...dto.lines.map(line => {
      if ('kind' in line) {
        const cites = line.citedReceiptDigests.map(short).join(', ') || 'none'
        return `promotion ${line.promotionPath} @${line.producedAtOrdinal} cites ${cites}`
      }
      const run = line.policyApproval !== undefined ? ''
        : ` run ${line.runId}${line.stepId === undefined ? '' : ` step ${line.stepId}`}`
      return `${describe(line)}${run} digest ${short(line.receiptDigest)}`
    }),
    `standing: ${standingMark === undefined ? 'mark none' : describe(standingMark)}; `
      + `${standingApproval === undefined ? 'approval none' : describe(standingApproval)}`,
    `live: ${live}`,
  ].join('\n')
}

function renderRecordShow(dto: KnowledgeRecordShowResult): string {
  if (dto.kind === 'not-found') return `record ${dto.recordId}: not found`
  const { record, provenance } = dto
  const lines = [
    `record ${record.recordId} · ${record.kind} · ${record.status} · ${record.product} · scope ${record.scope}`,
    provenance.mode === 'run-linked'
      ? `  provenance run-linked · run ${provenance.runId} · test ${provenance.testId}`
        + ` · step ${String(provenance.stepIndex)} · origin ${provenance.originClass}`
      : `  provenance standalone · origin ${provenance.originClass} · ${provenance.sourceDescription}`,
    `  summary: ${dto.summary}`,
    '',
    provenance.mode === 'run-linked'
      ? `Next: agent-qa knowledge brief-why ${provenance.runId} --step ${String(provenance.stepIndex)}`
        + ` --test ${provenance.testId} --record ${record.recordId}`
      : `Next: agent-qa knowledge gates ${record.recordId}`,
  ]
  return lines.join('\n')
}

function renderBriefWhy(dto: BriefWhyResult, runId: string, options: BriefWhyOptions): string {
  const address = `run ${runId}${options.test === undefined ? '' : ` · test ${options.test}`}`
    + ` · step ${String(options.step)}`
  if (dto.kind === 'no-trace') {
    const offered = dto.servedBrief === undefined ? ''
      : ` · the served brief survived (${String(dto.servedBrief.channel1.length + dto.servedBrief.channel2.length
        + dto.servedBrief.channel3.length)} lines, in --json)`
    return `${address} · no trace (${dto.reason})${offered}`
  }
  const line = (label: string, entry: BriefWhyTraceLine) =>
    `  ${label} ${entry.recordId} · ${entry.leg} · rank ${String(entry.rank)} · score ${String(entry.score)}`
  const lines = [
    `${address} · trace recorded${dto.servedBriefRef === undefined ? '' : ` · brief ${dto.servedBriefRef}`}`,
    ...dto.trace.servedLines.map((entry) => line('served', entry)),
    ...dto.trace.truncated.map((entry) => line('cut', entry)),
  ]
  if (dto.trace.servedLines.length + dto.trace.truncated.length === 0) {
    lines.push(`  ${options.record === undefined ? 'no line' : `record ${options.record}`} took part in this brief`)
  }
  const first = dto.trace.servedLines[0] ?? dto.trace.truncated[0]
  if (first !== undefined) lines.push('', `Next: agent-qa knowledge show ${first.recordId}`)
  return lines.join('\n')
}

type BriefWhyTraceLine = Extract<BriefWhyResult, { kind: 'answered' }>['trace']['servedLines'][number]

function parseStepIndex(value: string): number {
  const step = /^\d+$/.test(value) ? Number(value) : Number.NaN
  if (!Number.isSafeInteger(step)) throw new InvalidArgumentError('step must be a non-negative integer')
  return step
}

type KnowledgeReadAction = 'inspect' | 'diff' | 'bundles' | 'gates' | 'show' | 'brief-why'

function printUnavailable(error: DeclaredSecretsUnavailableError): void {
  const [first, ...rest] = error.lines
  if (first === undefined) return
  printRunText([pc.red(first), ...rest.map((line) => pc.dim(line))].join('\n'),
    (text) => console.error(text))
}

// A refusal raised before the loader exists has nothing to mask with.
function printErrorLine(line: string, mask: MaskFn | undefined): void {
  let shown = line
  if (mask !== undefined) {
    try {
      shown = mask(line)
    } catch (maskError) {
      if (!(maskError instanceof DeclaredSecretsUnavailableError)) throw maskError
      printUnavailable(maskError)
      return
    }
  }
  printRunText(pc.red(shown), (text) => console.error(text))
}

function reportError(action: KnowledgeReadAction, error: unknown, mask: MaskFn | undefined): void {
  process.exitCode = 1
  if (error instanceof DeclaredSecretsUnavailableError) {
    printUnavailable(error)
    return
  }
  if (error instanceof KnowledgeReadCommandError) {
    printErrorLine(`Knowledge ${action} error [${error.code}]: ${error.message}`, mask)
    return
  }
  const hint = error instanceof Error && error.name === 'AmbiguousStepAddressError'
    ? ' Pass --test <testId> to choose one.'
    : ''
  printErrorLine(
    `Knowledge ${action} error: ${error instanceof Error ? error.message : String(error)}${hint}`,
    mask,
  )
}

function reportMissing(action: KnowledgeReadAction, message: string, mask: MaskFn): void {
  printErrorLine(`Knowledge ${action} error [not-found]: ${message}`, mask)
  process.exitCode = 1
}

export function registerKnowledgeReadCommands(command: Command): void {
  command
    .command('inspect')
    .description('Inspect committed knowledge records with structural filters')
    .option('--product <p>', 'filter by product')
    .option('--scope <s>', 'filter by canonical scope key')
    .option('--kind <k>', 'filter by kind: fact|procedure|caution|unknown|policy')
    .option(
      '--status <st>',
      'filter by status; superseded/deprecated automatically include audit-visible records',
    )
    .option('--anchor <a>', 'filter by canonical anchor JSON or normalized scalar value')
    .option('--record <id>', 'filter by record id')
    .option('--as-of-build <n>', 'show records valid at a non-negative build ordinal')
    .option('--unresolved', 'show only unresolved unknown records')
    .option('--json', 'output schema-validated masked JSON')
    .action(async (options: InspectOptions, inspectCommand: Command) => {
      let mask: MaskFn | undefined
      const releaseStdout = reserveStdoutForJson(options)
      try {
        const input = declaredReadInput(inspectCommand)
        mask = input.declaredSecrets.mask
        // The filter is parsed here because the operator BOUNDARY is this file's job: a bad
        // `--status` is a mistake about a flag, and reporting it as a contract violation from
        // inside the layer would name a field the operator never typed. Everything past the
        // parse — which records match, how trust is folded, what order rows come back in —
        // belongs to the capability.
        const filter = inspectFilter(options)
        const result = await invokeFunction(
          composeCliLocalAgent(input).registry,
          KNOWLEDGE_RECORDS_INSPECT_ID,
          { filter },
          CLI_FUNCTION_CALLER,
        ) as KnowledgeRecordsInspectOutput
        const records = result.records.map(guardInspectRecordView)

        if (options.json === true) {
          emitJson(mask, records)
          return
        }
        emitHuman(mask, renderInspect(records))
      } catch (error) {
        reportError('inspect', error, mask)
      } finally {
        releaseStdout?.()
      }
    })

  command
    .command('diff')
    .description('Show semantic knowledge changes after a build ordinal or tag')
    .argument('<ref>', 'non-negative build ordinal or build tag')
    .option('--product <p>', 'product used to resolve a build tag')
    .option('--json', 'output schema-validated masked JSON')
    .action(async (ref: string, options: DiffOptions, diffCommand: Command) => {
      let mask: MaskFn | undefined
      const releaseStdout = reserveStdoutForJson(options)
      try {
        const composition = declaredReadInput(diffCommand)
        mask = composition.declaredSecrets.mask
        const ordinal = resolvedDiffOrdinal(ref, options.product, composition.agentQaRoot)
        const result = await invokeFunction(
          composeCliLocalAgent(composition).registry,
          KNOWLEDGE_RECORDS_DIFF_ID,
          { sinceOrdinal: ordinal },
          CLI_FUNCTION_CALLER,
        ) as KnowledgeRecordsDiffOutput
        const changes = result.changes.map(guardRecordChange)

        if (options.json === true) {
          emitJson(mask, changes)
          return
        }
        emitHuman(mask, renderDiff(changes, ordinal))
      } catch (error) {
        reportError('diff', error, mask)
      } finally {
        releaseStdout?.()
      }
    })

  command
    .command('gates <id>')
    .description('Print a record\'s marks, approvals, promotion lines and live verdict through the agent function layer')
    .option('--json', 'output schema-validated masked JSON')
    .action(async (id: string, options: BundlesOptions, cmd: Command) => {
      let mask: MaskFn | undefined
      const releaseStdout = reserveStdoutForJson(options)
      try {
        const input = declaredReadInput(cmd)
        mask = input.declaredSecrets.mask
        const dto = KnowledgeGatesListResultSchema.parse(await invokeFunction(
          composeCliLocalAgent(input).registry,
          KNOWLEDGE_GATES_LIST_ID,
          { recordId: id },
          CLI_FUNCTION_CALLER,
        ))
        if (options.json === true) {
          emitJson(mask, dto)
          return
        }
        emitHuman(mask, renderGates(dto))
      } catch (error) {
        reportError('gates', error, mask)
      } finally {
        releaseStdout?.()
      }
    })

  command
    .command('show <recordId>')
    .description('Show one knowledge record with the provenance that justifies it')
    .option('--json', 'print the knowledge.record.show result unchanged')
    .action(async (recordId: string, options: BundlesOptions, cmd: Command) => {
      let mask: MaskFn | undefined
      const releaseStdout = reserveStdoutForJson(options)
      try {
        const input = declaredReadInput(cmd)
        mask = input.declaredSecrets.mask
        const dto = await invokeFunction(
          composeCliLocalAgent(input).registry,
          KNOWLEDGE_RECORD_SHOW_ID,
          { recordId },
          CLI_FUNCTION_CALLER,
        ) as KnowledgeRecordShowResult
        if (options.json === true) emitJson(mask, dto)
        else emitHuman(mask, renderRecordShow(dto))
        if (dto.kind === 'not-found') {
          reportMissing(
            'show',
            `no committed record ${recordId}; list record ids with agent-qa knowledge inspect`,
            mask,
          )
        }
      } catch (error) {
        reportError('show', error, mask)
      } finally {
        releaseStdout?.()
      }
    })

  command
    .command('brief-why <runId>')
    .description('Explain why one step\'s served brief said what it said, from its recorded trace')
    .requiredOption('--step <n>', 'zero-based step index', parseStepIndex)
    .option('--test <testId>', 'the test id whose step is meant, when the run has several tests')
    .option('--record <recordId>', 'narrow the trace to one record')
    .option('--json', 'print the knowledge.brief.why result unchanged')
    .action(async (runId: string, options: BriefWhyOptions, cmd: Command) => {
      let mask: MaskFn | undefined
      const releaseStdout = reserveStdoutForJson(options)
      try {
        const input = declaredReadInput(cmd)
        mask = input.declaredSecrets.mask
        const dto = await invokeFunction(
          composeCliLocalAgent(input).registry,
          KNOWLEDGE_BRIEF_WHY_ID,
          {
            runId,
            stepIndex: options.step,
            ...(options.test === undefined ? {} : { testId: options.test }),
            ...(options.record === undefined ? {} : { recordId: options.record }),
          },
          CLI_FUNCTION_CALLER,
        ) as BriefWhyResult
        if (options.json === true) emitJson(mask, dto)
        else emitHuman(mask, renderBriefWhy(dto, runId, options))
        if (dto.kind === 'no-trace' && dto.reason === 'artifact-missing') {
          reportMissing(
            'brief-why',
            `no completed run ${runId} is recorded; run agent-qa runs list to see run ids`,
            mask,
          )
        } else if (dto.kind === 'no-trace' && dto.reason === 'step-not-found') {
          reportMissing('brief-why', `run ${runId} has no step ${String(options.step)}`
            + `${options.test === undefined ? '' : ` in test ${options.test}`}; run agent-qa runs overview ${runId}`
            + ' to see its test ids and steps', mask)
        }
      } catch (error) {
        reportError('brief-why', error, mask)
      } finally {
        releaseStdout?.()
      }
    })

  // Registered last: a source-shape test reads this registration as the slice to the file's end.
  command
    .command('bundles')
    .description('List committed knowledge bundles through the agent function layer')
    .option('--json', 'output schema-validated masked JSON')
    .action(async (options: BundlesOptions, bundlesCommand: Command) => {
      let mask: MaskFn | undefined
      const releaseStdout = reserveStdoutForJson(options)
      try {
        const input = declaredReadInput(bundlesCommand)
        mask = input.declaredSecrets.mask
        // Everything behind this call — enumerating the store, folding trust, ordering the
        // rows, crossing the policy gate, writing the audit row — belongs to the capability.
        // This verb supplies a caller record and a project root, and renders the result.
        const rows = await invokeFunction(
          composeCliLocalAgent(input).registry,
          KNOWLEDGE_BUNDLES_LIST_ID,
          {},
          CLI_FUNCTION_CALLER,
        ) as readonly KnowledgeBundleSummary[]

        if (options.json === true) {
          emitJson(mask, rows)
          return
        }
        emitHuman(mask, renderBundles(rows))
      } catch (error) {
        reportError('bundles', error, mask)
      } finally {
        releaseStdout?.()
      }
    })
}
