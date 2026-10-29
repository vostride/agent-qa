import { randomUUID } from 'node:crypto'
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'

import type {
  ReadWriterLeaseOutcome,
  WriterLease,
  WriterLeaseFreshness,
} from '@vostride/agent-qa-agent-local'
import { LOCAL_DAEMON_CAPABILITIES } from '@vostride/agent-qa-agent-local'
import { z } from 'zod'

import { fetchDaemonIdentity } from './server.js'
import type { DaemonIdentity } from './server.js'

export const DAEMON_REGISTRATION_FILE = 'daemon.json'
export const DAEMON_REGISTRATION_SCHEMA_VERSION = 2

/** Pinned identity-probe bound; retune from daemon evidence without adding config. */
export const DAEMON_IDENTITY_HANDSHAKE_TIMEOUT_MS = 1_000

export const daemonRegistrationSchema = z
  .object({
    schemaVersion: z.literal(DAEMON_REGISTRATION_SCHEMA_VERSION),
    instanceId: z.string().uuid(),
    pid: z.number().int().positive(),
    socketPath: z.string().min(1),
    startedAtMs: z.number().int().nonnegative(),
  })
  .strict()

export type DaemonRegistration = z.infer<typeof daemonRegistrationSchema>

export type ReadDaemonRegistrationOutcome =
  | { kind: 'absent' }
  | { kind: 'malformed' }
  | { kind: 'parsed'; registration: DaemonRegistration }

export type InspectDaemonRegistrationOutcome =
  | { kind: 'absent' }
  | { kind: 'malformed' }
  | { kind: 'live'; registration: DaemonRegistration }
  | { kind: 'stale'; registration: DaemonRegistration }

export type ClassifyDaemonRegistrationOutcome =
  | { kind: 'absent' }
  | { kind: 'malformed' }
  | { kind: 'live-confirmed'; registration: DaemonRegistration }
  | {
      kind: 'unreachable-lease-fresh'
      registration: DaemonRegistration
      // Absent exactly when the lease bytes could not be read, so no surface prints an unseen pid.
      holder?: WriterLease
      /** Always present, so a refusal can name the errno that produced it. */
      lease: ReadWriterLeaseOutcome
      identityFailure: 'mismatch' | 'timeout' | 'unreachable'
    }
  | {
      kind: 'unreachable-lease-stale'
      registration: DaemonRegistration
      lease: ReadWriterLeaseOutcome
      identityFailure: 'mismatch' | 'timeout' | 'unreachable'
    }

export interface DaemonRegistrationClassificationOperations {
  fetchIdentity(registration: DaemonRegistration): Promise<DaemonIdentity>
  readWriterLease(knowledgeRoot: string): ReadWriterLeaseOutcome
  /**
   * The three-valued freshness verdict, never the lease file alone.
   *
   * Recoverability is not a boolean: the epoch a holder is judged against can be unreadable, and
   * that is a different fact from an expired lease. This classifier drives registration deletion
   * and socket unlink, so it names the third value explicitly below rather than letting it
   * collapse into whichever boolean happened to be convenient.
   */
  deriveWriterLeaseFreshness(
    knowledgeRoot: string,
    lease: WriterLease,
    nowMs: number,
  ): WriterLeaseFreshness
  now(): number
  setTimeout(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>
  clearTimeout(timer: ReturnType<typeof setTimeout>): void
}

export interface ClassifyDaemonRegistrationInput {
  readonly agentQaRoot: string
  readonly knowledgeRoot: string
  /** Focused test seam. Production callers omit it. */
  readonly operations?: Partial<DaemonRegistrationClassificationOperations>
}

export type ProcessIsAlive = (pid: number) => boolean

/** Legacy project-local default used by status fixtures; live hosts record the server's actual path. */
export function daemonRegistrationSocketPath(agentQaRoot: string): string {
  return join(agentQaRoot, 'daemon.sock')
}

export function daemonRegistrationPath(agentQaRoot: string): string {
  return join(agentQaRoot, DAEMON_REGISTRATION_FILE)
}

function bestEffortFsyncDirectory(dir: string): void {
  let fd: number | undefined
  try {
    fd = openSync(dir, 'r')
    fsyncSync(fd)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (
      code !== 'ENOENT' &&
      code !== 'EINVAL' &&
      code !== 'EISDIR' &&
      code !== 'EPERM' &&
      code !== 'ENOTSUP'
    ) {
      throw error
    }
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

function atomicRewrite(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true })
  const temporary = `${file}.tmp-${randomUUID()}`
  let fd: number | undefined
  try {
    fd = openSync(temporary, 'wx', 0o600)
    writeFileSync(fd, text, 'utf8')
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined
    renameSync(temporary, file)
    bestEffortFsyncDirectory(dirname(file))
  } finally {
    if (fd !== undefined) closeSync(fd)
    rmSync(temporary, { force: true })
  }
}

export function writeDaemonRegistration(
  agentQaRoot: string,
  registration: DaemonRegistration,
): void {
  const validated = daemonRegistrationSchema.parse(registration)
  atomicRewrite(daemonRegistrationPath(agentQaRoot), `${JSON.stringify(validated)}\n`)
}

function readDaemonRegistrationFile(file: string): ReadDaemonRegistrationOutcome {
  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch {
    return existsSync(file) ? { kind: 'malformed' } : { kind: 'absent' }
  }

  try {
    const parsedJson = JSON.parse(raw) as unknown
    const parsed = daemonRegistrationSchema.safeParse(parsedJson)
    return parsed.success
      ? { kind: 'parsed', registration: parsed.data }
      : { kind: 'malformed' }
  } catch {
    return { kind: 'malformed' }
  }
}

export function readDaemonRegistration(agentQaRoot: string): ReadDaemonRegistrationOutcome {
  return readDaemonRegistrationFile(daemonRegistrationPath(agentQaRoot))
}

/** Signal-zero liveness probe: EPERM proves existence; only ESRCH proves a stale pid. */
export function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ESRCH') return false
    if (code === 'EPERM') return true
    throw error
  }
}

