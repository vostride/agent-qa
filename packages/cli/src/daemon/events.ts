import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'

export const DAEMON_EVENTS_FILE = 'daemon-events.jsonl'

/**
 * The closed set of lifecycle facts the daemon may record.
 *
 * The array is the single source of the union so the reader can recognise a persisted kind at
 * runtime without a second, driftable list.
 */
export const DAEMON_EVENT_KINDS = [
  'lease-acquired',
  'lease-reclaimed',
  'lease-heartbeated',
  'lease-lost',
  'epoch-bump',
  'registration-recovered',
  'job-claimed',
  'job-completed',
  'drain-session-start',
  'drain-session-end',
  'embedder-worker-start',
  'embedder-worker-exit',
  'embedder-worker-terminate-escalated',
  // The run's completion (`runId` and `outcome`); the daemon runs it in-process, no child exit.
  'run-completed',
  'shutdown-stage-failed',
  'daemon-stopped',
] as const

export type DaemonEventKind = typeof DAEMON_EVENT_KINDS[number]

const DAEMON_EVENT_KIND_SET: ReadonlySet<string> = new Set(DAEMON_EVENT_KINDS)

/** A lifecycle fact. Kinds are closed while later plans may add kind-specific scalar fields. */
export type DaemonEvent = Readonly<{ kind: DaemonEventKind } & Record<string, unknown>>

export interface AppendDaemonEventOptions {
  // Seams so a test observes both fsyncs without simulating a crash.
  readonly fsyncFile?: (descriptor: number) => void
  readonly fsyncDirectory?: (directory: string) => void
}

export type DaemonEventReadWarningKind = 'torn-final-line' | 'malformed-row'

export interface DaemonEventReadWarning {
  readonly kind: DaemonEventReadWarningKind
  readonly line: number
  readonly message: string
}

export interface DaemonEventLedger {
  readonly events: DaemonEvent[]
  readonly warnings: DaemonEventReadWarning[]
}

/** Best-effort directory durability; a platform that cannot fsync a directory is not an error. */
function bestEffortFsyncDirectory(directory: string): void {
  let descriptor: number | undefined
  try {
    descriptor = openSync(directory, 'r')
    fsyncSync(descriptor)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (
      code !== 'ENOENT'
      && code !== 'EINVAL'
      && code !== 'EISDIR'
      && code !== 'EPERM'
      && code !== 'ENOTSUP'
    ) {
      throw error
    }
  } finally {
    if (descriptor !== undefined) closeSync(descriptor)
  }
}

// `ts` leads each record; records are fsynced, and the creating append fsyncs the parent too.
export function appendDaemonEvent(
  agentQaRoot: string,
  event: DaemonEvent,
  now: () => Date = () => new Date(),
  options: AppendDaemonEventOptions = {},
): void {
  mkdirSync(agentQaRoot, { recursive: true, mode: 0o700 })
  const file = join(agentQaRoot, DAEMON_EVENTS_FILE)
  const created = !existsSync(file)
  const fsyncFile = options.fsyncFile ?? fsyncSync
  const descriptor = openSync(file, 'a', 0o600)
  try {
    writeFileSync(descriptor, `${JSON.stringify({ ts: now().toISOString(), ...event })}\n`, 'utf8')
    fsyncFile(descriptor)
  } finally {
    closeSync(descriptor)
  }
  if (created) (options.fsyncDirectory ?? bestEffortFsyncDirectory)(agentQaRoot)
}

/**
 * Read append order while isolating exactly one interrupted final append.
 *
 * The distinction the callers need is between a crash and a bad record. Only an unterminated final
 * line can be a tear; anything else — including a row that is syntactically complete but not a
 * lifecycle fact this build recognises — is reported as a malformed row and skipped, so one bad
 * record can never truncate the post-mortem evidence that follows it.
 */
export function readDaemonEventLedger(agentQaRoot: string): DaemonEventLedger {
  let raw: string
  try {
    raw = readFileSync(join(agentQaRoot, DAEMON_EVENTS_FILE), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { events: [], warnings: [] }
    }
    throw error
  }

  const lines = raw.split('\n')
  const events: DaemonEvent[] = []
  const warnings: DaemonEventReadWarning[] = []
  for (const [index, line] of lines.entries()) {
    if (line.length === 0) continue
    const lineNumber = index + 1
    let parsed: unknown
    try {
      parsed = JSON.parse(line) as unknown
    } catch {
      if (index === lines.length - 1 && !raw.endsWith('\n')) {
        warnings.push({
          kind: 'torn-final-line',
          line: lineNumber,
          message: `Ignored torn final daemon event at line ${lineNumber}`,
        })
        break
      }
      warnings.push({
        kind: 'malformed-row',
        line: lineNumber,
        message: `Ignored unparseable daemon event at line ${lineNumber}`,
      })
      continue
    }
    if (
      typeof parsed !== 'object'
      || parsed === null
      || Array.isArray(parsed)
      || !DAEMON_EVENT_KIND_SET.has((parsed as { kind?: unknown }).kind as string)
    ) {
      warnings.push({
        kind: 'malformed-row',
        line: lineNumber,
        message: `Ignored daemon event with an unrecognised shape at line ${lineNumber}`,
      })
      continue
    }
    events.push(parsed as DaemonEvent)
  }
  return { events, warnings }
}
