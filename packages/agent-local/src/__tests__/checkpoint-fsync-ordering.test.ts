// Asserts the ordered syscall list, labelled from raw arguments, because SIGKILL cannot test fsync.

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { afterEach, beforeEach, describe, expect, expectTypeOf, it } from 'vitest'

import {
  createJobCheckpointStore,
  createJobCheckpointStoreOn,
  DIRECTORY_FSYNC_SWALLOWED_CODES,
  REAL_JOB_CHECKPOINT_FS,
} from '../store/job-checkpoint-store.js'
import type {
  CreateJobCheckpointStoreOptions,
  JobCheckpointFs,
} from '../store/job-checkpoint-store.js'
import { InvalidJobCheckpointIdError } from '../store/store-errors.js'

const JOB_ID = 'job_fsync0001'
const CHECKPOINT_ID = 'analysis'

interface RecordedCall {
  readonly call: string
  readonly args: readonly unknown[]
  readonly result?: unknown
}

interface RecordingFsOptions {
  /** Replace the outcome of the PARENT-DIRECTORY fsync with this errno, nothing else. */
  readonly directoryFsyncErrno?: string
}

interface RecordingFs {
  readonly fs: JobCheckpointFs
  readonly calls: RecordedCall[]
}

/**
 * A facade that RECORDS and then calls through to the real implementation.
 *
 * Calling through matters: a facade that answered on its own would turn this file into a
 * test of a mock's bookkeeping, and the bytes on disk asserted below would prove nothing
 * about the publisher. The one exception is the deliberate fault injection, which is the
 * only way to reach the parent-directory failure branch — a real directory fsync succeeds.
 */
function createRecordingFs(options: RecordingFsOptions = {}): RecordingFs {
  const calls: RecordedCall[] = []
  const openedAs = new Map<number, string>()

  function record<T>(call: string, args: readonly unknown[], body: () => T): T {
    const result = body()
    calls.push({ call, args, result })
    return result
  }

  const fs: JobCheckpointFs = {
    mkdirSync: (path, mkdirOptions) =>
      record('mkdirSync', [path], () => {
        REAL_JOB_CHECKPOINT_FS.mkdirSync(path, mkdirOptions)
      }),
    openSync: (path, flags) =>
      record('openSync', [path, flags], () => {
        const fd = REAL_JOB_CHECKPOINT_FS.openSync(path, flags)
        openedAs.set(fd, flags)
        return fd
      }),
    writeFileSync: (fd, data, encoding) =>
      record('writeFileSync', [fd], () => {
        REAL_JOB_CHECKPOINT_FS.writeFileSync(fd, data, encoding)
      }),
    fsyncSync: (fd) =>
      record('fsyncSync', [fd], () => {
        // A descriptor opened read-only is the parent directory; one opened `wx` is the
        // temporary file. The recorder derives that from the flags it saw, so the fault can
        // be aimed at the directory fsync without the publisher labelling anything.
        if (options.directoryFsyncErrno !== undefined && openedAs.get(fd) === 'r') {
          const error = new Error(
            `injected ${options.directoryFsyncErrno} on directory fsync`,
          ) as NodeJS.ErrnoException
          error.code = options.directoryFsyncErrno
          throw error
        }
        REAL_JOB_CHECKPOINT_FS.fsyncSync(fd)
      }),
    closeSync: (fd) =>
      record('closeSync', [fd], () => {
        REAL_JOB_CHECKPOINT_FS.closeSync(fd)
      }),
    renameSync: (from, to) =>
      record('renameSync', [from, to], () => {
        REAL_JOB_CHECKPOINT_FS.renameSync(from, to)
      }),
    rmSync: (path, rmOptions) =>
      record('rmSync', [path], () => {
        REAL_JOB_CHECKPOINT_FS.rmSync(path, rmOptions)
      }),
    readFileSync: (path, encoding) =>
      record('readFileSync', [path], () =>
        REAL_JOB_CHECKPOINT_FS.readFileSync(path, encoding),
      ),
  }

  return { fs, calls }
}

/**
 * Turn raw recorded calls into the sequence a reader can judge.
 *
 * Paths become the three roles that matter (`dir`, `temp`, `final`) and descriptors are
 * resolved back to the path they were opened on, so `fsync temp` and `fsync dir` are
 * distinguishable without the publisher having said which was which.
 */