/**
 * Read-only pid-liveness view, kept for status reporting and test observation only.
 *
 * A `live` verdict here is signal-zero alone, which is not daemon authority: use
 * `classifyDaemonRegistration` anywhere the answer selects a removal, a delegation, or a
 * lease.
 */
export function inspectDaemonRegistration(
  agentQaRoot: string,
  isAlive: ProcessIsAlive = processIsAlive,
): InspectDaemonRegistrationOutcome {
  const outcome = readDaemonRegistration(agentQaRoot)
  if (outcome.kind !== 'parsed') return outcome
  return isAlive(outcome.registration.pid)
    ? { kind: 'live', registration: outcome.registration }
    : { kind: 'stale', registration: outcome.registration }
}

class DaemonIdentityHandshakeTimeoutError extends Error {
  constructor() {
    super(`Daemon identity handshake exceeded ${DAEMON_IDENTITY_HANDSHAKE_TIMEOUT_MS}ms`)
    this.name = 'DaemonIdentityHandshakeTimeoutError'
  }
}

const DEFAULT_CLASSIFICATION_OPERATIONS: DaemonRegistrationClassificationOperations = {
  fetchIdentity: (registration) => fetchDaemonIdentity(registration.socketPath),
  readWriterLease: LOCAL_DAEMON_CAPABILITIES.readWriterLease,
  deriveWriterLeaseFreshness: LOCAL_DAEMON_CAPABILITIES.deriveWriterLeaseFreshness,
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (timer) => clearTimeout(timer),
}

async function fetchIdentityWithinBound(
  registration: DaemonRegistration,
  operations: DaemonRegistrationClassificationOperations,
): Promise<DaemonIdentity> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      operations.fetchIdentity(registration),
      new Promise<never>((_resolve, reject) => {
        timeout = operations.setTimeout(
          () => reject(new DaemonIdentityHandshakeTimeoutError()),
          DAEMON_IDENTITY_HANDSHAKE_TIMEOUT_MS,
        )
        timeout.unref?.()
      }),
    ])
  } finally {
    if (timeout !== undefined) operations.clearTimeout(timeout)
  }
}

/**
 * Classify daemon authority from its nonce-authenticated socket identity and current writer lease.
 *
 * PID signal-zero is deliberately absent: an alive, stopped, or reused PID is not daemon proof.
 */
export async function classifyDaemonRegistration(
  input: ClassifyDaemonRegistrationInput,
): Promise<ClassifyDaemonRegistrationOutcome> {
  const outcome = readDaemonRegistration(input.agentQaRoot)
  if (outcome.kind !== 'parsed') return outcome

  const operations = {
    ...DEFAULT_CLASSIFICATION_OPERATIONS,
    ...input.operations,
  }
  let identityFailure: 'mismatch' | 'timeout' | 'unreachable'
  try {
    const identity = await fetchIdentityWithinBound(outcome.registration, operations)
    if (
      identity.instanceId === outcome.registration.instanceId
      && identity.pid === outcome.registration.pid
    ) {
      return { kind: 'live-confirmed', registration: outcome.registration }
    }
    identityFailure = 'mismatch'
  } catch (error) {
    identityFailure = error instanceof DaemonIdentityHandshakeTimeoutError
      ? 'timeout'
      : 'unreachable'
  }

  const lease = operations.readWriterLease(input.knowledgeRoot)
  const staleOutcome: ClassifyDaemonRegistrationOutcome = {
    kind: 'unreachable-lease-stale',
    registration: outcome.registration,
    lease,
    identityFailure,
  }
  /**
   * All four read kinds by name, with no bare non-parsed short-circuit above the verdict.
   *
   * The line this replaced was `if (lease.kind !== 'parsed') return staleOutcome`, and it made the
   * carefully-argued `unknown` arm below unreachable for the one input class the argument was
   * about: a `.lease` that exists and could not be opened. Round 5 reproduced the consequence —
   * `runDaemonHost` executes `unreachable-lease-stale` as `removeClassifiedRegistration` plus
   * socket unlink, so a live daemon lost its registration and its address while it kept running
   * and kept holding the lease. `absent` and `malformed` keep answering stale because a missing
   * file, and bytes that were read and are not a lease, are both genuine recovery input.
   *
   * No `default`, and the function has no trailing return: a fifth read kind cannot inherit the
   * takeover direction without someone choosing it.
   */
  switch (lease.kind) {
    case 'absent':
    case 'malformed':
      return staleOutcome
    /**
     * The sibling of the `unknown` arm below, and the same argument.
     *
     * An unreadable `.lease` and an unreadable `.epoch` are the same evidence class — EACCES, EIO,
     * EMFILE — read by the same classifier on the same call path guarding the same authority. Both
     * mean "I could not read the authority state", which is never "nobody holds it".
     */
    case 'unreadable':
      return {
        kind: 'unreachable-lease-fresh',
        registration: outcome.registration,
        lease,
        identityFailure,
      }
    case 'parsed': {
      const verdict = operations.deriveWriterLeaseFreshness(
        input.knowledgeRoot,
        lease.lease,
        operations.now(),
      )
      switch (verdict.kind) {
        case 'fresh':
        // `unknown` answers held: fd exhaustion fails both checks at once, so unknown is not free.
        case 'unknown':
          return {
            kind: 'unreachable-lease-fresh',
            registration: outcome.registration,
            holder: lease.lease,
            lease,
            identityFailure,
          }
        case 'reclaimable':
          return staleOutcome
      }
    }
  }
}

