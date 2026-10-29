// Platform-agnostic types for the PlatformAdapter contract.
// CRITICAL: No imports from playwright-core, webdriverio, or any platform package.

import type {
  Action as SchemaAction,
  ActionsFor as SchemaActionsFor,
  LiveFrame,
  LiveStreamKind,
  Platform,
  RecordingContentType,
  RecordingAnnotationWitness,
  ScreenState,
} from '@vostride/agent-qa-schema'
import type { ConsoleLogEntry, NetworkLogEntry } from './result.js'

// Runtime-owned schema action members outside the planner catalog; they add no union members.
export type RunnerRuntimeVerbs =
  | Extract<SchemaAction, { type: 'executeScript' }>
  | Extract<SchemaAction, { type: 'setVariable' }>
  | Extract<SchemaAction, { type: 'stopApp' }>

// The schema union under the runner's `Action` name, for runner-internal consumers.
export type Action = SchemaAction

export type ActionsFor<P extends Platform = Platform> = SchemaActionsFor<P>

// No `Page` or session handle leaves the adapter; `stop` is idempotent.
export interface LiveStreamCapability {
  readonly kind: LiveStreamKind
  start(onFrame: (frame: LiveFrame) => void): Promise<void>
  ack(frameId: number): Promise<void>
  stop(): Promise<void>
}

export interface RecordingStart {
  zeroMs?: number
}

export interface RecordingStop {
  stagingPath: string
  contentType: RecordingContentType
}

export interface RecordingCapability {
  start(): Promise<RecordingStart>
  stop(): Promise<RecordingStop | undefined>
  /** Bracket one actual execution; completion withholds unsupported or changed scenes. */
  beginAnnotation?(): (() => RecordingAnnotationWitness | undefined) | undefined
}

export interface OperationCaptureSupport {
  download: boolean
  clipboard: boolean
  /** Why a capture is unsupported, e.g. the browser name. */
  reason?: string
}

// `remainingStepMs` is set only when a step deadline is armed.
export interface ExecuteOptions {
  remainingStepMs?: number
  abortSignal?: AbortSignal
}

export interface PlatformAdapter<P extends Platform = Platform> {
  readonly platform: P

  setup(config: PlatformConfig): Promise<void>
  cleanup(): Promise<void>
  observe(): Promise<ScreenState>
  execute(action: ActionsFor<P>, options?: ExecuteOptions): Promise<ActionResult>
  screenshot?(): Promise<Buffer | undefined>
  // Absent means no continuous stream; an adapter whose `screenshot()` mutates state has its own.
  readonly liveStream?: LiveStreamCapability
  readonly recording?: RecordingCapability
  // Absent means none; the loop then records both as unavailable.
  readonly operationCaptureSupport?: OperationCaptureSupport
  drainConsoleLogs?(level?: string): ConsoleLogEntry[]
  drainNetworkLogs?(urlPattern?: string): NetworkLogEntry[]
  // Reads the undrained network log without consuming it; the step-end drain still sees it.
  peekNetworkLogs?(urlPattern?: string): NetworkLogEntry[]
  // Held, bounded download bytes; undefined when over the cap, evicted or disposed.
  readDownloadBytes?(sha256: string): Uint8Array | undefined
}

export function assertNever(value: never): never {
  const type = (value as { type?: string }).type
  throw new Error(`Unhandled action type: ${type ?? String(value)}`)
}

export interface ActionResult {
  recordingAnnotation?: RecordingAnnotationWitness
  success: boolean
  error?: string
  screenshot?: Buffer
  metadata?: Record<string, unknown>
  coordinates?: { x: number; y: number }
  boundingBox?: { x: number; y: number; width: number; height: number }
  startCoordinates?: { x: number; y: number }
  endCoordinates?: { x: number; y: number }
  data?: unknown
}

export interface RuntimeAuthStateConfig {
  version: number
  kind: 'web'
  targetName: string
  stateName: string
  capturedAt: string
  storageStatePath: string
}

export interface PlatformConfig {
  platform: 'web' | 'android' | 'ios'
  browser?: BrowserConfig
  device?: DeviceConfig
  bundleId?: string
  appPackage?: string
  appActivity?: string
  deepLinkAppId?: string
  appState?: 'preserve' | 'reset'
  appPath?: string
  appiumUrl?: string
  timeouts?: TimeoutConfig
  recording?: { enabled: boolean; videoDir: string; videoSize?: { width: number; height: number } }
  verbose?: boolean
  logCapture?: { console?: boolean; network?: boolean }
  authState?: RuntimeAuthStateConfig
}

export interface BrowserConfig {
  name: 'chromium' | 'firefox' | 'webkit'
  headless?: boolean
  viewport?: { width: number; height: number }
}

export interface DeviceConfig {
  name: string
  platform: 'android' | 'ios'
  match: Record<string, unknown>
}

export interface TimeoutConfig {
  step?: number
  test?: number
  navigation?: number
}
