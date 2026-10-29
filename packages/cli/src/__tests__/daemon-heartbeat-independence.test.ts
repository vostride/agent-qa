import {
  existsSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { spawn, type ChildProcess } from 'node:child_process';

import {
  EPOCH_FILE,
  LEASE_FILE,
  LEASE_HEARTBEAT_TTL_MS,
  WRITER_AUTHORITY_DB_FILE,
  acquireWriterLease,
  readWriterLease,
  withCurrentWriterAuthority,
  type WriterLease,
} from '@vostride/agent-qa-knowledge-local';
import { LOCAL_DAEMON_CAPABILITIES } from '@vostride/agent-qa-agent-local';
import { afterAll, describe, expect, it } from 'vitest';

import { startHeartbeatSupervisor } from '../daemon/heartbeat-supervisor.js';
import { removeTempRoots } from './temp-roots.js';

/**
 * what the deleted renewal sidecar used to claim, re-proven against the mechanism that
 * replaced it.
 *
 * 386-42 deleted the sidecar, made freshness three-valued and took the mutation lock out of the
 * beat. Every proof that heartbeat independence, stopped-holder reclaim and takeover fencing still
 * hold was therefore written against a mechanism that no longer exists. These legs restate them in
 * the only vocabulary that survived — the bytes of `.lease` and `.epoch`, and OS-observable process
 * outcomes — driving the SHIPPED worker thread and a REAL held authority transaction rather than
 * module internals.
 *
 * The escalation gate that replaced the sidecar is pinned here by its complete three-way set, never
 * by a pattern drawn from one of its own arms:
 *
 *   dead owner            -> reclaimed with an epoch bump and no escalation ceremony
 *   stopped owner past TTL -> escalated takeover: verified SIGKILL, CAS, epoch bump
 *   live beating owner    -> refused: no signal, no epoch movement, the holder keeps its lease
 */

const FIXTURE_ROLE = process.env.AGENT_QA_INDEPENDENCE_FIXTURE_ROLE;
const FIXTURE_ROOT = process.env.AGENT_QA_INDEPENDENCE_FIXTURE_ROOT;
const FIXTURE_MARKER = process.env.AGENT_QA_INDEPENDENCE_FIXTURE_MARKER;
const FIXTURE_RELEASED = process.env.AGENT_QA_INDEPENDENCE_FIXTURE_RELEASED;
const FIXTURE_PERMIT = process.env.AGENT_QA_INDEPENDENCE_FIXTURE_PERMIT;
const FIXTURE_EXIT_PERMIT = process.env.AGENT_QA_INDEPENDENCE_FIXTURE_EXIT_PERMIT;
const FIXTURE_REPORT = process.env.AGENT_QA_INDEPENDENCE_FIXTURE_REPORT;

const PACKAGE_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const VITEST_BIN = join(PACKAGE_ROOT, 'node_modules', 'vitest', 'vitest.mjs');
const THIS_TEST_FILE = fileURLToPath(import.meta.url);

/** Beat often enough that a held window shorter than the TTL still carries several advances. */
const BEAT_INTERVAL_MS = 250;
/** The observation window must be strictly longer than the TTL: that is the whole claim. */
const INDEPENDENCE_MARGIN_MS = 4_000;
/** How long the fixture will hold its governed mutation if no permit ever arrives. */
const FIXTURE_HOLD_CAP_MS = LEASE_HEARTBEAT_TTL_MS + 90_000;
const RECLAIM_MARGIN_MS = 2_000;
const MUTATION_RECORD_FILE = 'governed-mutation.log';

const describePosix = process.platform === 'win32' ? describe.skip : describe;

function requiredFixtureValue(value: string | undefined, name: string): string {
  if (value === undefined || value.length === 0) {
    throw new Error(`Missing ${name} for daemon independence fixture`);
  }
  return value;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * Sleep without yielding the thread, so a governed mutation can be held open synchronously.
 *
 * A busy spin would hold the transaction just as well, but it also saturates a core for the whole
 * over-TTL window; `Atomics.wait` is the same idiom the lease module itself uses for its bounded
 * waits and leaves the machine usable while the leg runs.
 */
const SYNCHRONOUS_SLEEP_WORD = new Int32Array(
  new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT),
);

function sleepSynchronously(milliseconds: number): void {
  Atomics.wait(SYNCHRONOUS_SLEEP_WORD, 0, 0, milliseconds);
}

interface FixtureChild {
  process: ChildProcess;
  exit: Promise<{ code: number | null; signal: NodeJS.Signals | null; output: string }>;
}

function startFixture(
  role: 'beating-holder',
  values: {
    root: string;
    marker: string;
    released: string;
    permit: string;
    exitPermit: string;
    report: string;
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
      cwd: PACKAGE_ROOT,
      env: {
        ...process.env,
        AGENT_QA_INDEPENDENCE_FIXTURE_ROLE: role,
        AGENT_QA_INDEPENDENCE_FIXTURE_ROOT: values.root,
        AGENT_QA_INDEPENDENCE_FIXTURE_MARKER: values.marker,
        AGENT_QA_INDEPENDENCE_FIXTURE_RELEASED: values.released,
        AGENT_QA_INDEPENDENCE_FIXTURE_PERMIT: values.permit,
        AGENT_QA_INDEPENDENCE_FIXTURE_EXIT_PERMIT: values.exitPermit,
        AGENT_QA_INDEPENDENCE_FIXTURE_REPORT: values.report,
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
  if (wasStopped && child.process.exitCode === null && child.process.signalCode === null) {
    child.process.kill('SIGCONT');
  }
  if (child.process.exitCode === null && child.process.signalCode === null) {
    child.process.kill('SIGKILL');
  }
  await child.exit;
}

interface ContenderOutcome {
  kind: string;
  reason?: string;
  message?: string;
  epoch?: number;
  leaseId?: string;
  holderLeaseId?: string;
  holderEpoch?: number;
  holderPid?: number;
  reclaimedLeaseId?: string;
  reclaimedEpoch?: number;
  elapsedMs: number;
}

/**
 * Contend from a separate OS process, through the package's published `dist` export map.
 *
 * A contender running inside this test process would share its pid with any mutation-lock row the
 * fixture wrote, and `terminateExactMutationLockOwner` refuses to signal its own pid — the leg
 * would then pass for a reason that has nothing to do with the gate under test. Going through the
 * export map is also what makes a cross-package mutation probe honest: the child reads the same
 * built artifact the CLI ships against.
 */
function spawnContender(
  knowledgeRoot: string,
  options: { takeoverMs?: number; deadlineMs?: number } = {},
): Promise<ContenderOutcome> {
  const source = `
    const { acquireWriterLease } = await import('@vostride/agent-qa-knowledge-local');
    const hooks = {};
    if (process.env.AGENT_QA_INDEPENDENCE_TAKEOVER_MS !== undefined) {
      hooks.mutationLockTakeoverMs = Number(process.env.AGENT_QA_INDEPENDENCE_TAKEOVER_MS);
    }
    if (process.env.AGENT_QA_INDEPENDENCE_DEADLINE_MS !== undefined) {
      hooks.acquireDeadlineMs = Number(process.env.AGENT_QA_INDEPENDENCE_DEADLINE_MS);
    }
    const startedAtNs = process.hrtime.bigint();
    const outcome = acquireWriterLease(process.env.AGENT_QA_INDEPENDENCE_ROOT, hooks);
    process.stdout.write(JSON.stringify({
      kind: outcome.kind,
      reason: outcome.reason,
      message: outcome.error === undefined ? undefined : outcome.error.message,
      epoch: outcome.epoch,
      leaseId: outcome.leaseId,
      holderLeaseId: outcome.holder === undefined ? undefined : outcome.holder.leaseId,
      holderEpoch: outcome.holder === undefined ? undefined : outcome.holder.epoch,
      holderPid: outcome.holder === undefined ? undefined : outcome.holder.pid,
      reclaimedLeaseId: outcome.reclaimed === undefined ? undefined : outcome.reclaimed.leaseId,
      reclaimedEpoch: outcome.reclaimed === undefined ? undefined : outcome.reclaimed.epoch,
      elapsedMs: Number(process.hrtime.bigint() - startedAtNs) / 1e6,
    }) + '\\n');
  `;
  const child = spawn(
    process.execPath,
    ['--input-type=module', '--eval', source],
    {
      cwd: PACKAGE_ROOT,
      env: {
        ...process.env,
        AGENT_QA_INDEPENDENCE_ROOT: knowledgeRoot,
        AGENT_QA_INDEPENDENCE_TAKEOVER_MS: options.takeoverMs === undefined
          ? undefined
          : String(options.takeoverMs),
        AGENT_QA_INDEPENDENCE_DEADLINE_MS: options.deadlineMs === undefined
          ? undefined
          : String(options.deadlineMs),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
    child.once('error', reject);
    // 'close', not 'exit': 'exit' can fire while the parent's end of the pipe still has undelivered
    // bytes, which is the same half-written-document read as the marker torn read — here it would
    // surface as a spurious "no outcome" rejection. 'close' is the point the writer is provably
    // done: the process is gone AND both stdio streams have ended.
    child.once('close', (code) => {
      const line = stdout.split('\n')[0] ?? '';
      if (!stdout.includes('\n')) {
        reject(new Error(`contender exited ${code} with no outcome:\n${stderr}`));
        return;
      }
      resolve(JSON.parse(line) as ContenderOutcome);
    });
  });
}

/**
 * Wait for a subprocess-written marker to be PARSEABLE, and hand back the parsed value.
 *
 * The shape this replaces waited on `existsSync` and then parsed the path in a separate
 * statement. `writeFileSync` creates the file before it finishes writing it, so the existence
 * answer arrives while the document may still be empty or half-flushed: the parse that follows
 * reads a live writer's file and dies with `SyntaxError: Unexpected end of JSON input` under
 * whole-monorepo parallel load. Success here is a COMPLETED JSON document, never an inode.
 *
 * Returning the value is load-bearing. A caller that took only a signal and then re-read the
 * path would race the same writer a second time; there is exactly one read, and it is the one
 * that already succeeded.
 *
 * Bounds are the old wait's, unchanged: a 25ms tick, a 30s deadline, and an early abort when the
 * fixture child exits before the file ever becomes readable.
 */
async function waitForParseableJson<T>(
  path: string,
  child?: FixtureChild,
  timeoutMs = 30_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastFailure = 'never attempted';
  for (;;) {
    try {
      return JSON.parse(readFileSync(path, 'utf8')) as T;
    } catch (error) {
      // Absent, ENOENT between existence and read, or a torn document: all one not-yet state.
      lastFailure = (error as Error).message;
    }
    if (child !== undefined && child.process.exitCode !== null) {
      const exited = await child.exit;
      throw new Error(`Fixture exited before writing ${path}:\n${exited.output}`);
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out waiting for parseable fixture file: ${path} (last read failure: ${lastFailure})`,
      );
    }
    await delay(25);
  }
}

/** Read the published lease as bytes on disk, never through the module that writes it. */
function leaseOnDisk(knowledgeRoot: string): WriterLease {
  return JSON.parse(readFileSync(join(knowledgeRoot, LEASE_FILE), 'utf8')) as WriterLease;
}

function epochBytes(knowledgeRoot: string): Buffer {
  return readFileSync(join(knowledgeRoot, EPOCH_FILE));
}

function processIsAliveInTest(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

if (FIXTURE_ROLE === 'beating-holder') {
  describe('daemon beating-holder fixture', () => {
    it(
      'beats from its worker thread while its main thread holds one governed mutation',
      async () => {
        const root = requiredFixtureValue(FIXTURE_ROOT, 'fixture root');
        const marker = requiredFixtureValue(FIXTURE_MARKER, 'fixture marker');
        const released = requiredFixtureValue(FIXTURE_RELEASED, 'fixture released marker');
        const permit = requiredFixtureValue(FIXTURE_PERMIT, 'fixture permit');
        const exitPermit = requiredFixtureValue(FIXTURE_EXIT_PERMIT, 'fixture exit permit');
        const report = requiredFixtureValue(FIXTURE_REPORT, 'fixture report');

        const acquired = acquireWriterLease(root);
        if (acquired.kind !== 'acquired') {
          throw new Error(`Expected an acquired fixture lease, received ${acquired.kind}`);
        }
        const unexpected: Error[] = [];
        const supervisor = await startHeartbeatSupervisor({
          knowledgeRoot: root,
          leaseId: acquired.leaseId,
          intervalMs: BEAT_INTERVAL_MS,
          onMessage: () => undefined,
          onUnexpectedExit: (error) => unexpected.push(error),
        });

        const startedAtMs = Date.now();
        let heldForMs = 0;
        withCurrentWriterAuthority(
          root,
          { leaseId: acquired.leaseId, epoch: acquired.epoch },
          () => {
            // The transaction is open from here: the parent may now observe an authority store
            // that is genuinely busy for the whole window, exactly as a long drain makes it.
            writeFileSync(marker, JSON.stringify({ pid: process.pid, startedAtMs }), 'utf8');
            const holdStartedAtMs = Date.now();
            while (
              !existsSync(permit)
              && Date.now() - holdStartedAtMs < FIXTURE_HOLD_CAP_MS
            ) {
              sleepSynchronously(50);
            }
            heldForMs = Date.now() - holdStartedAtMs;
            writeFileSync(join(root, MUTATION_RECORD_FILE), 'mutated\n', 'utf8');
          },
        );
        writeFileSync(released, JSON.stringify({ heldForMs }), 'utf8');

        // Keep beating after the transaction commits so the parent can contend against a holder
        // whose store is NOT busy — the schedule in which a starved lease would be reclaimed.
        const exitDeadline = Date.now() + FIXTURE_HOLD_CAP_MS;
        while (!existsSync(exitPermit) && Date.now() < exitDeadline) {
          await delay(50);
        }
        await supervisor.stop();
        writeFileSync(
          report,
          JSON.stringify({
            heldForMs,
            leaseId: acquired.leaseId,
            epoch: acquired.epoch,
            unexpected: unexpected.map((error) => error.message),
          }),
          'utf8',
        );
      },
      FIXTURE_HOLD_CAP_MS + 60_000,
    );
  });
} else {
  describe('heartbeat independence and the escalation gate after the sidecar deletion', () => {
    const roots: string[] = [];
    afterAll(() => removeTempRoots(roots.splice(0)));

    /**
     * ROADMAP criterion 2, re-proven structurally: 386-29's over-TTL contender proof, restated
     * against the lock-free beat.
     *
     * The old proof could be satisfied by a renewal sidecar staying fresh while `.lease` itself
     * aged out — the divergence CR-02 later showed was real. There is now exactly one place
     * freshness lives, so the claim is asserted where a contender actually reads it: the bytes of
     * `.lease` advance while a real governed mutation holds the authority store for longer than
     * the TTL, and both a mid-window contender and a post-release contender answer `held`.
     */
    it(
      'advances the published lease across an over-TTL held mutation and holds off contenders',
      async () => {
        const root = mkdtempSync(join(tmpdir(), 'agent-qa-independence-held-'));
        roots.push(root);
        const marker = join(root, 'mutation-open.json');
        const released = join(root, 'mutation-released.json');
        const permit = join(root, 'release.permit');
        const exitPermit = join(root, 'exit.permit');
        const report = join(root, 'holder-report.json');
        const holder = startFixture('beating-holder', {
          root,
          marker,
          released,
          permit,
          exitPermit,
          report,
        });

        try {
          const opened = await waitForParseableJson<{ pid: number }>(marker, holder);
          const holderPid = opened.pid;
          const initial = leaseOnDisk(root);
          const initialEpochBytes = epochBytes(root);

          // Observe the published lease for strictly longer than the TTL, sampling file bytes.
          const advances: number[] = [];
          let previousHeartbeatAtMs = initial.heartbeatAtMs;
          let stalestObservedAgeMs = 0;
          const windowEndsAtMs = Date.now() + LEASE_HEARTBEAT_TTL_MS + INDEPENDENCE_MARGIN_MS;
          while (Date.now() < windowEndsAtMs) {
            await delay(500);
            const sampled = leaseOnDisk(root);
            const ageMs = Date.now() - sampled.heartbeatAtMs;
            if (ageMs > stalestObservedAgeMs) stalestObservedAgeMs = ageMs;
            if (sampled.heartbeatAtMs > previousHeartbeatAtMs) {
              advances.push(sampled.heartbeatAtMs);
              previousHeartbeatAtMs = sampled.heartbeatAtMs;
            }
            expect(sampled.leaseId).toBe(initial.leaseId);
          }

          // The store was held for the whole window and the beat never missed: the published
          // lease never approached its own TTL, and the mutation is demonstrably still open.
          expect(advances.length).toBeGreaterThanOrEqual(2);
          expect(stalestObservedAgeMs).toBeLessThan(LEASE_HEARTBEAT_TTL_MS);
          expect(existsSync(released)).toBe(false);
          expect(existsSync(join(root, MUTATION_RECORD_FILE))).toBe(false);

          // 386-29's contender, arriving past the TTL with the most aggressive bound a caller can
          // set. The authority store is busy, the mutation-lock row names a live attributed pid.
          const midWindow = await spawnContender(root, {
            takeoverMs: 0,
            deadlineMs: 10_000,
          });
          expect(midWindow).toMatchObject({
            kind: 'held',
            holderLeaseId: initial.leaseId,
            holderEpoch: initial.epoch,
            holderPid,
          });
          expect(epochBytes(root)).toEqual(initialEpochBytes);
          expect(processIsAliveInTest(holderPid)).toBe(true);
          expect(holder.process.signalCode).toBeNull();

          // Release the mutation and contend again with the store free. This is the discriminating
          // half: had the beat been starved for the held window, the lease would now be TTL-stale
          // and this contender would reclaim it with an epoch bump.
          writeFileSync(permit, 'resume\n', 'utf8');
          const releasedPayload = await waitForParseableJson<{ heldForMs: number }>(
            released,
            holder,
          );
          expect(releasedPayload.heldForMs).toBeGreaterThan(LEASE_HEARTBEAT_TTL_MS);
          expect(readFileSync(join(root, MUTATION_RECORD_FILE), 'utf8')).toBe('mutated\n');

          const afterRelease = await spawnContender(root);
          expect(afterRelease).toMatchObject({
            kind: 'held',
            holderLeaseId: initial.leaseId,
            holderEpoch: initial.epoch,
          });
          expect(epochBytes(root)).toEqual(initialEpochBytes);

          writeFileSync(exitPermit, 'exit\n', 'utf8');
          const exited = await holder.exit;
          expect(exited, exited.output).toMatchObject({ code: 0, signal: null });
          expect(JSON.parse(readFileSync(report, 'utf8'))).toMatchObject({
            leaseId: initial.leaseId,
            epoch: initial.epoch,
            unexpected: [],
          });
        } finally {
          await stopFixture(holder);
        }
      },
      LEASE_HEARTBEAT_TTL_MS + 150_000,
    );

    /**
     * The gate's third arm, and the one 386-42 deliberately changed (W-02 re-scope).
     *
     * `MUTATION_LOCK_TAKEOVER_MS` now governs reclaim from dead and whole-process-stopped owners
     * only. A live holder whose worker thread is still beating is not auto-reclaimed at any
     * takeover bound, including zero — the contender reports the holder instead. This is asserted
     * as OS facts: no signal reached the holder, its lease id on disk is unchanged, and `.epoch`
     * is byte-identical, so nothing about a takeover ceremony happened.
     *
     * The refusal is over-determined by design: `acquireWriterLease`'s pre-check answers `held`
     * for a lease that is fresh at entry, and `leasePermitsEscalation` vetoes the `fresh` verdict
     * behind it. Only the first of the two is reachable from a deterministic schedule (see
     * 386-43-SUMMARY.md); the accepting control below is what keeps this leg from being satisfied
     * by a contender that simply never reclaims anything.
     */
    describePosix('the escalation gate is pinned by its complete three-way set', () => {
      it(
        'escalates against a whole-process-stopped holder past the TTL and bumps the epoch',
        async () => {
          const root = mkdtempSync(join(tmpdir(), 'agent-qa-independence-stopped-'));
          roots.push(root);
          const marker = join(root, 'mutation-open.json');
          const holder = startFixture('beating-holder', {
            root,
            marker,
            released: join(root, 'mutation-released.json'),
            permit: join(root, 'release.permit'),
            exitPermit: join(root, 'exit.permit'),
            report: join(root, 'holder-report.json'),
          });
          let wasStopped = false;

          try {
            const opened = await waitForParseableJson<{ pid: number }>(marker, holder);
            const holderPid = opened.pid;
            const initial = leaseOnDisk(root);

            // Whole-process SIGSTOP: the worker thread stops with everything else, so no beat can
            // land, while the process keeps both the mutation-lock row and the store transaction.
            expect(holder.process.kill('SIGSTOP')).toBe(true);
            wasStopped = true;
            await delay(LEASE_HEARTBEAT_TTL_MS + RECLAIM_MARGIN_MS);
            expect(leaseOnDisk(root).heartbeatAtMs).toBe(initial.heartbeatAtMs);

            const contender = await spawnContender(root, {
              takeoverMs: 0,
              deadlineMs: 30_000,
            });

            expect(contender).toMatchObject({
              kind: 'acquired',
              epoch: initial.epoch + 1,
              reclaimedLeaseId: initial.leaseId,
              reclaimedEpoch: initial.epoch,
            });
            const exited = await holder.exit;
            expect(exited, exited.output).toMatchObject({ code: null, signal: 'SIGKILL' });
            expect(processIsAliveInTest(holderPid)).toBe(false);
            expect(epochBytes(root).toString('utf8')).toBe(`${initial.epoch + 1}\n`);
            expect(leaseOnDisk(root).leaseId).not.toBe(initial.leaseId);
          } finally {
            await stopFixture(holder, wasStopped);
          }
        },
        LEASE_HEARTBEAT_TTL_MS + 150_000,
      );
    });

    /**
     * The accepting control for the reclaim direction: the gate change did not overshoot into
     * never-reclaim.
     *
     * A dead owner is reclaimed with no ceremony at all — no signal is delivered, because there is
     * nothing left to signal — and the epoch moves by exactly one. The child's exit facts are the
     * anchor: the row names a pid whose process is provably gone.
     */
    it('reclaims a dead owner without ceremony and bumps the epoch by exactly one', async () => {
      const root = mkdtempSync(join(tmpdir(), 'agent-qa-independence-dead-'));
      roots.push(root);
      const deadExit = await new Promise<{ pid: number; code: number | null; signal: string | null }>(
        (resolve, reject) => {
          const child = spawn(process.execPath, ['--eval', 'process.exit(0)'], {
            stdio: ['ignore', 'ignore', 'ignore'],
          });
          const pid = child.pid;
          if (pid === undefined) {
            reject(new Error('dead-owner fixture never started'));
            return;
          }
          child.once('error', reject);
          child.once('exit', (code, signal) => resolve({ pid, code, signal }));
        },
      );
      expect(deadExit).toMatchObject({ code: 0, signal: null });
      if (processIsAliveInTest(deadExit.pid)) {
        throw new Error('the dead-owner pid was reused before the leg could run');
      }

      const acquired = LOCAL_DAEMON_CAPABILITIES.acquireWriterLease(root);
      if (acquired.kind !== 'acquired') {
        throw new Error(`Expected an acquired lease, received ${acquired.kind}`);
      }
      const published = leaseOnDisk(root);
      writeFileSync(
        join(root, LEASE_FILE),
        `${JSON.stringify({
          ...published,
          pid: deadExit.pid,
          heartbeatAtMs: Date.now() - LEASE_HEARTBEAT_TTL_MS - 5_000,
        })}\n`,
        'utf8',
      );
      const authority = new DatabaseSync(join(root, WRITER_AUTHORITY_DB_FILE));
      try {
        authority.prepare(`
          INSERT OR REPLACE INTO mutation_lock
            (id, generation_token, pid, acquired_at_ms, incarnation)
          VALUES (1, ?, ?, ?, ?)
        `).run(
          'dead-owner-generation',
          deadExit.pid,
          Date.now(),
          'incarnation-of-a-process-that-already-exited',
        );
      } finally {
        authority.close();
      }

      const outcome = LOCAL_DAEMON_CAPABILITIES.acquireWriterLease(root, {
        mutationLockTakeoverMs: 0,
      });

      expect(outcome).toMatchObject({
        kind: 'acquired',
        epoch: acquired.epoch + 1,
        reclaimed: expect.objectContaining({
          leaseId: acquired.leaseId,
          pid: deadExit.pid,
        }),
      });
      expect(epochBytes(root).toString('utf8')).toBe(`${acquired.epoch + 1}\n`);
      expect(readWriterLease(root)).toMatchObject({
        kind: 'parsed',
        lease: expect.objectContaining({ pid: process.pid, epoch: acquired.epoch + 1 }),
      });
    }, 30_000);
  });
}
