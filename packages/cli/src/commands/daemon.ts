// `agent-qa daemon` is the standing host for the CURATION QUEUE and AGENT JOB QUEUE. It never
// serves the RUN QUEUE — v1 test executions remain owned by the dashboard server. D-21's three
// names stay explicit here so a user cannot mistake one queue's leaseholder for another's worker.

import { dirname, resolve } from 'node:path'

import {
  LOCAL_DAEMON_CAPABILITIES,
} from '@vostride/agent-qa-agent-local'
import type {
  CuratorAuthor,
  ReadWriterLeaseOutcome,
  WriterLease,
} from '@vostride/agent-qa-agent-local'
import { Command } from 'commander'
import pc from 'picocolors'

import { composeAnalyticsHost } from '../composition/analytics-host.js'
import { createDeclaredSecretMask } from '../composition/declared-secrets.js'
import { createConfigReader } from '../composition/local-agent-host.js'
import { resolveConfig, resolveConfiguredKnowledgeRoot } from '../config.js'
import { buildCuratorAuthor } from '../curation/curator-author.js'
import { runDaemonHost } from '../daemon/host.js'
import type { DaemonHostOptions } from '../daemon/host.js'
import { fetchDaemonIdentity } from '../daemon/server.js'
import type { DaemonIdentity } from '../daemon/server.js'
import {
  processIsAlive,
  readDaemonRegistration,
} from '../daemon/registration.js'
import type {
  DaemonRegistration,
  ReadDaemonRegistrationOutcome,
} from '../daemon/registration.js'
import {
  resolveCliAnalysisTokenBudget,
  resolveCliJobModel,
  resolveModelAuth,
  resolveNamedConfig,
  toModelProfileAndAuth,
} from '../llm-utils.js'

export interface DaemonProjectPaths {
  agentQaRoot: string
  knowledgeRoot: string
}

export interface DaemonCommandDeps {
  runHost(options: DaemonHostOptions): Promise<number>
  resolvePaths(configPath: string): Promise<DaemonProjectPaths>
  resolveAgentQaRoot(configPath: string): string
  readRegistration(agentQaRoot: string): ReadDaemonRegistrationOutcome
  processIsAlive(pid: number): boolean
  readIdentity(registration: DaemonRegistration): Promise<DaemonIdentity>
  readWriterLease(knowledgeRoot: string): ReadWriterLeaseOutcome
  countPendingCurationJobs(knowledgeRoot: string): number
  signalProcess(pid: number, signal: NodeJS.Signals): void
  now(): number
}

export type DaemonStatusDto =
  | { state: 'stopped' }
  | { state: 'malformed' }
  | { state: 'stale'; pid: number; startedAtMs: number }
  | {
      state: 'running'
      pid: number
      startedAtMs: number
      uptimeMs: number
      curationQueueDepth: number
      lease: WriterLease | null
    }

export function resolveDaemonAgentQaRoot(configPath: string): string {
  return resolve(dirname(configPath), '.agent-qa')
}

async function resolveDaemonPaths(configPath: string): Promise<DaemonProjectPaths> {
  const config = await resolveConfig({ configPath, loadAuthPlugins: false })
  return {
    agentQaRoot: resolveDaemonAgentQaRoot(configPath),
    knowledgeRoot: resolveConfiguredKnowledgeRoot(config, dirname(configPath)),
  }
}

const DEFAULT_DEPS: DaemonCommandDeps = {
  runHost: runDaemonHost,
  resolvePaths: resolveDaemonPaths,
  resolveAgentQaRoot: resolveDaemonAgentQaRoot,
  readRegistration: readDaemonRegistration,
  processIsAlive,
  readIdentity: (registration) => fetchDaemonIdentity(registration.socketPath),
  readWriterLease: LOCAL_DAEMON_CAPABILITIES.readWriterLease,
  countPendingCurationJobs: LOCAL_DAEMON_CAPABILITIES.countPendingCurationJobs,
  signalProcess: (pid, signal) => process.kill(pid, signal),
  now: () => Date.now(),
}

