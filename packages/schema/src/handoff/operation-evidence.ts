// No downloaded byte, file path or text preview is ever part of these DTOs.

export interface DownloadEvidence {
  suggestedFilename: string
  /** The filename's extension including the dot, or '' when it has none. */
  extension: string
  /** Byte count of the completed file. */
  size?: number
  /** Lower-case hex sha-256 of the completed file's bytes. */
  sha256?: string
  /** Only 'completed' is evidence that the download happened; the rest never are. */
  state: 'completed' | 'failed' | 'canceled' | 'unfinished'
  /** The browser's failure text for 'failed' and 'canceled'. */
  failure?: string
  /** Started after the capture window of the action before it closed; no action is credited with starting it. */
  late?: true
}

export interface ClipboardEvidence {
  source: 'writeText' | 'write' | 'copy-event'
  text: string
  truncated: boolean
  readBack: 'matched' | 'mismatched' | 'unavailable'
}

export type FillVerdict = 'exact' | 'normalized' | 'mismatch' | 'unverified'

export type InputPath = 'native' | 'webview' | 'keyboard'

export type SubmitOutcome = 'sent' | 'not-sent' | 'unavailable' | 'failed'

export type SubmitReason = 'mismatch' | 'multi-line-field' | 'input-failed' | 'focus-lost'

// `currentState` is masked before it is recorded.
export interface InputEvidence {
  verb: string
  inputSent: boolean
  currentState?: string
  fillVerdict?: FillVerdict
  inputPath?: InputPath
  secure?: true
  submit?: SubmitOutcome
  submitReason?: SubmitReason
  unavailableReason?: string
}

export interface OperationEvidence {
  downloads?: DownloadEvidence[]
  clipboard?: ClipboardEvidence[]
  input?: InputEvidence[]
}

export interface OperationCaptureAvailability {
  download: 'available' | 'unavailable'
  clipboard: 'available' | 'unavailable'
  reason?: string
}

export const DOWNLOAD_EVIDENCE_KEYS = [
  'suggestedFilename',
  'extension',
  'size',
  'sha256',
  'state',
  'failure',
  'late',
] as const satisfies readonly (keyof DownloadEvidence)[]

export const CLIPBOARD_EVIDENCE_KEYS = [
  'source',
  'text',
  'truncated',
  'readBack',
] as const satisfies readonly (keyof ClipboardEvidence)[]

export const INPUT_EVIDENCE_KEYS = [
  'verb',
  'inputSent',
  'currentState',
  'fillVerdict',
  'inputPath',
  'secure',
  'submit',
  'submitReason',
  'unavailableReason',
] as const satisfies readonly (keyof InputEvidence)[]

export const OPERATION_CAPTURE_AVAILABILITY_KEYS = [
  'download',
  'clipboard',
  'reason',
] as const satisfies readonly (keyof OperationCaptureAvailability)[]