function describeSequence(calls: readonly RecordedCall[], finalPath: string): string[] {
  const dir = dirname(finalPath)
  const fdPath = new Map<number, string>()

  function label(value: unknown): string {
    const path = String(value)
    if (path === finalPath) return 'final'
    if (path === dir) return 'dir'
    if (path.startsWith(`${finalPath}.tmp-`)) return 'temp'
    return path
  }

  function labelFd(fd: unknown): string {
    const path = fdPath.get(Number(fd))
    return path === undefined ? `fd:${String(fd)}` : label(path)
  }

  return calls.map((entry) => {
    switch (entry.call) {
      case 'mkdirSync':
        return `mkdir ${label(entry.args[0])}`
      case 'openSync': {
        fdPath.set(Number(entry.result), String(entry.args[0]))
        return `open ${label(entry.args[0])} ${String(entry.args[1])}`
      }
      case 'writeFileSync':
        return `write ${labelFd(entry.args[0])}`
      case 'fsyncSync':
        return `fsync ${labelFd(entry.args[0])}`
      case 'closeSync':
        return `close ${labelFd(entry.args[0])}`
      case 'renameSync':
        return `rename ${label(entry.args[0])} -> ${label(entry.args[1])}`
      case 'rmSync':
        return `rm ${label(entry.args[0])}`
      case 'readFileSync':
        return `read ${label(entry.args[0])}`
      default:
        return `unknown:${entry.call}`
    }
  })
}

const EXPECTED_PUBLISH_SEQUENCE = [
  'mkdir dir',
  'open temp wx',
  'write temp',
  'fsync temp',
  'close temp',
  'rename temp -> final',
  'open dir r',
  'fsync dir',
  'close dir',
  'rm temp',
]

describe('checkpoint publish syscall ordering', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'agent-qa-fsync-order-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('executes exactly write -> fsync(fd) -> rename -> fsync(parent dir), in that order', () => {
    const { fs, calls } = createRecordingFs()
    const store = createJobCheckpointStoreOn(fs, { root })
    const file = store.checkpointPath(JOB_ID, CHECKPOINT_ID)

    store.publish(JOB_ID, CHECKPOINT_ID, { verdict: 'analysed' })

    expect(describeSequence(calls, file)).toEqual(EXPECTED_PUBLISH_SEQUENCE)
    expect(existsSync(file)).toBe(true)
  })

  // The ordered list above is the assertion; these three are the reasons each position in it
  // is load-bearing, stated so that a future reordering fails with a sentence rather than a
  // diff. They read the same recording, so they cost nothing.
  it('fsyncs the temporary file BEFORE the rename that publishes it', () => {
    const { fs, calls } = createRecordingFs()
    const store = createJobCheckpointStoreOn(fs, { root })
    store.publish(JOB_ID, CHECKPOINT_ID, { verdict: 'analysed' })
    const sequence = describeSequence(calls, store.checkpointPath(JOB_ID, CHECKPOINT_ID))

    expect(sequence.indexOf('fsync temp')).toBeGreaterThanOrEqual(0)
    expect(sequence.indexOf('fsync temp')).toBeLessThan(
      sequence.indexOf('rename temp -> final'),
    )
  })

  it('fsyncs the parent directory AFTER the rename, as the final durable act', () => {
    const { fs, calls } = createRecordingFs()
    const store = createJobCheckpointStoreOn(fs, { root })
    store.publish(JOB_ID, CHECKPOINT_ID, { verdict: 'analysed' })
    const sequence = describeSequence(calls, store.checkpointPath(JOB_ID, CHECKPOINT_ID))

    expect(sequence.indexOf('fsync dir')).toBeGreaterThan(
      sequence.indexOf('rename temp -> final'),
    )
  })

  it('opens the temporary exclusively, so a torn temporary from an earlier crash cannot alias', () => {
    const { fs, calls } = createRecordingFs()
    const store = createJobCheckpointStoreOn(fs, { root })
    store.publish(JOB_ID, CHECKPOINT_ID, { verdict: 'analysed' })

    expect(
      describeSequence(calls, store.checkpointPath(JOB_ID, CHECKPOINT_ID)),
    ).toContain('open temp wx')
  })

  it('repeats the identical sequence when the checkpoint already exists, leaving no temporary', () => {
    const first = createRecordingFs()
    const firstStore = createJobCheckpointStoreOn(first.fs, { root })
    const file = firstStore.checkpointPath(JOB_ID, CHECKPOINT_ID)
    firstStore.publish(JOB_ID, CHECKPOINT_ID, { verdict: 'first' })

    const second = createRecordingFs()
    const secondStore = createJobCheckpointStoreOn(second.fs, { root })
    secondStore.publish(JOB_ID, CHECKPOINT_ID, { verdict: 'second' })

    expect(describeSequence(first.calls, file)).toEqual(EXPECTED_PUBLISH_SEQUENCE)
    expect(describeSequence(second.calls, file)).toEqual(EXPECTED_PUBLISH_SEQUENCE)
    expect(readFileSync(file, 'utf8')).toContain('"second"')
    expect(readdirSync(dirname(file))).toEqual([`${CHECKPOINT_ID}.json`])
  })

  it.each([
    ['jobId', '../escape', CHECKPOINT_ID],
    ['checkpointId', JOB_ID, '../escape'],
  ])(
    'rejects an unusable %s before any filesystem call is recorded',
    (_field, jobId, checkpointId) => {
      const { fs, calls } = createRecordingFs()
      const store = createJobCheckpointStoreOn(fs, { root })

      expect(() => store.publish(jobId, checkpointId, { verdict: 'analysed' })).toThrow(
        InvalidJobCheckpointIdError,
      )
      expect(calls).toEqual([])
    },
  )

  // Both halves of the allowlist: listed codes are swallowed and an unlisted one propagates.
  it.each([...DIRECTORY_FSYNC_SWALLOWED_CODES])(
    'swallows %s from the parent-directory fsync and still publishes',
    (code) => {
      const { fs } = createRecordingFs({ directoryFsyncErrno: code })
      const store = createJobCheckpointStoreOn(fs, { root })

      store.publish(JOB_ID, CHECKPOINT_ID, { verdict: 'analysed' })

      expect(existsSync(store.checkpointPath(JOB_ID, CHECKPOINT_ID))).toBe(true)
    },
  )

  it('propagates an errno the allowlist does not name', () => {
    const { fs } = createRecordingFs({ directoryFsyncErrno: 'EIO' })
    const store = createJobCheckpointStoreOn(fs, { root })

    expect(() => store.publish(JOB_ID, CHECKPOINT_ID, { verdict: 'analysed' })).toThrow(
      /EIO/,
    )
  })

  it('keeps the allowlist exactly the five codes v51 debugged', () => {
    expect([...DIRECTORY_FSYNC_SWALLOWED_CODES]).toEqual([
      'ENOENT',
      'EINVAL',
      'EISDIR',
      'EPERM',
      'ENOTSUP',
    ])
  })
})

