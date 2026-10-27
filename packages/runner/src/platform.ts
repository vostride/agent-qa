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

export interface ObserveOptions {
  extractDom?: boolean
}

// D-15 (Phase 360): the runner's action world IS the schema `ActionsFor<P>` projection. The
// legacy runner-owned action union and its folded/runtime-only verb groups plus the local shape
// declarations were demolished here — `Extract` keyed on the `type` string only, so the legacy
// member shapes silently won over the schema shapes (RESEARCH §Type-Level Flip). The
// planner-reachable surface is now the single schema truth; adapters read schema execution shapes.
//
// `RunnerRuntimeVerbs` is a documented named alias re-exporting the three author-channel verbs that
// already exist as schema members — NOT new union members. It marks the surviving runner-runtime
// surface so a future reader knows these three are runtime-owned, not planner catalog verbs:
//   - executeScript → Phase 363 author-facing variable resolution + lifecycle-hook plumbing
//   - setVariable   → Phase 363 author-facing variable resolution + lifecycle-hook plumbing
//   - stopApp       → author channel (test lifecycle app teardown)
export type RunnerRuntimeVerbs =
  | Extract<SchemaAction, { type: 'executeScript' }>
  | Extract<SchemaAction, { type: 'setVariable' }>
  | Extract<SchemaAction, { type: 'stopApp' }>

// The runner action world = the schema union (D-15). Re-exported under the runner's historical
// `Action` name so the ~40 runner-internal structural consumers keep importing from `./platform.js`.
export type Action = SchemaAction

// Platform-projected action surface = the schema projection verbatim (D-15). `desiredState` on
// click/tap is now schema-owned (Plan 03), so no runner-side intersection widening is needed.
export type ActionsFor<P extends Platform = Platform> = SchemaActionsFor<P>

/**
 * An adapter's LIVE STREAM capability (403 D-05). The adapter owns the producer (a CDP screencast,
 * an MJPEG broadcaster, a WebRTC track, or a snapshot producer over a capture that is safe to run
 * beside a step); the runner owns nothing but this object, so no `Page` and no session handle ever
 * leaves the adapter. Lifecycle is lazy and refcounted by the run's {@link LiveStreamHub}: `start`
 * on the first viewer, `ack` per consumed frame (the producer's flow control), `stop` on the
 * last — idempotent, so a double stop is a no-op rather than a throw.
 *
 * The labelled 1s snapshot producer (`createSnapshotLiveStream`) sits behind this same contract
 * (428 D-11): the composition registers it as the whole preview when an adapter has no continuous
 * stream, and as the fallback the hub starts when a continuous stream fails to start (D-12).
 */
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

/**
 * 2026-10-08 (436-15, D-19): what the loop hands one dispatch. `remainingStepMs` is set only when
 * a step deadline is armed; adapters that run no post-action wait ignore both.
 */
export interface ExecuteOptions {
  remainingStepMs?: number
  abortSignal?: AbortSignal
}

export interface PlatformAdapter<P extends Platform = Platform> {
  readonly platform: P

  setup(config: PlatformConfig): Promise<void>
  cleanup(): Promise<void>
  observe(options?: ObserveOptions): Promise<ScreenState>
  execute(action: ActionsFor<P>, options?: ExecuteOptions): Promise<ActionResult>
  screenshot?(): Promise<Buffer | undefined>
  /**
   * 403 D-05: the optional live-stream producer for this adapter's current target. ABSENT means
   * "no continuous stream" (non-Chromium, remote farm), not "no preview": the composition's
   * `liveStreamFor` wraps `screenshot()` in the labelled 1s snapshot producer instead, and uses
   * that producer as the fallback when a continuous stream fails to start (428 D-11/D-12). Only an
   * adapter with neither reads `{ kind: 'none' }`. An adapter whose `screenshot()` mutates shared
   * state (the mobile adapters switch the Appium context) must expose its own snapshot
   * `liveStream` over a side-effect-free capture instead, so `screenshot()` is never wrapped.
   */
  readonly liveStream?: LiveStreamCapability
  readonly recording?: RecordingCapability
  /**
   * 436 D-23: which operation-specific captures this adapter runs. ABSENT means none; the loop
   * then records both as unavailable, with `reason` or else 'platform'.
   */
  readonly operationCaptureSupport?: OperationCaptureSupport
  drainConsoleLogs?(level?: string): ConsoleLogEntry[]
  drainNetworkLogs?(urlPattern?: string): NetworkLogEntry[]
  /** 439 D-14: the undrained network log, read without consuming it; the step-end drain still sees it. */
  peekNetworkLogs?(urlPattern?: string): NetworkLogEntry[]
  /**
   * 439 D-04: the bytes of a completed download with this sha256, held in memory and bounded by
   * the adapter; undefined when the adapter holds none (over its cap, evicted, or disposed).
   */
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
