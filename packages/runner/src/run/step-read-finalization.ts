// Member-only terminal boundary. The standalone loop keeps its synchronous callback contract;
// only this injected proxy holds its terminal until the member finishes capture/enrichment.
import {
  A11yEvidenceDocumentSchema,
  ConsoleEvidenceDocumentSchema,
  EvidenceArtifactRefSchema,
  NetworkEvidenceDocumentSchema,
  VariableSnapshotSchema,
  RUN_EVIDENCE_DOCUMENT_SCHEMA_VERSION,
} from '@vostride/agent-qa-schema'
import type { EvidenceDocument, ModelUsageObservations, StepEvidence, StepEvidenceEntries } from '@vostride/agent-qa-schema'
import type { LoopEventEmitPort } from '../loop/ports.js'
import type { AccessibilityViolation, StepResult } from '../result.js'
import type { MemberRunConfig } from './member-runner.js'
import { synthesizeStepEvidence } from './handoff-assembly.js'
import { projectNetworkEvidence } from './network-evidence-policy.js'
import { redactSecretValue } from '../loop/secrets.js'

export function createStepReadFinalizer(
  config: MemberRunConfig,
  stepIndex: number,
  testName: string,
  toolSchemaDigest: string,
) {
  const downstream = config.sink.loopEmitFor(stepIndex)
  let pending: { evidence: StepEvidence; extra: Parameters<LoopEventEmitPort['stepFinalized']>[1] } | undefined
  let finalized = false
  let consoleCaptureFailed = false
  let consoleEvidence: StepEvidenceEntries['console'] = {
    kind: 'console', state: 'absent',
    reason: config.adapter.platform === 'web' ? 'not-captured' : 'unsupported',
  }
  let networkEvidence: StepEvidenceEntries['network'] = {
    kind: 'network', state: 'absent',
    reason: config.adapter.platform === 'web' ? 'not-captured' : 'unsupported',
  }
  let a11yEvidence: StepEvidenceEntries['a11y'] = {
    kind: 'a11y', state: 'absent',
    reason: config.adapter.platform === 'web' ? 'not-captured' : 'unsupported',
  }
  let a11yRecords: AccessibilityViolation[] | undefined
  const events: LoopEventEmitPort = {
    stepFinalized(evidence, extra) {
      if (!finalized && pending === undefined) pending = { evidence, extra }
    },
    subActionRecorded(evidence, index, extra) {
      if (!finalized) downstream.subActionRecorded(evidence, index, extra)
    },
  }

  function captureConsole(result: StepResult, signal: AbortSignal): void {
    if (consoleCaptureFailed || signal.aborted || config.logCapture?.console === false) return
    if (config.adapter.drainConsoleLogs === undefined) {
      consoleEvidence = { kind: 'console', state: 'absent', reason: 'unsupported' }
      return
    }
    try {
      const records = config.adapter.drainConsoleLogs()
      // Preserve device-log capture; the new browser evidence policy does not expand it.
      result.consoleLogs = records
      if (config.adapter.platform !== 'web') return
      if (records.length === 0) {
        consoleEvidence = { kind: 'console', state: 'absent', reason: 'empty' }
        return
      }
      const secretRedactor = config.secretRedactor
      const store = config.evidenceArtifacts
      if (!secretRedactor || !store?.persistEvidenceDocument) {
        consoleFailed()
        return
      }
      const mask = (text: string) => redactSecretValue(text, secretRedactor)
      const document = ConsoleEvidenceDocumentSchema.parse({
        schemaVersion: RUN_EVIDENCE_DOCUMENT_SCHEMA_VERSION, kind: 'console',
        records: records.map(record => ({
          level: mask(record.level), text: mask(record.text), timestamp: record.timestamp,
          ...(record.location === undefined ? {} : { location: {
            url: mask(record.location.url), lineNumber: record.location.lineNumber,
            columnNumber: record.location.columnNumber,
          } }),
        })),
      })
      const ref = EvidenceArtifactRefSchema.parse(store.persistEvidenceDocument(document))
      if (!ref.id.startsWith('console-evidence:')) throw new Error('Invalid console evidence ref')
      consoleEvidence = { kind: 'console', state: 'present', ref, counts: {
        total: document.records.length,
        errors: document.records.filter(record => record.level === 'error').length,
        warnings: document.records.filter(record => record.level === 'warn').length,
      } }
    } catch {
      consoleFailed()
    }
  }

  function consoleFailed(): void {
    if (config.adapter.platform === 'web' && config.logCapture?.console !== false) {
      consoleCaptureFailed = true
      consoleEvidence = { kind: 'console', state: 'absent', reason: 'failed' }
    }
  }

  async function captureNetwork(result: StepResult, signal: AbortSignal): Promise<void> {
    if (signal.aborted || config.logCapture?.network === false) return
    if (config.adapter.drainNetworkLogs === undefined) {
      networkEvidence = { kind: 'network', state: 'absent', reason: 'unsupported' }
      return
    }
    try {
      const records = config.adapter.drainNetworkLogs()
      result.networkLogs = records
      // Device logging remains intact; this persisted document describes browser evidence only.
      if (config.adapter.platform !== 'web') return
      if (records.length === 0) {
        networkEvidence = { kind: 'network', state: 'absent', reason: 'empty' }
        return
      }
      const secretRedactor = config.secretRedactor
      const store = config.evidenceArtifacts
      if (!secretRedactor || !store?.persistEvidenceDocument) throw new Error('Network evidence not bound')
      const document: Extract<EvidenceDocument, { kind: 'network' }> = {
        schemaVersion: RUN_EVIDENCE_DOCUMENT_SCHEMA_VERSION, kind: 'network', records: [],
      }
      // A measured 600-record, two-body fixture blocked timers for >400ms. Yield between
      // batches, retaining all drained records and the declared mask until one final publication.
      for (let offset = 0; offset < records.length; offset += 32) {
        document.records.push(...projectNetworkEvidence(
          records.slice(offset, offset + 32), text => redactSecretValue(text, secretRedactor),
        ).records)
        if (offset + 32 < records.length) await new Promise<void>(resolve => setTimeout(resolve, 0))
      }
      NetworkEvidenceDocumentSchema.parse(document)
      const ref = EvidenceArtifactRefSchema.parse(store.persistEvidenceDocument(document))
      if (!ref.id.startsWith('network-evidence:')) throw new Error('Invalid network evidence ref')
      networkEvidence = { kind: 'network', state: 'present', ref, counts: {
        total: document.records.length,
        failed: document.records.filter(record => record.status >= 400).length,
        errored: document.records.filter(record => record.status === 0).length,
      } }
    } catch {
      if (config.adapter.platform === 'web') {
        networkEvidence = { kind: 'network', state: 'absent', reason: 'failed' }
      }
    }
  }

  function recordAccessibility(records: AccessibilityViolation[]): void {
    a11yRecords = records
  }

  function accessibilityFailed(): void {
    a11yRecords = undefined
    a11yEvidence = { kind: 'a11y', state: 'absent', reason: 'failed' }
  }

  function accessibilityUnsupported(): void {
    a11yEvidence = { kind: 'a11y', state: 'absent', reason: 'unsupported' }
  }

  function persistAccessibility(): void {
    if (a11yRecords === undefined) return
    if (a11yRecords.length === 0) {
      a11yEvidence = { kind: 'a11y', state: 'absent', reason: 'empty' }
      return
    }
    try {
      const secretRedactor = config.secretRedactor
      const store = config.evidenceArtifacts
      if (!secretRedactor || !store?.persistEvidenceDocument) throw new Error('Accessibility evidence not bound')
      const mask = (text: string) => redactSecretValue(text, secretRedactor)
      const document = A11yEvidenceDocumentSchema.parse({
        schemaVersion: RUN_EVIDENCE_DOCUMENT_SCHEMA_VERSION, kind: 'a11y',
        records: a11yRecords.map(record => ({
          ruleId: mask(record.ruleId), impact: record.impact, description: mask(record.description),
          help: mask(record.help), helpUrl: mask(record.helpUrl),
          nodes: record.nodes.map(node => ({ html: mask(node.html), target: node.target.map(mask) })),
        })),
      })
      const ref = EvidenceArtifactRefSchema.parse(store.persistEvidenceDocument(document))
      if (!ref.id.startsWith('a11y-evidence:')) throw new Error('Invalid accessibility evidence ref')
      const counts = { minor: 0, moderate: 0, serious: 0, critical: 0 }
      for (const record of document.records) counts[record.impact]++
      a11yEvidence = { kind: 'a11y', state: 'present', ref, counts }
    } catch {
      accessibilityFailed()
    }
  }

  function finish(result: StepResult, modelObservations?: ModelUsageObservations): void {
    if (finalized) return
    finalized = true
    const evidence = result.evidence ?? pending?.evidence ?? synthesizeStepEvidence(result, stepIndex, {
      scope: { tier: 'test', key: testName }, buildOrdinal: config.knowledgeAsOfBuild ?? 0,
      mask: text => redactSecretValue(text, config.secretRedactor),
      modelProfile: config.modelProfiles?.planner,
      verifierIdentity: config.modelProfiles?.verifier,
      toolSchemaDigest,
    })
    // Preserve the recorded loop evidence for handoff assembly even when enrichment replaced
    // the StepResult with an abort result. Bypasses use the very same synthesis as handoffs.
    result.evidence ??= evidence
    // Persist here, and retain successful capture even if a later capture failed or aborted.
    persistAccessibility()
    let variableSnapshot: ReturnType<typeof VariableSnapshotSchema.parse> | undefined
    let variables: StepEvidenceEntries['variables'] = {
      kind: 'variables', state: 'absent', reason: 'not-captured',
    }
    if (result.variableSnapshot !== undefined) {
      try {
        if (Object.keys(result.variableSnapshot).length === 0) {
          variables = { kind: 'variables', state: 'absent', reason: 'empty' }
        } else {
          const secretRedactor = config.secretRedactor
          if (!secretRedactor) throw new Error('Variable masking not bound')
          const mask = (text: string) => redactSecretValue(text, secretRedactor)
          const maskedSnapshot = Object.fromEntries(
            Object.entries(result.variableSnapshot).map(([name, entry]) => [
              mask(name), { value: mask(entry.value), source: entry.source },
            ]),
          )
          const validated = VariableSnapshotSchema.parse(maskedSnapshot)
          variableSnapshot = Object.fromEntries(Object.keys(maskedSnapshot).map(name => [name, validated[name]]))
          variables = { kind: 'variables', state: 'present', counts: { count: Object.keys(variableSnapshot).length } }
        }
      } catch {
        variableSnapshot = undefined
        variables = { kind: 'variables', state: 'absent', reason: 'failed' }
      }
    }
    const entries: StepEvidenceEntries = {
      console: consoleEvidence,
      network: networkEvidence,
      a11y: a11yEvidence,
      variables,
    }
    const { status: _status, durationMs: _duration, error: _error, ...extra } = pending?.extra ?? {}
    downstream.stepFinalized(evidence, {
      ...extra, status: result.status, durationMs: result.duration,
      ...(result.error === undefined ? {} : { error: result.error }), evidence: entries,
      ...(variableSnapshot === undefined ? {} : { variableSnapshot }),
      ...(modelObservations === undefined ? {} : { modelObservations }),
    })
  }

  return { events, captureConsole, captureNetwork, consoleFailed,
    recordAccessibility, accessibilityFailed, accessibilityUnsupported, finish }
}
