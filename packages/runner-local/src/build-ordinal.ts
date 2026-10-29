// Concrete per-product buildOrdinal counter.
//
// A storageImplementation home for node:fs + node:path (the FsActionCache / FsStorageStateStore
// boundary) — this project-local counter fs write lives here, never in the runner. On-disk layout:
//
//   <root>/build-ordinals.json   ({ [product]: number })
//
// D-18 derivation (spec/v2/eval-and-core-types.md §A8): buildOrdinal is a per-product run counter
// incremented at run start. The complete read/validate/increment/replace unit is serialized across
// processes and durably replaced, so run starts and maintenance reservations share one monotonic
// authority without lost updates or fixed-temp collisions.

import { randomUUID } from 'node:crypto'
import {
  closeSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'

/** The project-local state file holding the per-product ordinal map. */
export const BUILD_ORDINALS_FILE = 'build-ordinals.json'

export interface NextBuildOrdinalOptions {
  /** Runtime root (e.g. DEFAULT_AGENT_QA_DIR = '.agent-qa'). */
  root: string
  /** The product whose counter to advance. */
  product: string
}

export interface BuildOrdinalReservation {
  /** Canonical, sorted, duplicate-free product axes advanced by the reservation. */
  products: readonly string[]
  /** One ordinal strictly later than every affected product's current counter. */
  ordinal: number
}

export type BuildOrdinalReservationErrorCode =
  | 'invalid-state'
  | 'missing-counter'
  | 'invalid-counter'
  | 'counter-exhausted'

/** Typed pre-persistence refusal for an unsafe maintenance ordinal reservation. */
export class BuildOrdinalReservationError extends Error {
  readonly name = 'BuildOrdinalReservationError'
  readonly code: BuildOrdinalReservationErrorCode
  readonly product: string
  readonly value?: unknown

  constructor(
    code: BuildOrdinalReservationErrorCode,
    product: string,
    value?: unknown,
  ) {
    const message =
      code === 'invalid-state'
        ? `${BUILD_ORDINALS_FILE} must contain a JSON object`
        : code === 'missing-counter'
          ? `Missing build ordinal counter for product ${JSON.stringify(product)}`
          : code === 'invalid-counter'
            ? `Build ordinal counter for product ${JSON.stringify(product)} must be a non-negative safe integer`
            : `Build ordinal counter for product ${JSON.stringify(product)} is exhausted`
    super(message)
    this.code = code
    this.product = product
    this.value = value
  }
}

export interface ReserveBuildOrdinalForProductsOptions {
  /** Runtime root containing build-ordinals.json. */
  root: string
  /** Product axes whose counters must advance together. Duplicates and order are ignored. */
  products: Iterable<string>
  /**
   * Synchronous authority fence invoked after the complete temp file is prepared and immediately
   * before the atomic rename. Throwing refuses persistence and removes the temp file.
   */
  beforePersist?: (reservation: BuildOrdinalReservation) => void
}

/** Undefined is the explicit no-op result for an empty affected-product set. */
export type ReserveBuildOrdinalForProductsResult = number | undefined

interface CounterLockOwner {
  pid: number
  token: string
}

const BUILD_ORDINALS_LOCK_FILE = '.build-ordinals.lock'
const COUNTER_LOCK_POLL_MS = 5
const COUNTER_LOCK_WAIT = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT))

