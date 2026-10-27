import { DISTILLED_OBSERVATION_SCHEMA_VERSION } from '@vostride/agent-qa-schema'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { enqueueCurationCandidateProjection } from '@vostride/agent-qa-knowledge-local'
import { Command, CommanderError } from 'commander'
import { vi } from 'vitest'

import { createKnowledgeCommand } from '../../commands/knowledge.js'

export interface DrainInvocation {
  stdout: string
  stderr: string
  exitCode: typeof process.exitCode
  elapsedMs: number
}

/**
 * Write the same workspace config the one-shot CLI resolves in a real project.
 *
 * The daemon child and the drain command must agree on both roots without being told: the child
 * is given the directories directly, the command derives them from this file, and a leg is only
 * a handoff proof when both arrive at the same knowledge root by their own route.
 */
export function writeWorkspaceConfig(root: string, knowledgeDir = 'agent-qa-knowledge'): string {
  const configPath = join(root, 'agent-qa.config.yaml')
  writeFileSync(
    configPath,
    `${JSON.stringify({
      workspace: {
        testMatch: ['tests/**/*.yaml'],
        suiteMatch: ['suites/**/*.suite.yaml'],
        hooksFile: 'hooks.yaml',
        envFile: '.env',
        secretsFile: '.env.secrets.local',
      },
      knowledge: { dir: knowledgeDir },
      use: { mobile: { appState: 'preserve' } },
    }, null, 2)}\n`,
    'utf8',
  )
  writeFileSync(join(root, '.env.secrets.local'), '', 'utf8')
  return configPath
}

/** Enqueue one candidate the deterministic fallback author can carry all the way to committed. */
export function enqueueRealCandidate(knowledgeRoot: string, seed: string): string {
  mkdirSync(knowledgeRoot, { recursive: true })
  const outcome = enqueueCurationCandidateProjection({
    knowledgeRoot,
    projection: {
      sourceRunId: `run-${seed}`,
      scope: { tier: 'product', key: 'storefront' },
      buildOrdinal: 42,
      executionContext: 'local-headless',      kind: 'fact',
      subtype: 'selector',
      anchors: [
        { t: 'el', role: 'button', name: seed, ordinal: 0 },
        { t: 'page', route: `/${seed}` },
        { t: 'selector', literal: `[data-testid="${seed}"]` },
      ],
      summarySeed: `${seed} selector`,
      bodySeed: `${seed} was resolved and verified.`,
      distilledObservations: [{
        schemaVersion: DISTILLED_OBSERVATION_SCHEMA_VERSION,
        step: { naturalKey: `${seed}-click`, ordinal: 0 },
        platform: 'web',
        element: { naturalKey: `button:${seed}:0` },
        locator: { selector: `[data-testid="${seed}"]` },
        observedAtOrdinal: 42,
      }],
      evidenceToken: `evidence-${seed}`,
      attributingObservationId: `observation-${seed}`,
      artifactDescriptors: [],
      emittedAt: '2026-07-30T00:00:00.000Z',
    },
    artifactSources: [],
  })
  if (outcome.kind !== 'enqueued') {
    throw new Error(`expected an enqueued curation candidate, got ${outcome.kind}`)
  }
  return outcome.candidateId
}

/**
 * Run `agent-qa knowledge drain` exactly as the shipped binary composes it.
 *
 * Nothing about routing is stubbed here — the command resolves its own paths, classifies the
 * registration it finds on disk, and picks its own mode. That is the whole subject of these legs.
 */
export async function invokeDrain(
  configPath: string,
  args: readonly string[] = [],
): Promise<DrainInvocation> {
  const stdout: string[] = []
  const stderr: string[] = []
  const stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    stdout.push(String(chunk))
    return true
  })
  const stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    stderr.push(String(chunk))
    return true
  })
  const consoleLog = vi.spyOn(console, 'log').mockImplementation((...values: unknown[]) => {
    stdout.push(`${values.map(String).join(' ')}\n`)
  })
  const originalExitCode = process.exitCode
  process.exitCode = undefined
  const startedAtMs = Date.now()

  try {
    const knowledge = createKnowledgeCommand()
    const program = new Command()
      .option('--config <path>', 'config file path')
      .addCommand(knowledge)
    for (const command of [program, knowledge, ...knowledge.commands]) command.exitOverride()
    try {
      await program.parseAsync([
        'node',
        'agent-qa',
        '--config',
        configPath,
        'knowledge',
        'drain',
        ...args,
      ])
    } catch (error) {
      if (!(error instanceof CommanderError)) throw error
    }
    return {
      stdout: stdout.join(''),
      stderr: stderr.join(''),
      exitCode: process.exitCode,
      elapsedMs: Date.now() - startedAtMs,
    }
  } finally {
    process.exitCode = originalExitCode
    stdoutWrite.mockRestore()
    stderrWrite.mockRestore()
    consoleLog.mockRestore()
  }
}