export interface RemoveRegistrationIfOwnedOptions {
  /** Test-only barrier immediately before the atomic quarantine rename. */
  readonly beforeQuarantineRename?: () => void
  /** Test-only barrier after quarantine publication and before ownership verification. */
  readonly afterQuarantine?: (quarantinePath: string) => void
  /** Test-only barrier after re-verification and before the unlink or the restore. */
  readonly afterVerify?: (quarantinePath: string) => void
  /** Focused durability seam; production uses the best-effort platform fsync helper. */
  readonly fsyncDirectory?: (directory: string) => void
}

/**
 * What a removal attempt did, rather than merely whether it succeeded.
 *
 * `unmatched` and `changed-under-removal` are both "did not remove", but only one of them leaves
 * bytes parked under a name nobody routinely reads. Collapsing them into `false` is how a
 * stranded registration becomes invisible, so the difference is in the type.
 */
export type RemoveRegistrationOutcome =
  | { readonly kind: 'removed' }
  | { readonly kind: 'unmatched' }
  | {
    readonly kind: 'changed-under-removal'
    readonly registrationPath: string
    readonly quarantinePath: string
  }

/** A quarantined registration that could not be put back, naming both paths involved. */
export class DaemonRegistrationRestoreError extends Error {
  readonly registrationPath: string
  readonly quarantinePath: string

  constructor(registrationPath: string, quarantinePath: string, cause: unknown) {
    super(
      `agent-qa daemon registration could not be restored from ${quarantinePath} `
      + `to ${registrationPath}: ${cause instanceof Error ? cause.message : String(cause)}`,
    )
    this.name = 'DaemonRegistrationRestoreError'
    this.registrationPath = registrationPath
    this.quarantinePath = quarantinePath
    this.cause = cause
  }
}

// Compare, then quarantine, re-verify and remove; restore by rename, ceding to a present successor.
function removeRegistrationIfMatching(
  agentQaRoot: string,
  tag: string,
  matches: (outcome: ReadDaemonRegistrationOutcome) => boolean,
  options: RemoveRegistrationIfOwnedOptions,
): RemoveRegistrationOutcome {
  const file = daemonRegistrationPath(agentQaRoot)
  const parent = dirname(file)
  const quarantine = `${file}.remove-${tag}-${randomUUID()}`
  const fsyncDirectory = options.fsyncDirectory ?? bestEffortFsyncDirectory

  if (!matches(readDaemonRegistrationFile(file))) return { kind: 'unmatched' }

  options.beforeQuarantineRename?.()
  try {
    renameSync(file, quarantine)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'unmatched' }
    throw error
  }
  fsyncDirectory(parent)
  options.afterQuarantine?.(quarantine)

  const verified = matches(readDaemonRegistrationFile(quarantine))
  options.afterVerify?.(quarantine)
  if (verified) {
    unlinkSync(quarantine)
    fsyncDirectory(parent)
    return { kind: 'removed' }
  }

  if (existsSync(file)) {
    return { kind: 'changed-under-removal', registrationPath: file, quarantinePath: quarantine }
  }
  try {
    renameSync(quarantine, file)
  } catch (error) {
    throw new DaemonRegistrationRestoreError(file, quarantine, error)
  }
  fsyncDirectory(parent)
  return { kind: 'unmatched' }
}

export function removeRegistrationIfOwned(
  agentQaRoot: string,
  instanceId: string,
  options: RemoveRegistrationIfOwnedOptions = {},
): RemoveRegistrationOutcome {
  return removeRegistrationIfMatching(
    agentQaRoot,
    instanceId,
    (outcome) => outcome.kind === 'parsed' && outcome.registration.instanceId === instanceId,
    options,
  )
}
