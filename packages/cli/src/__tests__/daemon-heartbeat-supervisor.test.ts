import { MASKED_RESOLVED_CONFIG_SCHEMA_VERSION } from '@vostride/agent-qa-schema'
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { spawn, type ChildProcess } from 'node:child_process';

import {
  LEASE_HEARTBEAT_TTL_MS,
  WRITER_AUTHORITY_DB_FILE,
  acquireWriterLease,
  readWriterLease,
  releaseLease,
  withCurrentWriterAuthority,
} from '@vostride/agent-qa-knowledge-local';
import type { ConfigReaderPort } from '@vostride/agent-qa-agent';
import { afterAll, describe, expect, it } from 'vitest';

import { runDaemonHost } from '../daemon/host.js';
import {
  HEARTBEAT_SUPERVISOR_STOP_TIMEOUT_MS,
  startHeartbeatSupervisor,
  type HeartbeatSupervisorMessage,
} from '../daemon/heartbeat-supervisor.js';
import { removeTempRoots } from './temp-roots.js';

const FIXTURE_ROLE = process.env.AGENT_QA_HEARTBEAT_FIXTURE_ROLE;
const FIXTURE_ROOT = process.env.AGENT_QA_HEARTBEAT_FIXTURE_ROOT;
const FIXTURE_MARKER = process.env.AGENT_QA_HEARTBEAT_FIXTURE_MARKER;
const FIXTURE_REPORT = process.env.AGENT_QA_HEARTBEAT_FIXTURE_REPORT;
const FIXTURE_TAKEOVER_MS = process.env.AGENT_QA_HEARTBEAT_FIXTURE_TAKEOVER_MS;
const FIXTURE_RELEASE = process.env.AGENT_QA_HEARTBEAT_FIXTURE_RELEASE;
const PACKAGE_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const VITEST_BIN = join(PACKAGE_ROOT, 'node_modules', 'vitest', 'vitest.mjs');
const THIS_TEST_FILE = fileURLToPath(import.meta.url);
const BLOCK_MARGIN_MS = 20_000;
const RECLAIM_MARGIN_MS = 1_000;
/** The governed mutation must still be open when a contender arrives past the lease TTL. */
const MUTATION_HOLD_MS = LEASE_HEARTBEAT_TTL_MS + 10_000;
const MUTATION_CONTENDER_DELAY_MS = LEASE_HEARTBEAT_TTL_MS + 2_000;
const MUTATION_RECORD_FILE = 'mutation-record.log';
/**
 * the blocked/mutating daemon fixtures hold their main thread
 * until the parent writes a release file, after its contender has reported, and never less
 * than their stated minimum. A fixed hold raced the contender's own process start: at load
 * 74-88 the contender attempted 41.6-42.2 s after the mutation began, past the 40 s hold,
 * found the daemon exited and its lease released, and read `acquired` epoch 2 (3 of 3 runs;
 * 432-03 #1). The cap only bounds a parent that never releases.
 */
const RELEASE_CAP_MS = 120_000;
/** ceiling for one child vitest process to boot and report. */
const CHILD_BOOT_CEILING_MS = 60_000;

/** Synchronously occupy the calling thread for at least minHoldMs and until released. */
function holdUntilReleased(minHoldMs: number, release: string): { heldMs: number; released: boolean } {
  const startedAtMonotonicMs = performance.now();
  let released = false;
  let lastCheckMs = -Infinity;
  for (;;) {
    const elapsedMs = performance.now() - startedAtMonotonicMs;
    if (elapsedMs - lastCheckMs >= 50) {
      released = existsSync(release);
      lastCheckMs = elapsedMs;
    }
    if (elapsedMs >= minHoldMs && (released || elapsedMs >= minHoldMs + RELEASE_CAP_MS)) {
      return { heldMs: elapsedMs, released };
    }
  }
}

const daemonConfig: ConfigReaderPort = {
  getMasked: () => Promise.resolve({
    schemaVersion: MASKED_RESOLVED_CONFIG_SCHEMA_VERSION,
    configPath: '/tmp/agent-qa-heartbeat-fixture.yaml',
    entries: [],
  }),
};

