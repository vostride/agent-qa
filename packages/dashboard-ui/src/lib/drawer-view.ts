import type { RunArtifactKind } from '@vostride/agent-qa-schema'
import { t } from '@/i18n'
import { textTable } from '@/i18n/text-table'

export const DRAWER_COPY = textTable({
  test: () => t('evidence.drawer.test'),
  config: () => t('evidence.drawer.config'),
  testAsWritten: () => t('evidence.drawer.testAsWritten'),
  resolvedDefinition: () => t('evidence.drawer.resolvedDefinition'),
  suiteMembers: () => t('evidence.drawer.suiteMembers'),
  runTests: () => t('evidence.drawer.runTests'),
  runAttributes: () => t('evidence.drawer.runAttributes'),
  effectiveConfig: () => t('evidence.drawer.effectiveConfig'),
  globalConfigAsWritten: () => t('evidence.drawer.globalConfigAsWritten'),
  model: () => t('evidence.drawer.model'),
  runtime: () => t('evidence.drawer.runtime'),
  errors: () => t('evidence.drawer.errors'),
  notCaptured: () => t('evidence.drawer.notCaptured'),
  configNotCaptured: () => t('evidence.drawer.configNotCaptured'),
  unsealedCapture: () => t('evidence.drawer.unsealedCapture'),
  technicalDetails: () => t('evidence.drawer.technicalDetails'),
  runId: () => t('evidence.drawer.runId'),
  artifactKind: () => t('evidence.drawer.artifactKind'),
  schemaVersion: () => t('evidence.drawer.schemaVersion'),
  captureSealedAt: () => t('evidence.drawer.captureSealedAt'),
  copyRunId: () => t('evidence.drawer.copyRunId'),
  retry: () => t('evidence.drawer.retry'),
  ranHere: () => t('evidence.drawer.ranHere'),
  opensInNewTab: () => t('evidence.drawer.opensInNewTab'),
})

/** Where a test ran: the remote's name, then its protocol and origin, then its browser version. */
export function ranOnLine(name: string, where: string, version: string | null): string {
  const remote = remoteName(name, where)
  return version ? t('evidence.drawer.ranOnVersion', { remote, version }) : t('evidence.drawer.ranOn', { remote })
}

function remoteName(name: string, where: string): string {
  return where ? t('evidence.drawer.remote', { name, where }) : name
}

const DROPPED_SESSION_KINDS = ['lost', 'ended'] as const

export type DroppedSessionKind = (typeof DROPPED_SESSION_KINDS)[number]

export function isDroppedSessionKind(kind: string): kind is DroppedSessionKind {
  return DROPPED_SESSION_KINDS.some((dropped) => dropped === kind)
}

/** A test that ran on a remote until its session dropped. */
export function droppedOnLine(
  name: string,
  where: string,
  version: string | null,
  kind: DroppedSessionKind,
): string {
  const remote = remoteName(name, where)
  if (kind === 'lost') {
    return version
      ? t('evidence.drawer.lostOnVersion', { remote, version })
      : t('evidence.drawer.lostOn', { remote })
  }
  return version
    ? t('evidence.drawer.endedOnVersion', { remote, version })
    : t('evidence.drawer.endedOn', { remote })
}

const REFUSAL_WORDING: ReadonlyMap<string, () => string> = new Map([
  ['refused', () => t('evidence.drawer.sessionRefused')],
])

/** A remote that refused the test before it ran, and the failure kind its evidence records. */
export function couldNotRunOnLine(name: string, where: string, failureKind: string): string {
  const reason = REFUSAL_WORDING.get(failureKind)?.() ?? failureKind
  return t('evidence.drawer.couldNotRun', { remote: remoteName(name, where), reason })
}

const DEVICE_TYPES = ['simulator', 'real device'] as const

export type ShownDeviceType = (typeof DEVICE_TYPES)[number]

const DEVICE_TYPE_WORDS: Readonly<Record<ShownDeviceType, string>> = textTable({
  simulator: () => t('evidence.drawer.deviceType.simulator'),
  'real device': () => t('evidence.drawer.deviceType.realDevice'),
})

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
    isShownDeviceType(deviceType) ? DEVICE_TYPE_WORDS[deviceType] : null,
  ].filter((part): part is string => part !== null)
  return parts.length > 0 ? parts.join(', ') : null
}

/** A test that ran here, with its iOS device type when one was recorded. */
export function ranHereLine(deviceType: string | null): string {
  return isShownDeviceType(deviceType)
    ? t('evidence.drawer.ranHereOn', { deviceType: DEVICE_TYPE_WORDS[deviceType] })
    : DRAWER_COPY.ranHere
}

/** The plugins entry that served a session: its entry, then its package or path and version. */
export function pluginLine(plugin: unknown): string | null {
  const shown = record(plugin)
  const entry = text(shown.entry)
  if (entry === undefined) return null
  const source = [text(shown.package) ?? text(shown.path), text(shown.version)].filter(Boolean)
  return source.length > 0
    ? t('evidence.drawer.pluginSource', { entry, source: source.join(' ') })
    : t('evidence.drawer.plugin', { entry })
}

export interface SessionLink {
  href: string
  label: string
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
  return { href: url.href, label: t('evidence.drawer.sessionPage'), target: '_blank', rel: 'noopener noreferrer' }
}

export const RUN_ARTIFACT_KIND_LABELS = textTable({
  test: () => t('evidence.drawer.kind.test'),
  unknown: () => t('evidence.drawer.kind.unknown'),
}) satisfies Record<RunArtifactKind, string>

export type CaptureState = 'sealed' | 'unsealed'
export const CAPTURE_STATES = ['sealed', 'unsealed'] as const satisfies readonly CaptureState[]

export function captureStateOf(artifact: { finalizedAt?: string | null }): CaptureState {
  return artifact.finalizedAt ? 'sealed' : 'unsealed'
}

export function DRAWER_TITLE_FALLBACK(id: string): string {
  return t('evidence.drawer.titleFallback', { id })
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