async function resolveDaemonCuratorAuthor(configPath: string): Promise<CuratorAuthor> {
  const { config } = await resolveNamedConfig(undefined, configPath)
  const resolved = await resolveModelAuth(config.name, config)
  return buildCuratorAuthor({
    ...toModelProfileAndAuth(config, resolved),
    mask: createDeclaredSecretMask(configPath).mask,
  })
}

function configPathFor(command: Command): string {
  let root = command
  while (root.parent !== null) root = root.parent
  const globalOpts = root.opts<{ config?: string }>()
  return resolve(globalOpts.config ?? 'agent-qa.config.yaml')
}

async function inspectRegistration(
  deps: DaemonCommandDeps,
  agentQaRoot: string,
): Promise<
  | { kind: 'absent' }
  | { kind: 'malformed' }
  | { kind: 'live'; registration: DaemonRegistration }
  | { kind: 'stale'; registration: DaemonRegistration }
> {
  const outcome = deps.readRegistration(agentQaRoot)
  if (outcome.kind !== 'parsed') return outcome
  if (!deps.processIsAlive(outcome.registration.pid)) {
    return { kind: 'stale', registration: outcome.registration }
  }
  try {
    const identity = await deps.readIdentity(outcome.registration)
    return identity.instanceId === outcome.registration.instanceId
      && identity.pid === outcome.registration.pid
      ? { kind: 'live', registration: outcome.registration }
      : { kind: 'stale', registration: outcome.registration }
  } catch {
    return { kind: 'stale', registration: outcome.registration }
  }
}