function requiredFixtureValue(value: string | undefined, name: string): string {
  if (value === undefined || value.length === 0) {
    throw new Error(`Missing ${name} for daemon heartbeat fixture`);
  }
  return value;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForFile(
  path: string,
  child?: FixtureChild,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (child !== undefined && child.process.exitCode !== null) {
      const exited = await child.exit;
      throw new Error(`Fixture exited before writing ${path}:\n${exited.output}`);
    }
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for fixture file: ${path}`);
    }
    await delay(25);
  }
}

async function waitForCondition(
  predicate: () => boolean,
  description: string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${description}`);
    await delay(25);
  }
}

interface FixtureChild {
  process: ChildProcess;
  exit: Promise<{ code: number | null; signal: NodeJS.Signals | null; output: string }>;
}

function startFixture(
  role: 'busy-daemon' | 'stopped-daemon' | 'contender' | 'cwd-supervisor' | 'mutating-daemon',
  values: {
    root: string;
    marker?: string;
    report?: string;
    cwd?: string;
    takeoverMs?: number;
    release?: string;
  },
): FixtureChild {
  const child = spawn(
    process.execPath,
    [
      VITEST_BIN,
      'run',
      THIS_TEST_FILE,
      '--root',
      PACKAGE_ROOT,
      '--pool=threads',
      '--maxWorkers=1',
    ],
    {
      cwd: values.cwd ?? PACKAGE_ROOT,
      env: {
        ...process.env,
        AGENT_QA_HEARTBEAT_FIXTURE_ROLE: role,
        AGENT_QA_HEARTBEAT_FIXTURE_ROOT: values.root,
        AGENT_QA_HEARTBEAT_FIXTURE_MARKER: values.marker,
        AGENT_QA_HEARTBEAT_FIXTURE_REPORT: values.report,
        AGENT_QA_HEARTBEAT_FIXTURE_TAKEOVER_MS: values.takeoverMs === undefined
          ? undefined
          : String(values.takeoverMs),
        AGENT_QA_HEARTBEAT_FIXTURE_RELEASE: values.release,
        NODE_PATH: role === 'cwd-supervisor' ? '' : process.env.NODE_PATH,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let output = '';
  child.stdout?.on('data', (chunk: Buffer | string) => {
    output += chunk.toString();
  });
  child.stderr?.on('data', (chunk: Buffer | string) => {
    output += chunk.toString();
  });
  return {
    process: child,
    exit: new Promise((resolve) => {
      child.once('exit', (code, signal) => resolve({ code, signal, output }));
    }),
  };
}

async function stopFixture(child: FixtureChild, wasStopped = false): Promise<void> {
  if (wasStopped && child.process.exitCode === null) {
    child.process.kill('SIGCONT');
  }
  if (child.process.exitCode === null) {
    child.process.kill('SIGKILL');
  }
  await child.exit;
}

if (FIXTURE_ROLE === 'contender') {
  describe('daemon heartbeat contender fixture', () => {
    it('records a real writer-lease acquisition attempt', () => {
      const root = requiredFixtureValue(FIXTURE_ROOT, 'fixture root');
      const report = requiredFixtureValue(FIXTURE_REPORT, 'fixture report');
      const attemptedAtMs = Date.now();
      const result = FIXTURE_TAKEOVER_MS === undefined || FIXTURE_TAKEOVER_MS.length === 0
        ? acquireWriterLease(root)
        : acquireWriterLease(root, { mutationLockTakeoverMs: Number(FIXTURE_TAKEOVER_MS) });
      writeFileSync(report, JSON.stringify({ attemptedAtMs, result }), 'utf8');
    });
  });
} else if (FIXTURE_ROLE === 'mutating-daemon') {
  describe('daemon governed-mutation fixture', () => {
    it(
      'holds one governed writer mutation open beyond the lease TTL',
      async () => {
        const root = requiredFixtureValue(FIXTURE_ROOT, 'fixture root');
        const marker = requiredFixtureValue(FIXTURE_MARKER, 'fixture marker');
        const report = requiredFixtureValue(FIXTURE_REPORT, 'fixture report');
        const release = requiredFixtureValue(FIXTURE_RELEASE, 'fixture release');
        const mutationRecord = join(root, MUTATION_RECORD_FILE);
        const expectedError = 'mutating-daemon-fixture-complete';
        let released = false;
        let endedAtWallMs: number | undefined;

        await expect(
          runDaemonHost({
            agentQaRoot: join(root, '.agent-qa'),
            knowledgeRoot: root,
            config: daemonConfig,
            model: async () => {
              const published = readWriterLease(root);
              if (published.kind !== 'parsed') {
                throw new Error(`Expected a published daemon lease, received ${published.kind}`);
              }
              const startedAtWallMs = Date.now();
              let authorityError: string | undefined;
              try {
                withCurrentWriterAuthority(
                  root,
                  { leaseId: published.lease.leaseId, epoch: published.lease.epoch },
                  () => {
                    writeFileSync(marker, JSON.stringify({ startedAtWallMs }), 'utf8');
                    // Keep one governed authority transaction open past the lease TTL, until
                    // the parent's contender has reported.
                    released = holdUntilReleased(MUTATION_HOLD_MS, release).released;
                    endedAtWallMs = Date.now();
                    appendFileSync(mutationRecord, 'mutated\n');
                  },
                );
              } catch (error) {
                authorityError = error instanceof Error ? error.name : String(error);
              }

              // The next strong heartbeat after the transaction commits must refresh the lease.
              let leaseHeartbeatAtMs: number | undefined;
              const refreshDeadline = Date.now() + LEASE_HEARTBEAT_TTL_MS;
              while (Date.now() < refreshDeadline) {
                const observed = readWriterLease(root);
                if (
                  observed.kind === 'parsed'
                  && observed.lease.heartbeatAtMs > startedAtWallMs
                ) {
                  leaseHeartbeatAtMs = observed.lease.heartbeatAtMs;
                  break;
                }
                await delay(100);
              }
              writeFileSync(
                report,
                JSON.stringify({ startedAtWallMs, endedAtWallMs, released, authorityError, leaseHeartbeatAtMs }),
                'utf8',
              );
              throw new Error(expectedError);
            },
          }),
        ).rejects.toThrow(expectedError);
      },
      MUTATION_HOLD_MS + RELEASE_CAP_MS + LEASE_HEARTBEAT_TTL_MS + 30_000,
    );
  });
} else if (FIXTURE_ROLE === 'cwd-supervisor') {
  describe('daemon heartbeat unrelated-cwd fixture', () => {
    it('loads the supervisor capability independently of process cwd', async () => {
      const root = requiredFixtureValue(FIXTURE_ROOT, 'fixture root');
      const report = requiredFixtureValue(FIXTURE_REPORT, 'fixture report');
      const acquired = acquireWriterLease(root);
      if (acquired.kind !== 'acquired') {
        throw new Error(`Expected acquired fixture lease, received ${acquired.kind}`);
      }
      const messages: HeartbeatSupervisorMessage[] = [];
      const supervisor = await startHeartbeatSupervisor({
        knowledgeRoot: root,
        leaseId: acquired.leaseId,
        intervalMs: 25,
        onMessage: (message) => messages.push(message),
        onUnexpectedExit: (error) => {
          throw error;
        },
      });
      await waitForCondition(
        () => messages.some((message) => message.kind === 'heartbeated'),
        'an unrelated-cwd heartbeat',
        CHILD_BOOT_CEILING_MS,
      );
      await supervisor.stop();
      writeFileSync(
        report,
        JSON.stringify({ cwd: process.cwd(), heartbeatCount: messages.length }),
        'utf8',
      );
    });
  });
} else if (FIXTURE_ROLE === 'busy-daemon') {
  describe('daemon busy-loop fixture', () => {
    it(
      'holds the production daemon main thread beyond the lease TTL',
      async () => {
        const root = requiredFixtureValue(FIXTURE_ROOT, 'fixture root');
        const marker = requiredFixtureValue(FIXTURE_MARKER, 'fixture marker');
        const report = requiredFixtureValue(FIXTURE_REPORT, 'fixture report');
        const release = requiredFixtureValue(FIXTURE_RELEASE, 'fixture release');
        const expectedError = 'busy-loop-fixture-complete';

        await expect(
          runDaemonHost({
            agentQaRoot: join(root, '.agent-qa'),
            knowledgeRoot: root,
            config: daemonConfig,
            model: () => {
              const startedAtMonotonicMs = performance.now();
              const startedAtWallMs = Date.now();
              writeFileSync(
                marker,
                JSON.stringify({ startedAtMonotonicMs, startedAtWallMs }),
                'utf8',
              );
              // Intentionally keep the daemon's main event loop synchronously occupied.
              const { released } = holdUntilReleased(LEASE_HEARTBEAT_TTL_MS + BLOCK_MARGIN_MS, release);
              const durationMs = performance.now() - startedAtMonotonicMs;
              writeFileSync(report, JSON.stringify({ durationMs, released }), 'utf8');
              throw new Error(expectedError);
            },
          }),
        ).rejects.toThrow(expectedError);
      },
      LEASE_HEARTBEAT_TTL_MS + BLOCK_MARGIN_MS + RELEASE_CAP_MS + 30_000,
    );
  });
} else if (FIXTURE_ROLE === 'stopped-daemon') {
  describe('daemon SIGSTOP fixture', () => {
    it(
      'keeps a production daemon startup alive until its process is stopped',
      async () => {
        const root = requiredFixtureValue(FIXTURE_ROOT, 'fixture root');
        const marker = requiredFixtureValue(FIXTURE_MARKER, 'fixture marker');
        await runDaemonHost({
          agentQaRoot: join(root, '.agent-qa'),
          knowledgeRoot: root,
          config: daemonConfig,
          model: () => {
            writeFileSync(marker, JSON.stringify({ readyAtMs: Date.now() }), 'utf8');
            return new Promise<never>(() => undefined);
          },
        });
      },
      LEASE_HEARTBEAT_TTL_MS * 3,
    );
  });
} else {
  describe('daemon heartbeat supervision across real process boundaries', () => {
    const roots: string[] = [];
    afterAll(() => removeTempRoots(roots.splice(0)));

    it('resolves the worker capability when the launching project cwd has no dependencies', async () => {
      const root = mkdtempSync(join(tmpdir(), 'agent-qa-heartbeat-cwd-'));
      roots.push(root);
      const report = join(root, 'cwd-supervisor.json');
      const fixture = startFixture('cwd-supervisor', { root, report, cwd: root });
      const exited = await fixture.exit;

      expect(exited, exited.output).toMatchObject({ code: 0, signal: null });
      expect(JSON.parse(readFileSync(report, 'utf8'))).toMatchObject({
        cwd: realpathSync(root),
        heartbeatCount: expect.any(Number),
      });
      // the cell boots a whole child vitest process; it waits on
      // that child's exit, so its budget is a hang ceiling. 2.1 s alone at load 23, 9.8-10.1 s at
      // load 74-88, and over the old 15 s under a forced gate (432-03 #1).
    }, 2 * CHILD_BOOT_CEILING_MS);

    it('stops a live worker idempotently without emitting later heartbeats', async () => {
      const root = mkdtempSync(join(tmpdir(), 'agent-qa-heartbeat-stop-'));
      roots.push(root);
      const acquired = acquireWriterLease(root);
      if (acquired.kind !== 'acquired') {
        throw new Error(`Expected acquired fixture lease, received ${acquired.kind}`);
      }
      const messages: HeartbeatSupervisorMessage[] = [];
      const unexpected: Error[] = [];
      const supervisor = await startHeartbeatSupervisor({
        knowledgeRoot: root,
        leaseId: acquired.leaseId,
        intervalMs: 25,
        onMessage: (message) => messages.push(message),
        onUnexpectedExit: (error) => unexpected.push(error),
      });

      await waitForCondition(
        () => messages.some((message) => message.kind === 'heartbeated'),
        'a supervised heartbeat',
      );
      const firstStop = supervisor.stop();
      const secondStop = supervisor.stop();
      expect(secondStop).toBe(firstStop);
      await firstStop;
      const stoppedCount = messages.length;
      await delay(100);

      expect(messages).toHaveLength(stoppedCount);
      expect(unexpected).toEqual([]);
    });

    it('reports one refusal, halts recurrence, and preserves the replacement lease', async () => {
      const root = mkdtempSync(join(tmpdir(), 'agent-qa-heartbeat-refusal-'));
      roots.push(root);
      const acquired = acquireWriterLease(root);
      if (acquired.kind !== 'acquired') {
        throw new Error(`Expected acquired fixture lease, received ${acquired.kind}`);
      }
      const messages: HeartbeatSupervisorMessage[] = [];
      const unexpected: Error[] = [];
      const supervisor = await startHeartbeatSupervisor({
        knowledgeRoot: root,
        leaseId: acquired.leaseId,
        intervalMs: 25,
        onMessage: (message) => messages.push(message),
        onUnexpectedExit: (error) => unexpected.push(error),
      });
      expect(releaseLease({ knowledgeRoot: root, leaseId: acquired.leaseId })).toEqual({
        kind: 'released',
      });
      // strict again. 432-19 had the fixture re-release a lease
      // that the supervised 25 ms beat resurrected under the same id (432-19 #7). The beat and the
      // release now share the lease-file guard, so once the release returns no beat can rewrite
      // the lease, and the very next acquire must answer `acquired`.
      const replacement = acquireWriterLease(root);
      if (replacement.kind !== 'acquired') {
        throw new Error(`Expected replacement fixture lease, received ${replacement.kind}`);
      }

      await waitForCondition(
        () => messages.some((message) => message.kind === 'refused'),
        'a supervised refusal',
      );
      const refusalCount = messages.filter((message) => message.kind === 'refused').length;
      await delay(100);
      await supervisor.stop();

      expect(refusalCount).toBe(1);
      expect(messages.filter((message) => message.kind === 'refused')).toHaveLength(1);
      expect(unexpected).toEqual([]);
      expect(readWriterLease(root)).toEqual({
        kind: 'parsed',
        lease: expect.objectContaining({
          leaseId: replacement.leaseId,
          epoch: replacement.epoch,
        }),
      });
    });

    it(
      'keeps the writer lease held while the daemon holds one governed mutation past TTL',
      async () => {
        const root = mkdtempSync(join(tmpdir(), 'agent-qa-heartbeat-mutating-'));
        roots.push(root);
        const marker = join(root, 'mutation-started.json');
        const daemonReport = join(root, 'mutation-complete.json');
        const contenderReport = join(root, 'contender.json');
        const release = join(root, 'release-mutation');
        const mutationRecord = join(root, MUTATION_RECORD_FILE);
        const daemon = startFixture('mutating-daemon', {
          root,
          marker,
          report: daemonReport,
          release,
        });

        try {
          await waitForFile(marker, daemon);
          const initialLease = readWriterLease(root);
          if (initialLease.kind !== 'parsed') {
            throw new Error(`Expected parsed initial lease, received ${initialLease.kind}`);
          }

          await delay(MUTATION_CONTENDER_DELAY_MS);
          const contender = startFixture('contender', {
            root,
            report: contenderReport,
            takeoverMs: 0,
          });
          const contenderExit = await contender.exit;
          expect(contenderExit, contenderExit.output).toMatchObject({ code: 0, signal: null });

          const contenderPayload = JSON.parse(readFileSync(contenderReport, 'utf8')) as {
            attemptedAtMs: number;
            result: ReturnType<typeof acquireWriterLease>;
          };
          expect(contenderPayload.result).toEqual({
            kind: 'held',
            holder: expect.objectContaining({
              leaseId: initialLease.lease.leaseId,
              epoch: initialLease.lease.epoch,
            }),
          });
          writeFileSync(release, 'contender reported\n', 'utf8');

          const daemonExit = await daemon.exit;
          expect(daemonExit, daemonExit.output).toMatchObject({ code: 0, signal: null });
          expect(readFileSync(mutationRecord, 'utf8')).toBe('mutated\n');
          const mutationPayload = JSON.parse(readFileSync(daemonReport, 'utf8')) as {
            startedAtWallMs: number;
            endedAtWallMs: number;
            released: boolean;
            authorityError?: string;
            leaseHeartbeatAtMs?: number;
          };
          // The contender arrived past the TTL and inside the still-open mutation.
          expect(mutationPayload.released).toBe(true);
          expect(contenderPayload.attemptedAtMs - mutationPayload.startedAtWallMs).toBeGreaterThan(
            LEASE_HEARTBEAT_TTL_MS,
          );
          expect(contenderPayload.attemptedAtMs).toBeLessThan(mutationPayload.endedAtWallMs);
          expect(mutationPayload.authorityError).toBeUndefined();
          expect(mutationPayload.leaseHeartbeatAtMs).toBeGreaterThan(
            mutationPayload.startedAtWallMs,
          );
        } finally {
          await stopFixture(daemon);
        }
      },
      MUTATION_HOLD_MS + RELEASE_CAP_MS + LEASE_HEARTBEAT_TTL_MS + 60_000,
    );

    it('resolves a graceful stop well inside the stop timeout', async () => {
      const root = mkdtempSync(join(tmpdir(), 'agent-qa-heartbeat-graceful-'));
      roots.push(root);
      const acquired = acquireWriterLease(root);
      if (acquired.kind !== 'acquired') {
        throw new Error(`Expected acquired fixture lease, received ${acquired.kind}`);
      }
      const supervisor = await startHeartbeatSupervisor({
        knowledgeRoot: root,
        leaseId: acquired.leaseId,
        intervalMs: 25,
        onMessage: () => undefined,
        onUnexpectedExit: (error) => {
          throw error;
        },
      });

      const startedAtMs = Date.now();
      await supervisor.stop();

      expect(Date.now() - startedAtMs).toBeLessThan(HEARTBEAT_SUPERVISOR_STOP_TIMEOUT_MS);
    }, 20_000);

    it('resolves stop only after a wedged heartbeat worker thread has exited', async () => {
      const root = mkdtempSync(join(tmpdir(), 'agent-qa-heartbeat-wedge-'));
      roots.push(root);
      const acquired = acquireWriterLease(root);
      if (acquired.kind !== 'acquired') {
        throw new Error(`Expected acquired fixture lease, received ${acquired.kind}`);
      }
      // A held external authority transaction wedges the worker inside its synchronous
      // persistence call, exactly as a long governed mutation does in production.
      const wedge = new DatabaseSync(join(root, WRITER_AUTHORITY_DB_FILE));
      wedge.exec('PRAGMA busy_timeout = 250');
      wedge.exec('BEGIN IMMEDIATE');

      try {
        const unexpected: Error[] = [];
        const supervisor = await startHeartbeatSupervisor({
          knowledgeRoot: root,
          leaseId: acquired.leaseId,
          intervalMs: 25,
          stopTimeoutMs: 100,
          onMessage: () => undefined,
          onUnexpectedExit: (error) => unexpected.push(error),
        });
        let workerExited = false;
        void supervisor.exited.then(() => {
          workerExited = true;
        });

        // The worker entered its heartbeat at ~25ms and is wedged for the full SQLite busy
        // window, so the 100ms graceful deadline necessarily elapses while the thread is live.
        await delay(500);
        await supervisor.stop();

        expect(
          workerExited,
          'stop() resolved before the heartbeat worker thread exited',
        ).toBe(true);
        expect(unexpected).toEqual([]);
      } finally {
        wedge.exec('ROLLBACK');
        wedge.close();
      }
    }, 30_000);

    /**
     * I-02: the supervisor carried a `MutationLockBusyError` retry branch that could not run.
     *
     * The premise still has to stay checked, and it is now stronger than it was: the beat takes no
     * mutation lock at all, so a store whose write transaction is held by someone else is not a
     * contended beat but an ordinary one. This leg drives a real wedged store and asserts the beat
     * lands — never an error message, and never a third outcome. If a future change routes the
     * beat back through the lock, this reddens, which is exactly when the deleted retry branch
     * would have been needed and exactly when silently retrying would hide the regression.
     */
    it('takes an ordinary beat against a wedged store, never a busy throw', async () => {
      const root = mkdtempSync(join(tmpdir(), 'agent-qa-heartbeat-contention-'));
      roots.push(root);
      const acquired = acquireWriterLease(root);
      if (acquired.kind !== 'acquired') {
        throw new Error(`Expected acquired fixture lease, received ${acquired.kind}`);
      }
      const wedge = new DatabaseSync(join(root, WRITER_AUTHORITY_DB_FILE));
      wedge.exec('PRAGMA busy_timeout = 250');
      wedge.exec('BEGIN IMMEDIATE');

      try {
        const messages: HeartbeatSupervisorMessage[] = [];
        const unexpected: Error[] = [];
        const supervisor = await startHeartbeatSupervisor({
          knowledgeRoot: root,
          leaseId: acquired.leaseId,
          intervalMs: 25,
          stopTimeoutMs: 500,
          onMessage: (message) => messages.push(message),
          onUnexpectedExit: (error) => unexpected.push(error),
        });

        try {
          await waitForCondition(
            () => messages.length >= 2,
            'two beats against the wedged store',
            20_000,
          );
        } finally {
          await supervisor.stop();
        }

        expect(messages.filter((message) => message.kind === 'error')).toEqual([]);
        expect(messages.filter((message) => message.kind === 'refused')).toEqual([]);
        expect(messages.every((message) => message.kind === 'heartbeated')).toBe(true);
        expect(unexpected).toEqual([]);
      } finally {
        wedge.exec('ROLLBACK');
        wedge.close();
      }
    }, 60_000);

    it(
      'keeps the writer lease held while only the daemon main loop is blocked past TTL',
      async () => {
        const root = mkdtempSync(join(tmpdir(), 'agent-qa-heartbeat-busy-'));
        roots.push(root);
        const marker = join(root, 'busy-started.json');
        const daemonReport = join(root, 'busy-complete.json');
        const contenderReport = join(root, 'contender.json');
        const release = join(root, 'release-busy');
        const daemon = startFixture('busy-daemon', {
          root,
          marker,
          report: daemonReport,
          release,
        });

        try {
          await waitForFile(marker, daemon);
          const markerPayload = JSON.parse(readFileSync(marker, 'utf8')) as {
            startedAtWallMs: number;
          };
          const initialLease = readWriterLease(root);
          expect(initialLease.kind).toBe('parsed');
          if (initialLease.kind !== 'parsed') {
            throw new Error(`Expected parsed initial lease, received ${initialLease.kind}`);
          }

          await delay(LEASE_HEARTBEAT_TTL_MS + RECLAIM_MARGIN_MS);
          const contender = startFixture('contender', { root, report: contenderReport });
          const contenderExit = await contender.exit;
          expect(contenderExit, contenderExit.output).toMatchObject({ code: 0, signal: null });
          expect(existsSync(daemonReport)).toBe(false);

          const contenderPayload = JSON.parse(readFileSync(contenderReport, 'utf8')) as {
            attemptedAtMs: number;
            result: ReturnType<typeof acquireWriterLease>;
          };
          expect(contenderPayload.attemptedAtMs).toBeGreaterThanOrEqual(
            markerPayload.startedAtWallMs,
          );
          expect(contenderPayload.result).toEqual({
            kind: 'held',
            holder: expect.objectContaining({
              leaseId: initialLease.lease.leaseId,
              epoch: initialLease.lease.epoch,
            }),
          });
          writeFileSync(release, 'contender reported\n', 'utf8');

          const daemonExit = await daemon.exit;
          expect(daemonExit, daemonExit.output).toMatchObject({ code: 0, signal: null });
          const busyReport = JSON.parse(readFileSync(daemonReport, 'utf8')) as {
            durationMs: number;
            released: boolean;
          };
          expect(busyReport.released).toBe(true);
          expect(busyReport.durationMs).toBeGreaterThanOrEqual(
            LEASE_HEARTBEAT_TTL_MS + BLOCK_MARGIN_MS,
          );
        } finally {
          await stopFixture(daemon);
        }
      },
      LEASE_HEARTBEAT_TTL_MS + BLOCK_MARGIN_MS + RELEASE_CAP_MS + 45_000,
    );

    it.runIf(process.platform !== 'win32')(
      'allows a real contender to reclaim with an epoch bump after whole-process SIGSTOP',
      async () => {
        const root = mkdtempSync(join(tmpdir(), 'agent-qa-heartbeat-sigstop-'));
        roots.push(root);
        const marker = join(root, 'daemon-ready.json');
        const contenderReport = join(root, 'contender.json');
        const daemon = startFixture('stopped-daemon', { root, marker });
        let wasStopped = false;

        try {
          await waitForFile(marker, daemon);
          const initialLease = readWriterLease(root);
          expect(initialLease.kind).toBe('parsed');
          if (initialLease.kind !== 'parsed') {
            throw new Error(`Expected parsed initial lease, received ${initialLease.kind}`);
          }
          expect(daemon.process.kill('SIGSTOP')).toBe(true);
          wasStopped = true;

          await delay(LEASE_HEARTBEAT_TTL_MS + RECLAIM_MARGIN_MS);
          const contender = startFixture('contender', { root, report: contenderReport });
          const contenderExit = await contender.exit;
          expect(contenderExit, contenderExit.output).toMatchObject({ code: 0, signal: null });

          const contenderPayload = JSON.parse(readFileSync(contenderReport, 'utf8')) as {
            result: ReturnType<typeof acquireWriterLease>;
          };
          expect(contenderPayload.result).toEqual({
            kind: 'acquired',
            epoch: initialLease.lease.epoch + 1,
            leaseId: expect.any(String),
            reclaimed: expect.objectContaining({
              epoch: initialLease.lease.epoch,
              leaseId: initialLease.lease.leaseId,
            }),
          });
        } finally {
          await stopFixture(daemon, wasStopped);
        }
      },
      LEASE_HEARTBEAT_TTL_MS + 45_000,
    );
  });
}
