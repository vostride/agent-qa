import type { RunArtifactKind } from '@vostride/agent-qa-schema'

export const DRAWER_COPY = {
  test: 'Test',
  config: 'Config',
  testAsWritten: 'Test as written',
  resolvedDefinition: 'Resolved definition',
  suiteMembers: 'Suite members',
  runTests: 'Tests in this run',
  runAttributes: 'Run attributes',
  effectiveConfig: 'Effective config',
  globalConfigAsWritten: 'Global config as written',
  model: 'Model',
  runtime: 'Runtime',
  errors: 'Errors',
  notCaptured: 'Not captured',
  configNotCaptured: 'Config not captured',
  unsealedCapture: "This run's setup capture didn't finish, so the test and config shown here may be incomplete.",
  technicalDetails: 'Technical details',
  runId: 'Run ID',
  artifactKind: 'Artifact kind',
  schemaVersion: 'Schema version',
  captureSealedAt: 'Capture sealed at',
  copyRunId: 'Copy run ID',
  retry: 'Retry loading run details',
  ranHere: 'Ran on this machine',
} as const

/** Where a test ran: the remote's name, then its protocol and origin, then its browser version. */
export function ranOnLine(name: string, where: string, version: string | null): string {
  return `Ran on ${name}${where ? ` (${where})` : ''}${version ? `, ${version}` : ''}`
}

export const RUN_ARTIFACT_KIND_LABELS = {
  test: 'Test',
  unknown: 'Not recorded',
} satisfies Record<RunArtifactKind, string>

export type CaptureState = 'sealed' | 'unsealed'
export const CAPTURE_STATES = ['sealed', 'unsealed'] as const satisfies readonly CaptureState[]

export function captureStateOf(artifact: { finalizedAt?: string | null }): CaptureState {
  return artifact.finalizedAt ? 'sealed' : 'unsealed'
}

export function DRAWER_TITLE_FALLBACK(id: string): string {
  return `Run ${id}`
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() && value.trim().toLowerCase() !== 'unknown'
    ? value
    : undefined
}

export function ranAgainstParts(snapshot: unknown): string[] {
  const config = record(snapshot)
  const runtime = record(config.runtime)
  const effective = record(config.effectiveConfig)
  const use = record(effective.use)
  const browser = record(use.browser)
  const planner = record(record(config.model).planner)
  const target = text(runtime.targetName) ?? text(effective.baseUrl)
  const platform = text(runtime.platform) ?? text(use.platform)
  const platformAndBrowser = [platform, text(browser.name)].filter(Boolean).join(' ')
  return [target, platformAndBrowser, text(planner.model)]
    .filter((part): part is string => typeof part === 'string' && part.length > 0)
}