function fsyncDirectory(dir: string): void {
  let fd: number | undefined
  try {
    fd = openSync(dir, 'r')
    fsyncSync(fd)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'EINVAL' && code !== 'EISDIR' && code !== 'EPERM' && code !== 'ENOTSUP') {
      throw error
    }
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

function durableExclusiveFile(file: string, text: string): void {
  const fd = openSync(file, 'wx')
  try {
    writeFileSync(fd, text, 'utf8')
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

function parsedLockOwner(file: string): CounterLockOwner | undefined {
  try {
    const value = JSON.parse(readFileSync(file, 'utf8')) as unknown
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
    const owner = value as Record<string, unknown>
    return typeof owner.pid === 'number'
      && Number.isSafeInteger(owner.pid)
      && owner.pid > 0
      && typeof owner.token === 'string'
      && owner.token !== ''
      ? { pid: owner.pid, token: owner.token }
      : undefined
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

function processIsAlive(pid: number): boolean {
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

function withCounterLock<T>(root: string, operation: () => T): T {
  mkdirSync(root, { recursive: true })
  const lock = join(root, BUILD_ORDINALS_LOCK_FILE)
  const owner: CounterLockOwner = { pid: process.pid, token: randomUUID() }
  const ownerFile = `${lock}.owner-${owner.token}`
  durableExclusiveFile(ownerFile, `${JSON.stringify(owner)}\n`)

  let acquired = false
  try {
    while (!acquired) {
      try {
        // Linking a complete, fsynced owner document makes lock acquisition atomic. A crash
        // before this point leaves only a uniquely named non-authoritative candidate file.
        linkSync(ownerFile, lock)
        fsyncDirectory(root)
        acquired = true
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        const current = parsedLockOwner(lock)
        if (current !== undefined && !processIsAlive(current.pid)) {
          // A dead PID is the only stale-lock recovery authority. The unique quarantine name
          // prevents one recovery attempt from recursively deleting another owner's lock bytes.
          const quarantine = `${lock}.dead-${current.token}-${randomUUID()}`
          try {
            renameSync(lock, quarantine)
            fsyncDirectory(root)
            rmSync(quarantine, { force: true })
            fsyncDirectory(root)
            continue
          } catch (recoveryError) {
            if ((recoveryError as NodeJS.ErrnoException).code === 'ENOENT') continue
            throw recoveryError
          }
        }
        Atomics.wait(COUNTER_LOCK_WAIT, 0, 0, COUNTER_LOCK_POLL_MS)
      }
    }

    return operation()
  } finally {
    if (acquired && parsedLockOwner(lock)?.token === owner.token) {
      rmSync(lock, { force: true })
      fsyncDirectory(root)
    }
    rmSync(ownerFile, { force: true })
  }
}

function persistOrdinals(
  file: string,
  map: Readonly<Record<string, number>>,
  beforePersist?: () => void,
): void {
  const temporary = `${file}.tmp-${randomUUID()}`
  let fd: number | undefined
  try {
    fd = openSync(temporary, 'wx')
    writeFileSync(fd, `${JSON.stringify(map)}\n`, 'utf8')
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined
    beforePersist?.()
    renameSync(temporary, file)
    fsyncDirectory(dirname(file))
  } finally {
    if (fd !== undefined) closeSync(fd)
    rmSync(temporary, { force: true })
  }
}

export async function nextBuildOrdinal(opts: NextBuildOrdinalOptions): Promise<number> {
  return withCounterLock(opts.root, () => {
    const file = join(opts.root, BUILD_ORDINALS_FILE)
    const map = readOrdinals(file, opts.product, true)
    const current = Object.hasOwn(map, opts.product) ? map[opts.product]! : 0
    if (current === Number.MAX_SAFE_INTEGER) {
      throw new BuildOrdinalReservationError('counter-exhausted', opts.product, current)
    }
    const next = current + 1
    map[opts.product] = next
    persistOrdinals(file, map)
    return next
  })
}

/**
 * Reserve one strictly-later maintenance ordinal across every affected product axis.
 *
 * Unlike the best-effort run-start counter above, maintenance reservation is fail-closed: every
 * required counter must already exist and be a non-negative safe integer. The complete map is
 * persisted with one same-directory atomic replacement only after all validation succeeds.
 */
export async function reserveBuildOrdinalForProducts(
  opts: ReserveBuildOrdinalForProductsOptions,
): Promise<ReserveBuildOrdinalForProductsResult> {
  const products = Object.freeze([...new Set(opts.products)].sort())
  if (products.length === 0) return undefined

  return withCounterLock(opts.root, () => {
    const file = join(opts.root, BUILD_ORDINALS_FILE)
    const map = readOrdinals(file, products[0]!, false)
    let maximum = 0

    for (const product of products) {
      if (!Object.hasOwn(map, product)) {
        throw new BuildOrdinalReservationError('missing-counter', product)
      }
      const current = map[product]!
      if (current === Number.MAX_SAFE_INTEGER) {
        throw new BuildOrdinalReservationError('counter-exhausted', product, current)
      }
      maximum = Math.max(maximum, current)
    }

    const ordinal = maximum + 1
    for (const product of products) map[product] = ordinal
    const reservation = Object.freeze({ products, ordinal })
    persistOrdinals(file, map, () => opts.beforePersist?.(reservation))
    return ordinal
  })
}

function readOrdinals(
  file: string,
  product: string,
  missingIsEmpty: boolean,
): Record<string, number> {
  let raw: string
  try {
    raw = readFileSync(file, 'utf-8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      if (missingIsEmpty) return Object.create(null) as Record<string, number>
      throw new BuildOrdinalReservationError('missing-counter', product)
    }
    throw error
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new BuildOrdinalReservationError('invalid-state', product)
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new BuildOrdinalReservationError('invalid-state', product, parsed)
  }

  const map = Object.create(null) as Record<string, number>
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
      throw new BuildOrdinalReservationError('invalid-counter', key, value)
    }
    map[key] = value
  }
  return map
}