describe('the observation seam cannot become a production escape hatch', () => {
  // The production constructor takes a root and nothing else. That is the guarantee: no
  // production call site can hand this store a filesystem, because the option bag it accepts
  // has nowhere to put one. A facade parameter on the production factory would have made
  // "publish without fsync" a one-argument change.
  it('exposes no filesystem member on the production option bag', () => {
    expectTypeOf<keyof CreateJobCheckpointStoreOptions>().toEqualTypeOf<'root'>()
  })

  it('defaults to the real node:fs implementations', () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-qa-fsync-default-'))
    try {
      const store = createJobCheckpointStore({ root })
      store.publish(JOB_ID, CHECKPOINT_ID, { verdict: 'analysed' })

      expect(existsSync(store.checkpointPath(JOB_ID, CHECKPOINT_ID))).toBe(true)
      expect(store.read(JOB_ID, CHECKPOINT_ID)).toEqual({
        found: true,
        payload: { verdict: 'analysed' },
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  // A type that forbids the wrong argument is only half of it — the seam factory is still an
  // exported function. This asserts nobody outside a test has reached for it. The scan
  // carries a positive control and asserts every directory it walks really exists, because a
  // scanner that quietly found nothing would report exactly the same all-clear.
  it('is called from test files only, anywhere in the workspace', () => {
    const packagesDir = join(import.meta.dirname, '..', '..', '..')
    expect(existsSync(join(packagesDir, 'agent-local'))).toBe(true)

    const offenders: string[] = []
    let scanned = 0
    let positiveControl = false

    function walk(dir: string): void {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name === 'dist') continue
        const path = join(dir, entry.name)
        if (entry.isDirectory()) {
          walk(path)
          continue
        }
        if (!entry.name.endsWith('.ts')) continue
        scanned += 1
        const text = readFileSync(path, 'utf8')
        if (text.includes('createJobCheckpointStoreOn')) {
          if (path.includes('__tests__')) positiveControl = true
          else if (!path.endsWith(join('store', 'job-checkpoint-store.ts'))) {
            offenders.push(path)
          }
        }
      }
    }

    for (const pkg of readdirSync(packagesDir, { withFileTypes: true })) {
      if (!pkg.isDirectory()) continue
      const src = join(packagesDir, pkg.name, 'src')
      if (!existsSync(src)) continue
      walk(src)
    }

    expect(scanned).toBeGreaterThan(100)
    expect(positiveControl).toBe(true)
    expect(offenders).toEqual([])
  })
})
