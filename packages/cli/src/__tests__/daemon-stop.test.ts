// `daemon stop` reads `.agent-qa/`, never the config.

import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Command } from 'commander'
import { afterEach, describe, expect, it, vi } from 'vitest'

import * as daemonCommand from '../commands/daemon.js'
import type { DaemonCommandDeps } from '../commands/daemon.js'
import {
  DAEMON_REGISTRATION_SCHEMA_VERSION,
  readDaemonRegistration,
  writeDaemonRegistration,
} from '../daemon/registration.js'
import type { DaemonRegistration } from '../daemon/registration.js'
import { DAEMON_IDENTITY_SCHEMA_VERSION } from '../daemon/server.js'

const roots: string[] = []

function v1Config(): string {
  return [
    'workspace:',
    '  testMatch:',
    '    - tests/**/*.yaml',
    '  agentRules: ./agent-rules.md',
    '  envFile: .env',
    'services:',
    '  memory:',
    '    enabled: true',
    '    provider: local',
    '    dir: agent-qa-memory',
    'registry:',
    '  llms:',
    '    - name: claude-subscription',
    '      provider: anthropic-subscription',
    '      model: claude-sonnet-4-6',
    'use:',
    '  llm: claude-subscription',
    '',
  ].join('\n')
}

async function stop(
  configPath: string,
  deps: DaemonCommandDeps,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const stdout: string[] = []
  const stderr: string[] = []
  const log = vi.spyOn(console, 'log').mockImplementation((...values: unknown[]) => {
    stdout.push(values.join(' '))
  })
  const error = vi.spyOn(console, 'error').mockImplementation((...values: unknown[]) => {
    stderr.push(values.join(' '))
  })
  const previousExitCode = process.exitCode
  process.exitCode = undefined
  try {
    const program = new Command().name('agent-qa').option('--config <path>').exitOverride()
    const daemon = daemonCommand.createDaemonCommand(deps)
    daemon.exitOverride()
    program.addCommand(daemon)
    await program.parseAsync(['node', 'agent-qa', '--config', configPath, 'daemon', 'stop'])
    return { stdout: stdout.join('\n'), stderr: stderr.join('\n'), exitCode: process.exitCode ?? 0 }
  } finally {
    process.exitCode = previousExitCode
    log.mockRestore()
    error.mockRestore()
  }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('daemon stop in a v1 workspace', () => {
  it('a live daemon registered in a v1 workspace is sent SIGTERM without the config being validated', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-qa-daemon-stop-'))
    roots.push(root)
    const configPath = join(root, 'agent-qa.config.yaml')
    writeFileSync(configPath, v1Config(), 'utf8')
    const agentQaRoot = join(root, '.agent-qa')
    const registration: DaemonRegistration = {
      schemaVersion: DAEMON_REGISTRATION_SCHEMA_VERSION,
      instanceId: randomUUID(),
      pid: 424242,
      socketPath: join(agentQaRoot, 'daemon.sock'),
      startedAtMs: 1_700_000_000_000,
    }
    writeDaemonRegistration(agentQaRoot, registration)
    const exported: Record<string, unknown> = daemonCommand
    const unused = (name: string) => () => {
      throw new Error(`daemon stop must not reach ${name}`)
    }
    const signalProcess = vi.fn()
    const deps = {
      runHost: unused('runHost'),
      resolvePaths: () => {
        throw new Error('stop must not resolve the validated paths')
      },
      resolveAgentQaRoot: exported.resolveDaemonAgentQaRoot,
      readRegistration: readDaemonRegistration,
      processIsAlive: () => true,
      readIdentity: (registered: DaemonRegistration) =>
        Promise.resolve({
          schemaVersion: DAEMON_IDENTITY_SCHEMA_VERSION,
          instanceId: registered.instanceId,
          pid: registered.pid,
        }),
      readWriterLease: unused('readWriterLease'),
      countPendingCurationJobs: unused('countPendingCurationJobs'),
      signalProcess,
      now: unused('now'),
    } as unknown as DaemonCommandDeps

    const stopped = await stop(configPath, deps)

    const text = `${stopped.stdout}\n${stopped.stderr}`
    expect(signalProcess, text).toHaveBeenCalledTimes(1)
    expect(signalProcess, text).toHaveBeenCalledWith(424242, 'SIGTERM')
    expect(stopped.stdout, text).toContain('sent SIGTERM to agent-qa daemon pid 424242')
    expect(text).not.toContain('Config validation failed')
    expect(stopped.exitCode, text).toBe(0)
  })
})