function formatUptime(uptimeMs: number): string {
  const seconds = Math.floor(uptimeMs / 1_000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  return `${Math.floor(minutes / 60)}h`
}

function renderStatusHuman(status: DaemonStatusDto): void {
  if (status.state === 'stopped') {
    console.log('agent-qa daemon is not running')
    return
  }
  if (status.state === 'malformed') {
    console.error(pc.red('agent-qa daemon registration is malformed'))
    return
  }
  if (status.state === 'stale') {
    console.log(`agent-qa daemon has a stale registration (pid ${status.pid})`)
    return
  }
  console.log(
    `agent-qa daemon running: pid ${status.pid}, uptime ${formatUptime(status.uptimeMs)}, ` +
      `curation queue depth ${status.curationQueueDepth}`,
  )
}

export function createDaemonCommand(deps: DaemonCommandDeps = DEFAULT_DEPS): Command {
  const cmd = new Command('daemon')
    .description('Run and inspect the foreground daemon host')
    .addHelpText(
      'after',
      '\nagent-qa runs three separate queues; this command hosts the latter two only:\n' +
        '  run queue        test executions dispatched by the dashboard server (never served here)\n' +
        '  curation queue   knowledge curation work drained under this daemon writer lease\n' +
        '  agent job queue  durable background agent jobs served from .agent-qa/agent-jobs.db\n' +
        '\nSee https://vostride.com/docs/agent-qa/daemon.\n',
    )
    .action(async (_opts: unknown, command: Command) => {
      try {
        const configPath = configPathFor(command)
        const configDir = dirname(configPath)
        const config = await resolveConfig({ configPath, loadAuthPlugins: false })
        const declaredSecrets = createDeclaredSecretMask(configPath)
        // 398-10 (D-17/D-19): THIS COMMAND'S ANALYTICS COMPOSITION ROOT. The daemon is a standing
        // process, so it composes eagerly — unlike `run`, there is no early-returning path here for
        // a lazy composition to protect, and the host it is handed to emits from the moment it
        // starts dispatching work.
        const analytics = await composeAnalyticsHost({
          surface: 'daemon',
          config,
          maskingContext: { mask: declaredSecrets.mask },
        })
        const exitCode = await deps.runHost({
          analytics,
          agentQaRoot: resolve(configDir, '.agent-qa'),
          knowledgeRoot: resolveConfiguredKnowledgeRoot(config, configDir),
          configPath,
          config: createConfigReader(configPath, declaredSecrets.mask),
          // 388 CR-02 — the daemon egress posture, resolved EXPLICITLY (389-06, verified
          // parity): this binding rides the SAME resolveCliJobModel → buildJobModelCapability
          // → createModel chain as the CLI tail's, and the masking seam is createModel's own
          // pinned-LAST middleware — structurally identical on both hosts, proven by the
          // llm-utils masking-egress pin. What differs is curation: the daemon's fold is handed
          // no declared mask (the fact its candidateProse: 'no-masker' declaration records).
          // The author's evidence egress is protected by two layers that need no scope:
          // (1) masked-at-record — handoff evidence is masked before it is ever written, so
          // the bytes the author quotes are already redacted; (2) the middleware's residual
          // guardrail-shape redaction, which fires at the provider boundary with no active
          // context. CR-02's original finding was the CURATION candidate-prose layer, closed
          // by 388-10 option (a); this comment pins the ANALYZE-RUN leg's posture beside it.
          model: () => resolveCliJobModel(configPath),
          // 389-06: the author's compaction budget from the SAME named-config profile
          // resolution as the model binding above (386 D-15) — no second config surface.
          analysisTokenBudget: () => resolveCliAnalysisTokenBudget(configPath),
          author: () => resolveDaemonCuratorAuthor(configPath),
        })
        // The daemon runs until a signal closes it, so this is the one drain point: everything it
        // captured while dispatching is flushed here, and the transport's timers are released so
        // the process can actually exit.
        await analytics.shutdown()
        process.exitCode = exitCode
      } catch (error) {
        console.error(pc.red(`Daemon error: ${error instanceof Error ? error.message : String(error)}`))
        process.exitCode = 1
      }
    })

  cmd
    .command('status')
    .description('Report daemon liveness and pending work depth')
    .option('--json', 'output the raw status object')
    .action(async (opts: { json?: boolean }, command: Command) => {
      try {
        const paths = await deps.resolvePaths(configPathFor(command))
        const inspected = await inspectRegistration(deps, paths.agentQaRoot)
        let status: DaemonStatusDto
        if (inspected.kind === 'absent') {
          status = { state: 'stopped' }
        } else if (inspected.kind === 'malformed') {
          status = { state: 'malformed' }
          process.exitCode = 1
        } else if (inspected.kind === 'stale') {
          status = {
            state: 'stale',
            pid: inspected.registration.pid,
            startedAtMs: inspected.registration.startedAtMs,
          }
        } else {
          const lease = deps.readWriterLease(paths.knowledgeRoot)
          status = {
            state: 'running',
            pid: inspected.registration.pid,
            startedAtMs: inspected.registration.startedAtMs,
            uptimeMs: Math.max(0, deps.now() - inspected.registration.startedAtMs),
            curationQueueDepth: deps.countPendingCurationJobs(paths.knowledgeRoot),
            lease: lease.kind === 'parsed' ? lease.lease : null,
          }
        }

        if (opts.json) console.log(JSON.stringify(status))
        else renderStatusHuman(status)
      } catch (error) {
        console.error(
          pc.red(`Daemon status error: ${error instanceof Error ? error.message : String(error)}`),
        )
        process.exitCode = 1
      }
    })

  cmd
    .command('stop')
    .description('Gracefully stop the registered live daemon')
    .action(async (_opts: unknown, command: Command) => {
      try {
        // 2026-10-20 (445-17, D-42): stop reads only .agent-qa/, so a pre-v2 config cannot block it.
        const agentQaRoot = deps.resolveAgentQaRoot(configPathFor(command))
        const inspected = await inspectRegistration(deps, agentQaRoot)
        if (inspected.kind !== 'live') {
          console.log(
            inspected.kind === 'stale'
              ? `agent-qa daemon has a stale registration (pid ${inspected.registration.pid})`
              : 'agent-qa daemon has nothing to stop',
          )
          process.exitCode = 1
          return
        }
        deps.signalProcess(inspected.registration.pid, 'SIGTERM')
        console.log(`sent SIGTERM to agent-qa daemon pid ${inspected.registration.pid}`)
      } catch (error) {
        console.error(
          pc.red(`Daemon stop error: ${error instanceof Error ? error.message : String(error)}`),
        )
        process.exitCode = 1
      }
    })

  return cmd
}
