import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  inferAgentQaDevDependencyUpdateCommand,
  printAgentQaUpdateNoticeIfNeeded,
  shouldPrintAgentQaUpdateNotice,
  type AgentQaUpdateNoticeContext,
} from '../version-notice.js'

const { mockGetAgentQaUpdateStatus } = vi.hoisted(() => ({
  mockGetAgentQaUpdateStatus: vi.fn(),
}))

vi.mock('@vostride/agent-qa-core', () => ({
  getAgentQaUpdateStatus: mockGetAgentQaUpdateStatus,
}))

const createdDirs: string[] = []

const baseContext: AgentQaUpdateNoticeContext = {
  reporterSelection: { console: true, stdoutLive: false },
  effectiveLogLevel: 'info',
}

beforeEach(() => {
  mockGetAgentQaUpdateStatus.mockReset()
  mockGetAgentQaUpdateStatus.mockResolvedValue({
    installedVersion: '0.1.18',
    latestVersion: '0.1.19',
    updateAvailable: true,
  })
})

afterEach(() => {
  for (const dir of createdDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function makeTempProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agent-qa-version-notice-'))
  createdDirs.push(dir)
  return dir
}

function writePackageJson(dir: string, value: unknown): void {
  const content = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  writeFileSync(join(dir, 'package.json'), content, 'utf-8')
}

function writeLockfile(dir: string, name: string): void {
  writeFileSync(join(dir, name), '', 'utf-8')
}

function makeDevDependencyProject(options: {
  packageManager?: string
  lockfiles?: string[]
} = {}): string {
  const dir = makeTempProject()
  writePackageJson(dir, {
    ...(options.packageManager ? { packageManager: options.packageManager } : {}),
    devDependencies: { 'agent-qa': '0.1.18' },
  })
  for (const lockfile of options.lockfiles ?? []) {
    writeLockfile(dir, lockfile)
  }
  return dir
}

function collectNotice(context: Partial<AgentQaUpdateNoticeContext> = {}) {
  const lines: string[] = []
  return {
    lines,
    context: {
      ...baseContext,
      ...context,
      reporterSelection: {
        ...baseContext.reporterSelection,
        ...context.reporterSelection,
      },
      log: (line?: string) => {
        lines.push(line ?? '')
      },
    } satisfies AgentQaUpdateNoticeContext,
  }
}

function joined(lines: string[]): string {
  return lines.join('\n')
}

describe('shouldPrintAgentQaUpdateNotice', () => {
  it('returns true for human-readable console output', () => {
    expect(shouldPrintAgentQaUpdateNotice(baseContext)).toBe(true)
  })

  it.each([
    ['silent log level', { effectiveLogLevel: 'silent' }],
    ['live events enabled', { liveEvents: 'true' }],
    ['console reporter disabled', { reporterSelection: { console: false } }],
    ['stdout-live reporter enabled', { reporterSelection: { stdoutLive: true } }],
  ])('returns false for %s', (_name, override) => {
    const overrideContext = override as Partial<AgentQaUpdateNoticeContext>
    const context = {
      ...baseContext,
      ...overrideContext,
      reporterSelection: {
        ...baseContext.reporterSelection,
        ...(overrideContext.reporterSelection ?? {}),
      },
    } satisfies AgentQaUpdateNoticeContext

    expect(shouldPrintAgentQaUpdateNotice(context)).toBe(false)
  })
})

describe('inferAgentQaDevDependencyUpdateCommand', () => {
  it('infers pnpm from packageManager or a sole pnpm lockfile', () => {
    expect(
      inferAgentQaDevDependencyUpdateCommand(
        makeDevDependencyProject({ packageManager: 'pnpm@10.6.1' }),
      ),
    ).toBe('pnpm add -D agent-qa@latest')

    expect(
      inferAgentQaDevDependencyUpdateCommand(
        makeDevDependencyProject({ lockfiles: ['pnpm-lock.yaml'] }),
      ),
    ).toBe('pnpm add -D agent-qa@latest')
  })

  it.each([
    ['npm@10.9.0', 'npm install --save-dev agent-qa@latest'],
    ['yarn@4.10.3', 'yarn add --dev agent-qa@latest'],
    ['bun@1.3.4', 'bun add --dev agent-qa@latest'],
  ])('infers %s from packageManager', (packageManager, command) => {
    expect(
      inferAgentQaDevDependencyUpdateCommand(makeDevDependencyProject({ packageManager })),
    ).toBe(command)
  })

  it.each([
    ['package-lock.json', 'npm install --save-dev agent-qa@latest'],
    ['npm-shrinkwrap.json', 'npm install --save-dev agent-qa@latest'],
    ['yarn.lock', 'yarn add --dev agent-qa@latest'],
    ['bun.lock', 'bun add --dev agent-qa@latest'],
    ['bun.lockb', 'bun add --dev agent-qa@latest'],
  ])('infers %s as the only lockfile', (lockfile, command) => {
    expect(
      inferAgentQaDevDependencyUpdateCommand(makeDevDependencyProject({ lockfiles: [lockfile] })),
    ).toBe(command)
  })

  it('returns undefined for uncertain or unsafe package layouts', () => {
    const dependenciesOnly = makeTempProject()
    writePackageJson(dependenciesOnly, { dependencies: { 'agent-qa': '0.1.18' }, packageManager: 'pnpm@10.6.1' })

    const noPackageJson = makeTempProject()
    const malformedPackageJson = makeTempProject()
    writePackageJson(malformedPackageJson, '{ not json')

    const noPackageManagerOrLock = makeTempProject()
    writePackageJson(noPackageManagerOrLock, { devDependencies: { 'agent-qa': '0.1.18' } })

    const unknownPackageManager = makeDevDependencyProject({ packageManager: 'deno@2.2.0' })
    const multipleLockfiles = makeDevDependencyProject({
      lockfiles: ['pnpm-lock.yaml', 'package-lock.json'],
    })

    for (const dir of [
      dependenciesOnly,
      noPackageJson,
      malformedPackageJson,
      noPackageManagerOrLock,
      unknownPackageManager,
      multipleLockfiles,
    ]) {
      expect(existsSync(dir)).toBe(true)
      expect(inferAgentQaDevDependencyUpdateCommand(dir)).toBeUndefined()
    }
  })
})

describe('printAgentQaUpdateNoticeIfNeeded', () => {
  it('prints current/latest versions, releases link, and inferred dev-dependency command', async () => {
    const cwd = makeDevDependencyProject({ packageManager: 'pnpm@10.6.1' })
    const { context, lines } = collectNotice({ cwd })

    await printAgentQaUpdateNoticeIfNeeded(context)

    expect(mockGetAgentQaUpdateStatus).toHaveBeenCalledTimes(1)
    expect(lines[0]).toBe('')
    const output = joined(lines)
    expect(output).toContain('Update available: agent-qa v0.1.19')
    expect(output).toContain('Current version: v0.1.18')
    expect(output).toContain('Releases: https://github.com/vostride/agent-qa/releases')
    expect(output).toContain('Update: pnpm add -D agent-qa@latest')
  })

  it.each([
    ['missing package.json', () => makeTempProject()],
    ['malformed package.json', () => {
      const dir = makeTempProject()
      writePackageJson(dir, '{ bad json')
      return dir
    }],
    ['no dev dependency', () => {
      const dir = makeTempProject()
      writePackageJson(dir, { packageManager: 'pnpm@10.6.1' })
      return dir
    }],
    ['dependencies only', () => {
      const dir = makeTempProject()
      writePackageJson(dir, { packageManager: 'pnpm@10.6.1', dependencies: { 'agent-qa': '0.1.18' } })
      return dir
    }],
    ['unknown package manager', () => makeDevDependencyProject({ packageManager: 'deno@2.2.0' })],
    ['multiple lockfiles', () => makeDevDependencyProject({ lockfiles: ['pnpm-lock.yaml', 'yarn.lock'] })],
  ])('prints releases-only notice when command inference is uncertain for %s', async (_name, setup) => {
    const { context, lines } = collectNotice({ cwd: setup() })

    await printAgentQaUpdateNoticeIfNeeded(context)

    const output = joined(lines)
    expect(output).toContain('Update available: agent-qa v0.1.19')
    expect(output).toContain('Current version: v0.1.18')
    expect(output).toContain('Releases: https://github.com/vostride/agent-qa/releases')
    expect(output).not.toContain('Update:')
  })

  it.each([
    ['no update', async () => {
      mockGetAgentQaUpdateStatus.mockResolvedValueOnce({
        installedVersion: '0.1.18',
        latestVersion: '0.1.18',
        updateAvailable: false,
      })
      return baseContext
    }],
    ['missing latest version', async () => {
      mockGetAgentQaUpdateStatus.mockResolvedValueOnce({
        installedVersion: '0.1.18',
        updateAvailable: true,
      })
      return baseContext
    }],
    ['output gate false', async () => ({
      ...baseContext,
      reporterSelection: { console: true, stdoutLive: true },
    })],
    ['update helper rejects', async () => {
      mockGetAgentQaUpdateStatus.mockRejectedValueOnce(new Error('registry unavailable'))
      return baseContext
    }],
  ])('does not log a notice when %s', async (_name, setup) => {
    const { context, lines } = collectNotice(await setup())

    await printAgentQaUpdateNoticeIfNeeded(context)

    expect(lines).toEqual([])
  })

  it('does not log forbidden install, package, branding, or local-data copy', async () => {
    const cwd = makeDevDependencyProject({ packageManager: 'pnpm@10.6.1' })
    const { context, lines } = collectNotice({ cwd })

    await printAgentQaUpdateNoticeIfNeeded(context)

    const output = joined(lines)
    const forbidden = [
      'npmjs.com',
      'npm install -g',
      'pnpm add -g',
      'yarn global',
      'bun install -g',
      'AgentQA',
      'local config',
      'logs',
      'test content',
      'memory',
      'credentials',
      'workspace path',
    ]
    for (const term of forbidden) {
      expect(output).not.toContain(term)
    }
  })
})
