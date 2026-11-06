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

const DROPPED_SESSION_ENDINGS = {
  lost: 'until the connection was lost',
  ended: 'until the remote ended the session',
} as const

export type DroppedSessionKind = keyof typeof DROPPED_SESSION_ENDINGS

export function isDroppedSessionKind(kind: string): kind is DroppedSessionKind {
  return Object.hasOwn(DROPPED_SESSION_ENDINGS, kind)
}

/** A test that ran on a remote until its session dropped. */
export function droppedOnLine(
  name: string,
  where: string,
  version: string | null,
  kind: DroppedSessionKind,
): string {
  return `${ranOnLine(name, where, version)}, ${DROPPED_SESSION_ENDINGS[kind]}`
}

const REFUSAL_WORDING: ReadonlyMap<string, string> = new Map([['refused', 'session refused']])

/** A remote that refused the test before it ran, and the failure kind its evidence records. */
export function couldNotRunOnLine(name: string, where: string, failureKind: string): string {
  const reason = REFUSAL_WORDING.get(failureKind) ?? failureKind
  return `Could not run on ${name}${where ? ` (${where})` : ''}: ${reason}`
}

const DEVICE_TYPES = ['simulator', 'real device'] as const

export type ShownDeviceType = (typeof DEVICE_TYPES)[number]

export function isShownDeviceType(value: string | null): value is ShownDeviceType {
  return DEVICE_TYPES.some((type) => type === value)
}

/** What a device session ran on: the Appium server's version, then the iOS device type. */
export function deviceDetail(
  appiumVersion: string | null,
  deviceType: string | null,
): string | null {
  const parts = [
    appiumVersion ? `Appium ${appiumVersion}` : null,
    isShownDeviceType(deviceType) ? deviceType : null,
  ].filter((part): part is string => part !== null)
  return parts.length > 0 ? parts.join(', ') : null
}

/** A test that ran here, with its iOS device type when one was recorded. */
export function ranHereLine(deviceType: string | null): string {
  return isShownDeviceType(deviceType)
    ? `${DRAWER_COPY.ranHere}, ${deviceType}`
    : DRAWER_COPY.ranHere
}

/** The plugins entry that served a session: its entry, then its package or path and version. */
export function pluginLine(plugin: unknown): string | null {
  const shown = record(plugin)
  const entry = text(shown.entry)
  if (entry === undefined) return null
  const source = [text(shown.package) ?? text(shown.path), text(shown.version)].filter(Boolean)
  return source.length > 0 ? `Plugin ${entry} (${source.join(' ')})` : `Plugin ${entry}`
}

export interface SessionLink {
  href: string
  label: 'Session page'
  target: '_blank'
  rel: 'noopener noreferrer'
}

/** A plugin's page for the session, opened in a new tab without a referrer; only http and https. */
export function sessionLink(link: unknown): SessionLink | null {
  if (typeof link !== 'string') return null
  let url: URL
  try {
    url = new URL(link)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  return { href: url.href, label: 'Session page', target: '_blank', rel: 'noopener noreferrer' }
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
